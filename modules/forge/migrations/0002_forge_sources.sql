CREATE TABLE forge_sources (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  locator text NOT NULL CHECK (length(locator) BETWEEN 1 AND 1000),
  authority text NOT NULL CHECK (authority IN ('user','contract','architecture','system','reference')),
  status text NOT NULL CHECK (status IN ('approved','draft','rejected')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
ALTER TABLE forge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_sources_scope ON forge_sources USING (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
);
CREATE TRIGGER forge_sources_immutable BEFORE UPDATE OR DELETE ON forge_sources FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
