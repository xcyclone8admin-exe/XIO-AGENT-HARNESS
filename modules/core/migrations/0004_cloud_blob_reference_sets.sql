-- Cloud-issued blob identities and complete source reference snapshots. Never infer a
-- storage key from a caller-provided UUID or source metadata.
ALTER TABLE cloud_erasure_objects
  ADD COLUMN storage_state text NOT NULL DEFAULT 'unknown'
    CHECK (storage_state IN ('unknown','available','deleted')),
  ADD COLUMN content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0);
GRANT UPDATE (storage_state,content_sha256,size_bytes) ON cloud_erasure_objects TO xyra_app_login;

CREATE TABLE cloud_erasure_reference_sets (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind='brain_source'),
  source_id uuid NOT NULL,
  source_version text NOT NULL CHECK (source_version ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  reference_state_version bigint NOT NULL CHECK (reference_state_version > 0),
  object_ids uuid[] NOT NULL,
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  PRIMARY KEY (tenant_id,workspace_id,snapshot_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((current AND invalidated_at IS NULL) OR (NOT current AND invalidated_at IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_erasure_reference_sets_current
  ON cloud_erasure_reference_sets(tenant_id,workspace_id,source_kind,source_id) WHERE current;
CREATE INDEX cloud_erasure_reference_sets_digest
  ON cloud_erasure_reference_sets(tenant_id,workspace_id,source_kind,source_id,source_version,snapshot_digest);
ALTER TABLE cloud_erasure_reference_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_erasure_reference_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_erasure_reference_sets_scope ON cloud_erasure_reference_sets
  USING (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT ON cloud_erasure_reference_sets TO xyra_app_login;
GRANT UPDATE (current,invalidated_at) ON cloud_erasure_reference_sets TO xyra_app_login;
