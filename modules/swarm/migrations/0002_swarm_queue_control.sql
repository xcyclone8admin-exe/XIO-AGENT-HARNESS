-- Durable SWARM admission, lifecycle, and per-workspace kill switch.
-- Execution is a separate host concern and remains gated by WP-EXEC C1.

CREATE TABLE swarm_run_queue (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','claimed','running','completed','failed','canceled','refused')),
  claim_token uuid,
  claimed_by text,
  claim_expires_at timestamptz,
  cancellation_requested boolean NOT NULL DEFAULT false,
  error_code text,
  result_delivery_state text NOT NULL DEFAULT 'not_applicable' CHECK (result_delivery_state IN ('not_applicable','pending','delivering','delivered','failed')),
  result_payload jsonb,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  result_delivery_token uuid,
  result_delivery_expires_at timestamptz,
  result_delivery_attempts integer NOT NULL DEFAULT 0 CHECK (result_delivery_attempts >= 0),
  result_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_delivery_error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, profile_id) REFERENCES swarm_agent_profiles(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('claimed','running') AND claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (state NOT IN ('claimed','running') AND claim_token IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL)
  ),
  CHECK ((result_delivery_state = 'delivering') = (result_delivery_token IS NOT NULL AND result_delivery_expires_at IS NOT NULL)),
  CHECK ((state IN ('completed','failed','canceled','refused')) = (ended_at IS NOT NULL))
);
CREATE INDEX swarm_run_queue_pending ON swarm_run_queue(tenant_id, workspace_id, created_at, id) WHERE state='queued';
CREATE INDEX swarm_run_queue_active ON swarm_run_queue(tenant_id, workspace_id, profile_id) WHERE state IN ('claimed','running');

CREATE TABLE swarm_run_queue_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('queued','claimed','running','completed','failed','canceled','cancel_requested','refused','requeued','result_delivery_claimed','result_delivered','result_delivery_failed')),
  from_state text,
  to_state text NOT NULL CHECK (to_state IN ('queued','claimed','running','completed','failed','canceled','refused')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid NOT NULL,
  approval_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES swarm_run_queue(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX swarm_run_queue_events_run ON swarm_run_queue_events(tenant_id, workspace_id, run_id, created_at, id);

CREATE TABLE swarm_workspace_kill_switch (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  engaged boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  CHECK (reason IS NULL OR length(reason) <= 500)
);

CREATE TABLE swarm_kill_switch_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  engaged boolean NOT NULL,
  reason text,
  changed_by uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  CHECK (reason IS NULL OR length(reason) <= 500)
);
CREATE INDEX swarm_kill_switch_events_scope ON swarm_kill_switch_events(tenant_id, workspace_id, created_at, id);

CREATE TRIGGER swarm_run_queue_events_immutable BEFORE UPDATE OR DELETE ON swarm_run_queue_events FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER swarm_kill_switch_events_immutable BEFORE UPDATE OR DELETE ON swarm_kill_switch_events FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['swarm_run_queue','swarm_run_queue_events','swarm_workspace_kill_switch','swarm_kill_switch_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true))', table_name || '_scope', table_name);
  END LOOP;
END $$;

-- Durable services write through the manifest-derived `swarm_service` capability role.
-- App clients can read through workspace RLS but cannot change queue/control state.
