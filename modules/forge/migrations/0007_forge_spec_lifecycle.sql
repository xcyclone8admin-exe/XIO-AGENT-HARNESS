ALTER TABLE forge_spec_versions ADD CONSTRAINT forge_spec_versions_project_key UNIQUE (tenant_id,workspace_id,project_id,spec_id,version);
CREATE TABLE forge_spec_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  spec_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('approve','supersede')),
  approval_id uuid NOT NULL,
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 4000),
  superseded_by_spec_id text,
  superseded_by_version integer,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,project_id) REFERENCES forge_projects(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,approval_id) REFERENCES forge_approvals(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,project_id,spec_id,version) REFERENCES forge_spec_versions(tenant_id,workspace_id,project_id,spec_id,version) ON DELETE RESTRICT,
  CHECK ((action='approve' AND superseded_by_spec_id IS NULL AND superseded_by_version IS NULL) OR (action='supersede' AND superseded_by_spec_id IS NOT NULL AND superseded_by_version IS NOT NULL))
);
CREATE INDEX forge_spec_events_latest ON forge_spec_events(tenant_id,workspace_id,project_id,spec_id,version,created_at DESC);
CREATE UNIQUE INDEX forge_spec_event_single_approval ON forge_spec_events(tenant_id,workspace_id,project_id,spec_id,version) WHERE action='approve';
CREATE UNIQUE INDEX forge_spec_event_single_supersession ON forge_spec_events(tenant_id,workspace_id,project_id,spec_id,version) WHERE action='supersede';
ALTER TABLE forge_spec_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_spec_events FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_spec_events_scope ON forge_spec_events USING (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
) WITH CHECK (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
);
CREATE TRIGGER forge_spec_events_immutable BEFORE UPDATE OR DELETE ON forge_spec_events FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
