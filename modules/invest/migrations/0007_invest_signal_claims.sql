CREATE TABLE invest_signal_claims (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  source_id uuid NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  lease_id uuid NOT NULL,
  fence bigint NOT NULL CHECK (fence > 0),
  lease_expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,decision_id,lease_id),
  UNIQUE (tenant_id,workspace_id,decision_id,fence),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,decision_id) REFERENCES invest_signal_decisions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_id,event_id) REFERENCES invest_signal_decisions(tenant_id,workspace_id,source_id,event_id) ON DELETE RESTRICT,
  CHECK (lease_expires_at > recorded_at)
);

ALTER TABLE invest_signal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE invest_signal_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY invest_signal_claims_scope ON invest_signal_claims
  USING (invest_controls_scope(tenant_id,workspace_id))
  WITH CHECK (invest_controls_scope(tenant_id,workspace_id));
CREATE TRIGGER invest_signal_claims_immutable BEFORE UPDATE OR DELETE ON invest_signal_claims
  FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
