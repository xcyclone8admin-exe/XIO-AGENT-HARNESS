-- Trusted host-only sync acknowledgement evidence for complete Cloud reference snapshots.
ALTER TABLE brain_source_blob_reference_sets
  DROP CONSTRAINT brain_source_blob_reference_sets_status_check;
ALTER TABLE brain_source_blob_reference_sets
  ADD CONSTRAINT brain_source_blob_reference_sets_status_check CHECK(status IN (
    'unknown','pending','sync_accepted','verified_nonempty','verified_empty','unavailable','invalidated'
  )),
  ADD COLUMN sync_ack_id uuid,
  ADD COLUMN sync_idempotency_key text,
  ADD COLUMN sync_server_seq text CHECK(sync_server_seq IS NULL OR sync_server_seq ~ '^[0-9]{1,20}$'),
  ADD COLUMN sync_request_digest text CHECK(sync_request_digest IS NULL OR sync_request_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN sync_outcome_evidence jsonb CHECK(sync_outcome_evidence IS NULL OR jsonb_typeof(sync_outcome_evidence)='object'),
  ADD COLUMN sync_accepted_at timestamptz,
  ADD CONSTRAINT brain_source_blob_sync_acceptance_complete CHECK (
    status <> 'sync_accepted' OR (
      sync_ack_id IS NOT NULL AND sync_idempotency_key IS NOT NULL AND sync_server_seq IS NOT NULL AND
      sync_request_digest IS NOT NULL AND sync_outcome_evidence IS NOT NULL AND sync_accepted_at IS NOT NULL
    )
  );
CREATE UNIQUE INDEX brain_source_blob_sync_idempotency ON brain_source_blob_reference_sets(tenant_id,workspace_id,source_version_id,sync_idempotency_key)
  WHERE sync_idempotency_key IS NOT NULL;
