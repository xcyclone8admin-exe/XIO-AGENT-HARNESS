-- Server-only concurrency fence for a scheduled, multi-instance dispatcher. One row per
-- (run, step, attempt) — the same tuple flow_checkpoints already treats as the unique unit of
-- idempotent work — holding whichever claim currently owns the right to execute it.
--
-- A claim is won with an atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE: it only overwrites an
-- existing row when that row has been released (released_at IS NOT NULL) or its lease has expired
-- (lease_expires_at < now()). A caller whose claim_token does not match the row that won the race
-- cannot checkpoint or advance (FlowRepository enforces this before any write). Lease recovery is
-- idempotent: the (run, step, attempt) fence never moves, and any checkpoint a now-stale claimant
-- already wrote before its lease expired is reused rather than re-executed (FlowRepository's
-- existing checkpoint-reuse path), so reclaiming and retrying never re-runs completed work.
CREATE TABLE flow_step_claims (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  attempt integer NOT NULL CHECK (attempt >= 0),
  claim_token uuid NOT NULL,
  dispatch_id text NOT NULL CHECK (length(dispatch_id) BETWEEN 1 AND 300),
  claimed_by uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, run_id, step_index, attempt),
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES flow_run_registry(tenant_id, workspace_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, claimed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (released_at IS NULL OR released_at >= claimed_at)
);

ALTER TABLE flow_step_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_step_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_step_claims_scope ON flow_step_claims USING (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
);
