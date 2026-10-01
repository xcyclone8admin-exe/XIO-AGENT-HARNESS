-- CONNECT core: connector registry (local, code-owned catalog entries) and the append-only grant
-- ledger that records who authorized which connector action (ADR-0011 honest states).
CREATE TABLE connect_connectors (
  id text NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  family text NOT NULL CHECK (length(family) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('CONNECTED', 'NOT_CONFIGURED', 'DEGRADED', 'ERROR', 'REAUTH_REQUIRED', 'DISABLED')),
  detail text NOT NULL DEFAULT '',
  checked_at timestamptz,
  availability text NOT NULL CHECK (availability IN ('available', 'not-yet-available')),
  custody text NOT NULL CHECK (custody IN ('local-keychain', 'cloud-envelope', 'none')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (availability <> 'not-yet-available' OR state IN ('NOT_CONFIGURED', 'DISABLED')),
  CHECK (state <> 'CONNECTED' OR checked_at IS NOT NULL)
);

CREATE TABLE connect_grants (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connector_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, connector_id) REFERENCES connect_connectors(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX connect_grants_connector ON connect_grants(tenant_id, workspace_id, connector_id, created_at DESC);

-- All CONNECT records use fail-closed workspace RLS; the grant ledger rejects mutation after insert.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['connect_connectors', 'connect_grants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true))', table_name || '_scope', table_name);
  END LOOP;
END $$;
