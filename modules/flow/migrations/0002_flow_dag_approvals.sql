-- Adds DAG scheduling metadata and the approval-gate ledger (additive; ADR-0016).
ALTER TABLE flow_workflows ADD COLUMN missed_job_policy text NOT NULL DEFAULT 'skip' CHECK (missed_job_policy IN ('skip', 'run-once'));

ALTER TABLE flow_runs DROP CONSTRAINT flow_runs_state_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_state_check CHECK (state IN ('running', 'awaiting_approval', 'succeeded', 'failed', 'dead_letter', 'canceled'));
ALTER TABLE flow_runs DROP CONSTRAINT flow_runs_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_check CHECK ((state IN ('running', 'awaiting_approval')) = (ended_at IS NULL));

-- One row per approval decision on a run's currently gated step; a run can only advance past a
-- requiresApproval step once a matching 'approve' decision exists for its (run, step, attempt).
CREATE TABLE flow_approvals (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  attempt integer NOT NULL CHECK (attempt >= 0),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text NOT NULL DEFAULT '',
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX flow_approvals_run_step_attempt ON flow_approvals(tenant_id, workspace_id, run_id, step_index, attempt);

ALTER TABLE flow_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_approvals_scope ON flow_approvals USING (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
);
