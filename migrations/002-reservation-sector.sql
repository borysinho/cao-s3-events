ALTER TABLE sectors ADD CONSTRAINT sectors_event_id_id_key UNIQUE (event_id, id);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_sector_event_fkey
    FOREIGN KEY (event_id, sector_id) REFERENCES sectors (event_id, id),
  DROP CONSTRAINT reservations_sector_id_fkey;
