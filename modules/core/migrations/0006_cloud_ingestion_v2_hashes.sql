-- Retire legacy v1 snapshots before accepting only v2 snapshot/version formats.
WITH stale AS (
  UPDATE cloud_erasure_reference_sets
     SET current=false,invalidated_at=COALESCE(invalidated_at,now())
   WHERE current=true AND (source_version LIKE 'sha256:%' OR snapshot_digest LIKE 'sha256:%')
   RETURNING tenant_id,workspace_id,source_id
), invalidated AS (
  UPDATE cloud_erasure_operations o
     SET status='eligibility_invalidated',reservation_id=NULL,reservation_expires_at=NULL,updated_at=now()
    WHERE o.status='eligible' AND EXISTS (
      SELECT 1 FROM stale s WHERE (s.tenant_id,s.workspace_id,s.source_id)=(o.tenant_id,o.workspace_id,o.source_id)
    )
   RETURNING tenant_id,workspace_id,id
)
INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
SELECT tenant_id,workspace_id,id,gen_random_uuid(),'eligibility_invalidated','{"reason":"legacy_v1_snapshot_retired"}'::jsonb
  FROM invalidated;

ALTER TABLE cloud_erasure_reference_sets
  DROP CONSTRAINT cloud_erasure_reference_sets_source_version_check,
  DROP CONSTRAINT cloud_erasure_reference_sets_snapshot_digest_check,
  ADD CONSTRAINT cloud_erasure_reference_sets_v2_digest_check
    CHECK (
      (source_version ~ '^cloud-ingest-v2:sha256:[0-9a-f]{64}$' AND snapshot_digest ~ '^[0-9a-f]{64}$')
      OR (NOT current AND source_version ~ '^sha256:[0-9a-f]{64}$' AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$')
    );

ALTER TABLE cloud_erasure_operations
  DROP CONSTRAINT cloud_erasure_operations_source_version_check,
  ADD CONSTRAINT cloud_erasure_operations_source_version_v2_check
    CHECK (source_version ~ '^cloud-ingest-v2:sha256:[0-9a-f]{64}$' OR source_version ~ '^sha256:[0-9a-f]{64}$');