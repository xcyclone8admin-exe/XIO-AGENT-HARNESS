CREATE TABLE forge_council_reviewer_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  council_id uuid NOT NULL,
  role text NOT NULL,
  reviewer_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,council_id,role),
  FOREIGN KEY (tenant_id,workspace_id,council_id,role) REFERENCES forge_council_assignments(tenant_id,workspace_id,council_id,role) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id) REFERENCES forge_councils(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX forge_council_one_role_per_reviewer ON forge_council_reviewer_events(tenant_id,workspace_id,council_id,reviewer_id);
ALTER TABLE forge_council_reviewer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_council_reviewer_events FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_council_reviewer_events_scope ON forge_council_reviewer_events USING (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
) WITH CHECK (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
);
CREATE TRIGGER forge_council_reviewer_events_immutable BEFORE UPDATE OR DELETE ON forge_council_reviewer_events FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
