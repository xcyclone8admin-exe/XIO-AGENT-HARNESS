ALTER TABLE forge_sources ADD CONSTRAINT forge_sources_scope_id UNIQUE (tenant_id, workspace_id, id);

CREATE TABLE forge_source_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, source_id),
  FOREIGN KEY (tenant_id, workspace_id, source_id) REFERENCES forge_sources(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
ALTER TABLE forge_source_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_source_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_source_decisions_scope ON forge_source_decisions
  USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE TRIGGER forge_source_decisions_immutable BEFORE UPDATE OR DELETE ON forge_source_decisions
  FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
