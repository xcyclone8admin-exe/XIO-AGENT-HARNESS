-- Cloud-owned ingestion provenance. This ledger proves which opaque objects Cloud issued to a
-- specific authenticated ingest operation; a client-provided completeness flag is never authority.
CREATE TABLE cloud_source_ingestions (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('with_objects','text_only')),
  status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','finalized','invalidated')),
  content_version text CHECK (content_version IS NULL OR content_version ~ '^sha256:[0-9a-f]{64}$'),
  source_version text CHECK (source_version IS NULL OR source_version ~ '^cloud-ingest-v2:sha256:[0-9a-f]{64}$'),
  source_version_id uuid,
  content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^[0-9a-f]{64}$'),
  reference_state_version bigint CHECK (reference_state_version IS NULL OR reference_state_version > 0),
  snapshot_digest text CHECK (snapshot_digest IS NULL OR snapshot_digest ~ '^[0-9a-f]{64}$'),
  reference_state text CHECK (reference_state IS NULL OR reference_state IN ('verified_empty','verified_nonempty')),
  object_ref_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  invalidated_at timestamptz,
  PRIMARY KEY (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='finalized' AND content_version IS NOT NULL AND source_version IS NOT NULL
      AND source_version_id IS NOT NULL AND content_digest IS NOT NULL AND reference_state IS NOT NULL
      AND reference_state_version IS NOT NULL AND snapshot_digest IS NOT NULL AND finalized_at IS NOT NULL)
    OR status<>'finalized')
);
CREATE INDEX cloud_source_ingestions_source
  ON cloud_source_ingestions(tenant_id,workspace_id,source_id,created_at DESC);
CREATE UNIQUE INDEX cloud_source_ingestions_collecting
  ON cloud_source_ingestions(tenant_id,workspace_id,source_id,actor_id) WHERE status='collecting';

CREATE TABLE cloud_source_ingestion_objects (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  ingestion_id uuid NOT NULL,
  object_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  PRIMARY KEY (tenant_id,workspace_id,ingestion_id,object_id),
  FOREIGN KEY (tenant_id,workspace_id,ingestion_id)
    REFERENCES cloud_source_ingestions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,object_id)
    REFERENCES cloud_erasure_objects(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX cloud_source_ingestion_objects_object
  ON cloud_source_ingestion_objects(tenant_id,workspace_id,object_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cloud_source_ingestions','cloud_source_ingestion_objects'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true))',
      t||'_scope',t
    );
  END LOOP;
END $$;
GRANT SELECT,INSERT ON cloud_source_ingestions TO xyra_app_login;
GRANT UPDATE (status,content_version,source_version,source_version_id,content_digest,reference_state_version,snapshot_digest,reference_state,object_ref_ids,updated_at,finalized_at,invalidated_at)
  ON cloud_source_ingestions TO xyra_app_login;
GRANT SELECT,INSERT,UPDATE (uploaded_at) ON cloud_source_ingestion_objects TO xyra_app_login;

ALTER TABLE cloud_erasure_reference_sets
  ADD COLUMN ingestion_id uuid,
  ADD COLUMN content_version text CHECK (content_version IS NULL OR content_version ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN completeness text NOT NULL DEFAULT 'unknown' CHECK (completeness IN ('unknown','verified_nonempty','verified_empty'));
ALTER TABLE cloud_erasure_reference_sets ADD CONSTRAINT cloud_erasure_reference_sets_ingestion_fk
  FOREIGN KEY (tenant_id,workspace_id,ingestion_id)
  REFERENCES cloud_source_ingestions(tenant_id,workspace_id,id) ON DELETE RESTRICT;
GRANT UPDATE (ingestion_id,content_version,completeness) ON cloud_erasure_reference_sets TO xyra_app_login;
