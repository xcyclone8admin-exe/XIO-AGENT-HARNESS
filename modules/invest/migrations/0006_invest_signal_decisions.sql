CREATE TABLE invest_signal_decisions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  signal_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  algorithm_id text NOT NULL CHECK (length(algorithm_id) BETWEEN 1 AND 64),
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 32),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  signal_quantity text NOT NULL CHECK (length(signal_quantity) BETWEEN 1 AND 32),
  decision_status text NOT NULL CHECK (decision_status IN ('advisory','rejected')),
  claim_lease_id uuid NOT NULL,
  claim_fence bigint NOT NULL CHECK (claim_fence > 0),
  lease_expires_at timestamptz NOT NULL,
  instrument_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  decided_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,source_id,event_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,instrument_id) REFERENCES invest_instruments(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,decided_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (lease_expires_at > created_at)
);

ALTER TABLE invest_signal_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invest_signal_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY invest_signal_decisions_scope ON invest_signal_decisions
  USING (invest_controls_scope(tenant_id,workspace_id))
  WITH CHECK (invest_controls_scope(tenant_id,workspace_id));
CREATE TRIGGER invest_signal_decisions_immutable BEFORE UPDATE OR DELETE ON invest_signal_decisions
  FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
