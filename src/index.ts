import type { Pool, PoolClient } from 'pg';
import type { Api } from './lib/api.ts';
import type { EventInput, SectorInput, Selection, Reservation } from './lib/contracts.ts';
import { ApiError, conflict, notFound } from './lib/api.ts';
import { transaction } from './lib/db.ts';
import { mountImages } from './images.ts';

const organizer = { role: 'organizador' } as const;
const orders = { token: 'EVENTS_ORDERS_TOKEN' };
const eventsByStatus = "SELECT * FROM events WHERE status = 'published'";
const sectorAvailability = `SELECT sectors.*,
  sectors.capacity - COALESCE((SELECT SUM(quantity) FROM reservations
    WHERE sector_id = sectors.id AND NOT released), 0) AS available
  FROM sectors`;

interface SectorRow {
  id: string;
  name: string;
  unit_price_minor: string;
  capacity: string;
  available: string | number;
}

interface EventRow {
  id: string;
  organizer_id: string;
  name: string;
  date: Date;
  venue: string;
  image_url: string;
  description: string;
  status: 'draft' | 'published' | 'cancelled';
}

interface ReservationRow {
  event_id: string;
  sector_id: string;
  quantity: number;
  snapshot: Reservation;
  released: boolean;
}

function sectorView(row: SectorRow) {
  return {
    id: row.id, name: row.name, unitPriceMinor: Number(row.unit_price_minor),
    capacity: Number(row.capacity), available: Number(row.available),
  };
}

async function eventView(db: Pool | PoolClient, event: EventRow) {
  const { rows } = await db.query<SectorRow>(sectorAvailability + ' WHERE event_id = $1 ORDER BY name, id', [event.id]);
  return {
    id: event.id, name: event.name, date: event.date.toISOString(), venue: event.venue,
    imageUrl: event.image_url, description: event.description, status: event.status,
    currency: 'BOB', sectors: rows.map(sectorView),
  };
}

async function lockedEvent(client: PoolClient, eventId: string, organizerId?: string) {
  const { rows: [event] } = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
  if (!event || (organizerId && event.organizer_id !== organizerId)) throw notFound();
  return event;
}

function editable(event: EventRow) {
  if (event.status === 'cancelled') throw conflict('EVENT_UNAVAILABLE', 'El evento está cancelado.');
}

function sectorAmounts(body: SectorInput) {
  if (!Number.isSafeInteger(body.capacity) || !Number.isSafeInteger(body.unitPriceMinor * 6)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'El cupo o el precio supera el límite representable.');
  }
}

export function mount(api: Api, { pool }: { pool: Pool }) {
  mountImages(api);
  api.route('listPublishedEvents', {}, async (_req, res) => {
    const { rows } = await pool.query(eventsByStatus + ' ORDER BY date, id');
    res.json({ items: await Promise.all(rows.map((row) => eventView(pool, row))) });
  });

  api.route('listOwnEvents', organizer, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM events WHERE organizer_id = $1 ORDER BY date, id', [req.actor.sub]);
    res.json({ items: await Promise.all(rows.map((row) => eventView(pool, row))) });
  });

  api.route('getPublishedEvent', {}, async (req, res) => {
    const { rows: [event] } = await pool.query(eventsByStatus + ' AND id = $1', [req.params.eventId]);
    if (!event) throw notFound();
    res.json(await eventView(pool, event));
  });

  api.route<EventInput>('createEvent', organizer, async (req, res) => {
    const { name, date, venue, imageUrl, description } = req.body;
    const { rows: [event] } = await pool.query(
      'INSERT INTO events (organizer_id, name, date, venue, image_url, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.actor.sub, name, date, venue, imageUrl, description],
    );
    res.status(201).json(await eventView(pool, event));
  });

  api.route<EventInput>('updateEvent', organizer, async (req, res) => {
    const value = await transaction(pool, async (client) => {
      editable(await lockedEvent(client, req.params.eventId, req.actor.sub));
      const { name, date, venue, imageUrl, description } = req.body;
      const { rows: [event] } = await client.query(
        'UPDATE events SET name=$2, date=$3, venue=$4, image_url=$5, description=$6 WHERE id=$1 RETURNING *',
        [req.params.eventId, name, date, venue, imageUrl, description],
      );
      return eventView(client, event);
    });
    res.json(value);
  });

  api.route<{ status: 'published' | 'cancelled' }>('updateEventStatus', organizer, async (req, res) => {
    const value = await transaction(pool, async (client) => {
      const event = await lockedEvent(client, req.params.eventId, req.actor.sub);
      const { status } = req.body;
      if (event.status === status) return eventView(client, event);
      editable(event);
      if (status === 'published') {
        const sectors = await client.query('SELECT 1 FROM sectors WHERE event_id = $1 LIMIT 1', [event.id]);
        if (!sectors.rowCount) throw conflict('SECTOR_REQUIRED', 'Agrega un sector antes de publicar.');
      }
      await client.query('UPDATE events SET status=$2 WHERE id=$1', [event.id, status]);
      return eventView(client, { ...event, status });
    });
    res.json(value);
  });

  api.route<SectorInput>('createSector', organizer, async (req, res) => {
    const value = await transaction(pool, async (client) => {
      const event = await lockedEvent(client, req.params.eventId, req.actor.sub);
      editable(event);
      sectorAmounts(req.body);
      const { name, unitPriceMinor, capacity } = req.body;
      const { rows: [row] } = await client.query(
        'INSERT INTO sectors (event_id, name, unit_price_minor, capacity) VALUES ($1,$2,$3,$4) RETURNING *',
        [event.id, name, unitPriceMinor, capacity],
      );
      return sectorView({ ...row, available: row.capacity });
    });
    res.status(201).json(value);
  });

  api.route<SectorInput>('updateSector', organizer, async (req, res) => {
    const value = await transaction(pool, async (client) => {
      const event = await lockedEvent(client, req.params.eventId, req.actor.sub);
      editable(event);
      sectorAmounts(req.body);
      const { rows: [current] } = await client.query(
        sectorAvailability + ' WHERE event_id=$1 AND id=$2', [event.id, req.params.sectorId],
      );
      if (!current) throw notFound();
      const reserved = Number(current.capacity) - Number(current.available);
      const { name, unitPriceMinor, capacity } = req.body;
      if (capacity < reserved) throw conflict('CAPACITY_RESERVED', 'El cupo es menor a las reservas activas.');
      const { rows: [row] } = await client.query(
        'UPDATE sectors SET name=$2, unit_price_minor=$3, capacity=$4 WHERE id=$1 RETURNING *',
        [current.id, name, unitPriceMinor, capacity],
      );
      return sectorView({ ...row, available: capacity - reserved });
    });
    res.json(value);
  });

  api.route<Selection>('reserveCapacity', orders, async (req, res) => {
    const snapshot = await transaction(pool, async (client) => {
      const orderId = req.params.orderId.toLowerCase();
      const eventId = req.body.eventId.toLowerCase();
      const sectorId = req.body.sectorId.toLowerCase();
      const { quantity } = req.body;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const { rows: [previous] } = await client.query<ReservationRow>('SELECT * FROM reservations WHERE order_id=$1', [orderId]);
      if (previous) {
        if (previous.released || previous.event_id !== eventId
            || previous.sector_id !== sectorId || previous.quantity !== quantity) {
          throw conflict('RESERVATION_CONFLICT', 'La reserva no coincide con la solicitud.');
        }
        return previous.snapshot;
      }
      const event = await lockedEvent(client, eventId);
      const { rows: [sector] } = await client.query(
        sectorAvailability + ' WHERE event_id=$1 AND id=$2', [eventId, sectorId],
      );
      if (!sector) throw notFound();
      if (event.status !== 'published') throw conflict('EVENT_UNAVAILABLE', 'El evento no admite reservas.');
      if (Number(sector.available) < quantity) throw conflict('SOLD_OUT', 'Agotado');
      const value: Reservation = {
        orderId, eventId, sectorId, quantity, organizerId: event.organizer_id, currency: 'BOB',
        eventName: event.name, eventDate: event.date.toISOString(), eventVenue: event.venue,
        sectorName: sector.name, unitPriceMinor: Number(sector.unit_price_minor),
      };
      await client.query(
        'INSERT INTO reservations (order_id, event_id, sector_id, quantity, snapshot) VALUES ($1,$2,$3,$4,$5)',
        [orderId, eventId, sectorId, quantity, value],
      );
      return value;
    });
    res.json(snapshot);
  });

  api.route('releaseCapacity', orders, async (req, res) => {
    await transaction(pool, async (client) => {
      const orderId = req.params.orderId.toLowerCase();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const { rows: [reservation] } = await client.query<Pick<ReservationRow, 'event_id' | 'released'>>(
        'SELECT event_id, released FROM reservations WHERE order_id=$1', [orderId],
      );
      if (reservation && !reservation.released) {
        await lockedEvent(client, reservation.event_id);
        await client.query('UPDATE reservations SET released=true WHERE order_id=$1', [orderId]);
      }
    });
    res.sendStatus(204);
  });
}
