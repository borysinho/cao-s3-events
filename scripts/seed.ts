import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { connect, transaction } from "../src/lib/db.ts";

import { editorialEvents } from "./demo-events.ts";

const demos = editorialEvents.map((event) => ({
  ...event,
  sectors: [
    { name: event.category === "Deportes" ? "Tribuna general" : "General", unitPriceMinor: event.prices[0], capacity: 250 },
    { name: "Preferencia", unitPriceMinor: event.prices[1], capacity: 80 },
  ],
}));

async function main() {
  try { process.loadEnvFile(new URL('../.env', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const organizerId = process.env.DEMO_ORGANIZER_ID ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizerId)) throw new Error('Define DEMO_ORGANIZER_ID con el id del organizador obtenido de auth.');
  const base = new URL(process.env.DEMO_IMAGES_BASE_URL ?? 'http://localhost:8080/eventos-demo/');
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('URL de imágenes inválida.');
  const events = demos.map(event => ({ ...event, imageUrl: new URL(event.image, base).href }));
  const pool = connect();
  try {
    const inserted = await transaction(pool, async (client) => {
      const names: string[] = [];
      for (const event of events) {
        const created = await client.query(
          `INSERT INTO events (id, organizer_id, name, date, venue, image_url, description, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'published') ON CONFLICT (id) DO NOTHING`,
          [event.id, organizerId, event.name, event.date, event.venue, event.imageUrl, event.description],
        );
        if (!created.rowCount) continue;
        for (const sector of event.sectors) {
          await client.query(
            "INSERT INTO sectors (event_id, name, unit_price_minor, capacity) VALUES ($1,$2,$3,$4)",
            [event.id, sector.name, sector.unitPriceMinor, sector.capacity],
          );
        }
        names.push(event.name);
      }
      return names;
    });
    console.log(inserted.length ? `Eventos ficticios publicados · ${inserted.join(", ")}` : "El seed ya está aplicado.");
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
