-- COMMAND module tables: dashboard, chat, alerts, actions, blueprint, doctor, personas.
-- Foundational objects (reject_append_mutation, workspaces) are owned by platform.

CREATE TABLE command_dashboard_layouts (
  tenant_id uuid NOT NULL,
  workspace_id uuid PRIMARY KEY,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE command_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  dismissed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_alerts_scope_time ON command_alerts(tenant_id, workspace_id, created_at DESC);

CREATE TABLE command_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  done_at timestamptz,
  dismissed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_actions_scope_time ON command_actions(tenant_id, workspace_id, created_at DESC);

CREATE TABLE command_chats (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  agent_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_chats_scope_time ON command_chats(tenant_id, workspace_id, created_at DESC);

CREATE TABLE command_chat_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','agent','system')),
  content text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, chat_id) REFERENCES command_chats(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX command_chat_messages_scope_chat ON command_chat_messages(tenant_id, workspace_id, chat_id, created_at DESC);

CREATE TABLE command_blueprint_nodes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('operator','agent','department','connector','store','page','daemon','model','skill')),
  x integer NOT NULL DEFAULT 0,
  y integer NOT NULL DEFAULT 0,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_blueprint_nodes_scope ON command_blueprint_nodes(tenant_id, workspace_id);

CREATE TABLE command_blueprint_edges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  label text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, source_id) REFERENCES command_blueprint_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, target_id) REFERENCES command_blueprint_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX command_blueprint_edges_scope ON command_blueprint_edges(tenant_id, workspace_id);

CREATE TABLE command_personas (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary text NOT NULL DEFAULT '',
  north_star_metric text,
  pillars jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_personas_scope ON command_personas(tenant_id, workspace_id);

CREATE TABLE command_doctor_checks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  check_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy','degraded','unhealthy')),
  detail text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX command_doctor_checks_scope ON command_doctor_checks(tenant_id, workspace_id);

ALTER TABLE command_dashboard_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_blueprint_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_blueprint_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_personas ENABLE ROW LEVEL SECURITY;

ALTER TABLE command_dashboard_layouts FORCE ROW LEVEL SECURITY;
ALTER TABLE command_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE command_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE command_chats FORCE ROW LEVEL SECURITY;
ALTER TABLE command_chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE command_blueprint_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE command_blueprint_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE command_personas FORCE ROW LEVEL SECURITY;
ALTER TABLE command_doctor_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_doctor_checks FORCE ROW LEVEL SECURITY;

CREATE POLICY command_dashboard_layouts_scope ON command_dashboard_layouts USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_alerts_scope ON command_alerts USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_actions_scope ON command_actions USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_chats_scope ON command_chats USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_chat_messages_scope ON command_chat_messages USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_blueprint_nodes_scope ON command_blueprint_nodes USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_blueprint_edges_scope ON command_blueprint_edges USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_personas_scope ON command_personas USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY command_doctor_checks_scope ON command_doctor_checks USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

CREATE TRIGGER command_chat_messages_immutable BEFORE UPDATE OR DELETE ON command_chat_messages
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER command_blueprint_edges_immutable BEFORE UPDATE OR DELETE ON command_blueprint_edges
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
