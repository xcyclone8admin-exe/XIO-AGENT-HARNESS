CREATE TABLE forge_risk_acceptances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  gate_id text NOT NULL CHECK (length(gate_id) BETWEEN 1 AND 256),
  requirement_id text NOT NULL CHECK (length(requirement_id) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  impact text NOT NULL CHECK (length(impact) BETWEEN 1 AND 4000),
  mitigation text NOT NULL CHECK (length(mitigation) BETWEEN 1 AND 4000),
  review_at timestamptz NOT NULL,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE forge_risk_acceptance_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,acceptance_id),
  FOREIGN KEY (tenant_id,workspace_id,acceptance_id) REFERENCES forge_risk_acceptances(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_risk_acceptances','forge_risk_acceptance_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true))', table_name || '_scope', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()', table_name || '_immutable', table_name);
  END LOOP;
END $$;
