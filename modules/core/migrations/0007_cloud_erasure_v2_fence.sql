-- Fences created after ingestion-v2 finalization store the shared v2 sourceVersion token.
-- The legacy sha256 form remains readable only for historical rows.
ALTER TABLE cloud_erasure_source_fences
  DROP CONSTRAINT cloud_erasure_source_fences_erased_source_version_check,
  ADD CONSTRAINT cloud_erasure_source_fences_erased_source_version_v2_check
    CHECK (
      erased_source_version ~ '^cloud-ingest-v2:sha256:[0-9a-f]{64}$'
      OR erased_source_version ~ '^sha256:[0-9a-f]{64}$'
    );
