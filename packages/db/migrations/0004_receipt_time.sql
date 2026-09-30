-- Server receipt time for append-only audit and domain events (CLD-R-013, ADR-0016).
-- occurred_at stays the author's event time; received_at is stamped by the sync Worker on
-- insert and is never device-writable. Local rows carry the local write time until synced.
ALTER TABLE audit_events ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE domain_events ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
