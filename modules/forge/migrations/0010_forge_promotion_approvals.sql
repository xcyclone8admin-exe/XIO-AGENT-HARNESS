CREATE TABLE forge_promotion_approval_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40,64}$'),
  from_environment text NOT NULL CHECK (from_environment IN ('develop','staging','main')),
  to_environment text NOT NULL CHECK (to_environment='main'),
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,promotion_id),
  FOREIGN KEY (tenant_id,workspace_id,promotion_id) REFERENCES forge_promotions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE forge_promotion_approval_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,request_id),
  FOREIGN KEY (tenant_id,workspace_id,request_id) REFERENCES forge_promotion_approval_requests(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_promotion_approval_requests','forge_promotion_approval_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true))', table_name || '_scope', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()', table_name || '_immutable', table_name);
  END LOOP;
END $$;
