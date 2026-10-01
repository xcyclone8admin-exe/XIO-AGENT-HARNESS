-- Erasure removes attributable synced content only after a durable local-purge claim.
-- Existing RLS policies keep these delete privileges inside the verified tenant/workspace.
-- Workspace rows, pull logs, conflicts, references and replay payloads are removed by the
-- Cloud erasure transaction; a new content-free delete log and fence are written atomically.
GRANT DELETE ON cloud_sync_rows, cloud_sync_field_seq, cloud_sync_changes,
  cloud_sync_conflicts, cloud_sync_idempotency, cloud_sync_refs TO xyra_app_login;