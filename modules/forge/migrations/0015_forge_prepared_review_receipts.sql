ALTER TABLE forge_council_assignments
  ADD CONSTRAINT forge_council_assignment_scope_id UNIQUE (tenant_id,workspace_id,council_id,role,id);

CREATE TABLE forge_council_review_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  council_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('architect','security','data','compliance','ai-safety','accessibility','performance','license-provenance','adversarial-user')),
  target_id uuid NOT NULL,
  reviewer_principal_id uuid NOT NULL,
  repository_id text NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 300),
  review_contract_id text NOT NULL CHECK (length(review_contract_id) BETWEEN 1 AND 200),
  review_contract_sha256 text NOT NULL CHECK (review_contract_sha256 ~ '^[0-9a-f]{64}$'),
  subject_commit_sha text NOT NULL CHECK (subject_commit_sha ~ '^[0-9a-f]{40,64}$'),
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts)='array' AND jsonb_array_length(artifacts) <= 100),
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,council_id,role),
  UNIQUE (tenant_id,workspace_id,council_id,role,assignment_id),
  FOREIGN KEY (council_id) REFERENCES forge_councils(id) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id) REFERENCES forge_council_assignments(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id) REFERENCES forge_councils(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id,role,assignment_id) REFERENCES forge_council_assignments(tenant_id,workspace_id,council_id,role,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE forge_council_review_drafts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  council_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('architect','security','data','compliance','ai-safety','accessibility','performance','license-provenance','adversarial-user')),
  run_id uuid NOT NULL,
  reviewer_principal_id uuid NOT NULL,
  target_id uuid NOT NULL,
  repository_id text NOT NULL,
  review_contract_id text NOT NULL,
  review_contract_sha256 text NOT NULL CHECK (review_contract_sha256 ~ '^[0-9a-f]{64}$'),
  subject_commit_sha text NOT NULL CHECK (subject_commit_sha ~ '^[0-9a-f]{40,64}$'),
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts)='array' AND jsonb_array_length(artifacts) <= 100),
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
  output_digest text NOT NULL CHECK (output_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('findings','no-findings')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings)='array' AND jsonb_array_length(findings) <= 100),
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_ids)='array'),
  status text NOT NULL DEFAULT 'awaiting-validation' CHECK (status='awaiting-validation'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,workspace_id,run_id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,council_id,role,run_id),
  FOREIGN KEY (council_id) REFERENCES forge_councils(id) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id) REFERENCES forge_council_assignments(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id,role,assignment_id) REFERENCES forge_council_assignments(tenant_id,workspace_id,council_id,role,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,council_id,role,assignment_id) REFERENCES forge_council_review_bindings(tenant_id,workspace_id,council_id,role,assignment_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE forge_council_review_draft_evidence (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,draft_id,evidence_id),
  FOREIGN KEY (draft_id) REFERENCES forge_council_review_drafts(id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES forge_evidence(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,draft_id) REFERENCES forge_council_review_drafts(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,evidence_id) REFERENCES forge_evidence(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_council_review_bindings','forge_council_review_drafts','forge_council_review_draft_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true))',table_name || '_scope',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()',table_name || '_immutable',table_name);
  END LOOP;
END $$;
