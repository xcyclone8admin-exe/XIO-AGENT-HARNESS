-- Local core settings and the ops exemplar. Tenant/workspace keys are repeated
-- deliberately so foreign keys and RLS both reject cross-scope references.
CREATE TABLE workspace_settings (
  tenant_id uuid NOT NULL,
  workspace_id uuid PRIMARY KEY,
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE ops_projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','complete')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX ops_projects_scope_time ON ops_projects(tenant_id, workspace_id, created_at DESC);

CREATE TABLE ops_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done')),
  assignee_id uuid,
  due_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, project_id) REFERENCES ops_projects(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX ops_tasks_scope_project ON ops_tasks(tenant_id, workspace_id, project_id, created_at DESC);

CREATE TABLE capability_idempotency (
  key text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ops_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE ops_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_idempotency FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_settings_scope ON workspace_settings USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ops_projects_scope ON ops_projects USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ops_tasks_scope ON ops_tasks USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY capability_idempotency_scope ON capability_idempotency USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
