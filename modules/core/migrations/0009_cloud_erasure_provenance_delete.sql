-- Cloud erasure removes source-attributable reference snapshots and ingest provenance only
-- after a durable purge claim; tenant/workspace RLS remains mandatory for every DELETE.
GRANT DELETE ON cloud_erasure_refs, cloud_erasure_reference_sets,
  cloud_source_ingestions, cloud_source_ingestion_objects TO xyra_app_login;