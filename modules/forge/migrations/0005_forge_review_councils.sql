CREATE TABLE forge_councils (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('project','epic','spec','plan','wave','ticket','subtask')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in-review','complete')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,project_id) REFERENCES forge_projects(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE forge_council_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  council_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('architect','security','data','compliance','ai-safety','accessibility','performance','license-provenance','adversarial-user')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,council_id,role),
  FOREIGN KEY (council_id) REFERENCES forge_councils(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id) REFERENCES forge_councils(tenant_id,workspace_id,id) ON DELETE RESTRICT
);

CREATE TABLE forge_council_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  council_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('architect','security','data','compliance','ai-safety','accessibility','performance','license-provenance','adversarial-user')),
  decision text NOT NULL CHECK (decision IN ('findings','no-findings')),
  finding_id uuid,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_source text NOT NULL CHECK (evidence_source IN ('user-submitted','independent-review')),
  submitted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,council_id,role),
  FOREIGN KEY (council_id) REFERENCES forge_councils(id) ON DELETE RESTRICT,
  FOREIGN KEY (finding_id) REFERENCES forge_findings(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id,role) REFERENCES forge_council_assignments(tenant_id,workspace_id,council_id,role) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,finding_id) REFERENCES forge_findings(tenant_id,workspace_id,id) ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_councils','forge_council_assignments','forge_council_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'',true) AND workspace_id::text = current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'',true) AND workspace_id::text = current_setting(''app.workspace_id'',true))',table_name || '_scope',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()',table_name || '_immutable',table_name);
  END LOOP;
END $$;
