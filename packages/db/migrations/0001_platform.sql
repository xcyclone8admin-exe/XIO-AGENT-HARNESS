-- Platform schema shared by PGlite and Neon. Application reads must use a scoped
-- non-owner role; the local sidecar additionally guards every query (ADR-0005 A1).
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'sample')),
  sync_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  os_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, os_subject)
);

-- Server-authority records. No sync push can write them directly.
CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','member','viewer','auditor')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  capability_id text NOT NULL,
  input_hash text NOT NULL,
  requested_by uuid NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  decided_by uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  valid boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX approval_first_valid_decision ON approval_decisions(request_id) WHERE valid;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX audit_events_scope_time ON audit_events(tenant_id, workspace_id, occurred_at DESC);

CREATE TABLE domain_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  actor_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX domain_events_scope_time ON domain_events(tenant_id, workspace_id, occurred_at DESC);

-- Local sync bookkeeping. The Worker stamps server_seq for accepted changes.
CREATE TABLE sync_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  change jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sync_outbox_pending ON sync_outbox(workspace_id, created_at) WHERE sent_at IS NULL;

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  field_name text NOT NULL,
  winning_value jsonb,
  losing_value jsonb,
  winning_hlc text NOT NULL,
  losing_hlc text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE sync_cursors (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  device_id uuid NOT NULL,
  server_seq bigint NOT NULL DEFAULT 0 CHECK (server_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, device_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

-- RLS is defense in depth; the policy engine is the primary boundary. All
-- policies fail closed when the scope GUCs are absent. The application role
-- must not own tables or have BYPASSRLS.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_scope ON tenants USING (id::text = current_setting('app.tenant_id', true)) WITH CHECK (id::text = current_setting('app.tenant_id', true));
CREATE POLICY workspaces_scope ON workspaces USING (tenant_id::text = current_setting('app.tenant_id', true) AND id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND id::text = current_setting('app.workspace_id', true));
CREATE POLICY users_scope ON users USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY memberships_scope ON memberships USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY approval_requests_scope ON approval_requests USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY approval_decisions_scope ON approval_decisions USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY audit_events_scope ON audit_events USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY domain_events_scope ON domain_events USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY sync_outbox_scope ON sync_outbox USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY sync_conflicts_scope ON sync_conflicts USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY sync_cursors_scope ON sync_cursors USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

-- Requests, decisions, audit and domain events are append-only. Corrections
-- are new events, never edits or deletes.
CREATE FUNCTION reject_append_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER approval_requests_immutable BEFORE UPDATE OR DELETE ON approval_requests FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER domain_events_immutable BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
