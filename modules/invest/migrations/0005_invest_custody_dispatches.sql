CREATE TABLE invest_custody_dispatches (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 120),
  dispatch_id text NOT NULL CHECK (length(dispatch_id) BETWEEN 1 AND 180),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','connector_unavailable','failed')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  error_code text,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  lease_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,idempotency_key),
  CHECK ((status='completed') = (completed_at IS NOT NULL AND result IS NOT NULL)),
  CHECK ((status IN ('connector_unavailable','failed')) = (error_code IS NOT NULL)),
  CHECK ((status='running') = (lease_until IS NOT NULL))
);

ALTER TABLE invest_custody_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE invest_custody_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY invest_custody_dispatches_scope ON invest_custody_dispatches
  USING (invest_controls_scope(tenant_id,workspace_id))
  WITH CHECK (invest_controls_scope(tenant_id,workspace_id));
