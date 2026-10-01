-- FLOW core: workflow definitions (local, code/user-owned), an append-only run EVENT log (current
-- run status is the latest event for a given run_id, same pattern as CONNECT's grant ledger), and
-- an append-only checkpoint log that makes a run resumable from its last completed step after a
-- crash (XIO-REQ-FLW-001).
CREATE TABLE flow_workflows (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  steps jsonb NOT NULL,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 200)
);

-- One row per run lifecycle event; `run_id` is the stable logical run identifier shared by every
-- event for that run, `id` is the event's own identity. The current status of a run is its latest
-- event by created_at. This keeps the table append-only end to end.
CREATE TABLE flow_runs (
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'dead_letter', 'canceled')),
  step_index integer NOT NULL DEFAULT 0 CHECK (step_index >= 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, workflow_id) REFERENCES flow_workflows(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'running') = (ended_at IS NULL))
);
CREATE INDEX flow_runs_run_id ON flow_runs(tenant_id, workspace_id, run_id, created_at DESC);
CREATE INDEX flow_runs_workflow_state ON flow_runs(tenant_id, workspace_id, workflow_id, state);

CREATE TABLE flow_checkpoints (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 0),
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
-- Idempotent checkpoint writes: one row per (run, step, attempt) no matter how many times the
-- engine is re-invoked after a crash (durable crash/resume requirement).
CREATE UNIQUE INDEX flow_checkpoints_run_step_attempt ON flow_checkpoints(tenant_id, workspace_id, run_id, step_index, attempt);
CREATE INDEX flow_checkpoints_run ON flow_checkpoints(tenant_id, workspace_id, run_id, step_index, attempt);

-- All FLOW records use fail-closed workspace RLS; run and checkpoint logs reject mutation after insert.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['flow_workflows', 'flow_runs', 'flow_checkpoints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true))', table_name || '_scope', table_name);
  END LOOP;
END $$;
