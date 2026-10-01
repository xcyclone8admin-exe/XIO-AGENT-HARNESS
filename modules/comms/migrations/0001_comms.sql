-- COMMS module tables: threads, messages, events, meetings.
-- Foundational objects (reject_append_mutation, workspaces) are owned by platform.

CREATE TABLE comms_threads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  channel text NOT NULL CHECK (channel IN ('email','slack','sms','in_app')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','done')),
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  snoozed_until timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX comms_threads_scope_status ON comms_threads(tenant_id, workspace_id, status, created_at DESC);

CREATE TABLE comms_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  body text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  external_id text,
  send_approval_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, thread_id) REFERENCES comms_threads(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX comms_messages_scope_thread ON comms_messages(tenant_id, workspace_id, thread_id, created_at ASC);

CREATE TABLE comms_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative','confirmed','cancelled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX comms_events_scope_time ON comms_events(tenant_id, workspace_id, starts_at ASC);

CREATE TABLE comms_meetings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  event_id uuid,
  summary text,
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  recording_url text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, event_id) REFERENCES comms_events(tenant_id, workspace_id, id) ON DELETE SET NULL,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX comms_meetings_scope_time ON comms_meetings(tenant_id, workspace_id, created_at DESC);

ALTER TABLE comms_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms_meetings ENABLE ROW LEVEL SECURITY;

ALTER TABLE comms_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE comms_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE comms_events FORCE ROW LEVEL SECURITY;
ALTER TABLE comms_meetings FORCE ROW LEVEL SECURITY;

CREATE POLICY comms_threads_scope ON comms_threads USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY comms_messages_scope ON comms_messages USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY comms_events_scope ON comms_events USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY comms_meetings_scope ON comms_meetings USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

CREATE TRIGGER comms_messages_immutable BEFORE UPDATE OR DELETE ON comms_messages
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
