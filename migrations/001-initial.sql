CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  name text NOT NULL,
  date timestamptz NOT NULL,
  venue text NOT NULL,
  image_url text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled'))
);

CREATE TABLE sectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) NOT NULL,
  name text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor > 0),
  capacity bigint NOT NULL CHECK (capacity > 0)
);

CREATE TABLE reservations (
  order_id uuid PRIMARY KEY,
  event_id uuid REFERENCES events(id) NOT NULL,
  sector_id uuid REFERENCES sectors(id) NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 6),
  snapshot jsonb NOT NULL,
  released boolean NOT NULL DEFAULT false
);

CREATE INDEX reservations_active_sector ON reservations (sector_id) WHERE NOT released;
