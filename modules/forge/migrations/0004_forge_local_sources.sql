ALTER TABLE forge_sources ADD COLUMN content text;
ALTER TABLE forge_sources ADD CONSTRAINT forge_sources_content_size CHECK (content IS NULL OR octet_length(content) <= 1000000);

CREATE TABLE forge_spec_versions (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  spec_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  template text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  authority text NOT NULL CHECK (authority IN ('user','contract','architecture','system')),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes jsonb NOT NULL DEFAULT '[]'::jsonb,
  requirement_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  frontmatter jsonb NOT NULL,
  body text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, spec_id, version),
  FOREIGN KEY (tenant_id, workspace_id, project_id) REFERENCES forge_projects(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE forge_spec_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_spec_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_spec_versions_scope ON forge_spec_versions USING (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
);
CREATE TRIGGER forge_spec_versions_immutable BEFORE UPDATE OR DELETE ON forge_spec_versions FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
