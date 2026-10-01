-- Verified advisory Invest signals. Provider secrets are not stored here; the source registry
-- contains public verification keys and policy bounds only. The inbox is never an order queue.
CREATE TABLE cloud_invest_signal_sources (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  key_id uuid NOT NULL,
  signing_alg text NOT NULL CHECK (signing_alg IN ('ES256','EdDSA')),
  public_jwk jsonb NOT NULL CHECK (jsonb_typeof(public_jwk)='object'),
  active boolean NOT NULL DEFAULT true,
  allowed_algorithm_ids text[] NOT NULL CHECK (cardinality(allowed_algorithm_ids) BETWEEN 1 AND 64),
  allowed_symbols text[] NOT NULL CHECK (cardinality(allowed_symbols) BETWEEN 1 AND 512),
  max_age_seconds integer NOT NULL DEFAULT 300 CHECK (max_age_seconds BETWEEN 30 AND 3600),
  max_lifetime_seconds integer NOT NULL DEFAULT 900 CHECK (max_lifetime_seconds BETWEEN 1 AND 900),
  max_events_per_minute integer NOT NULL DEFAULT 60 CHECK (max_events_per_minute BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,source_id,key_id),
  UNIQUE (source_id,key_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE cloud_invest_signal_rate_windows (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (tenant_id,workspace_id,source_id,window_start)
);

CREATE TABLE cloud_invest_signal_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  key_id uuid NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest)=32),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  event_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','acked','expired')),
  claim_device_id uuid,
  lease_id uuid,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at timestamptz,
  ack_decision_id uuid,
  ack_idempotency_key uuid,
  acked_at timestamptz,
  queue_job_id uuid,
  UNIQUE (tenant_id,workspace_id,source_id,event_id),
  UNIQUE (lease_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_id,key_id)
    REFERENCES cloud_invest_signal_sources(tenant_id,workspace_id,source_id,key_id) ON DELETE RESTRICT,
  CHECK ((status='acked') = (acked_at IS NOT NULL)),
  CHECK ((status='acked') = (ack_idempotency_key IS NOT NULL)),
  CHECK ((status IN ('claimed','acked')) = (lease_id IS NOT NULL AND claim_device_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX cloud_invest_signal_claimable
  ON cloud_invest_signal_events(tenant_id,workspace_id,received_at,id)
  WHERE status IN ('pending','claimed');

CREATE TABLE cloud_invest_signal_claims (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  device_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES cloud_invest_signal_events(id) ON DELETE RESTRICT,
  lease_id uuid NOT NULL,
  lease_fence bigint NOT NULL CHECK (lease_fence > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,principal_id,device_id,idempotency_key),
  UNIQUE (lease_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

-- The Worker can look up public source keys before it knows the event's scope. All mutation and
-- consumer reads remain constrained to the transaction's server-derived tenant/workspace GUCs.
ALTER TABLE cloud_invest_signal_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_rate_windows FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_events FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_invest_signal_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_invest_signal_sources_worker_read ON cloud_invest_signal_sources
  FOR SELECT TO xyra_app_login USING (true);
CREATE POLICY cloud_invest_signal_sources_runtime_read ON cloud_invest_signal_sources
  FOR SELECT TO xyra_cloud_runtime_app USING (true);
CREATE POLICY cloud_invest_signal_rate_scope ON cloud_invest_signal_rate_windows
  USING (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE POLICY cloud_invest_signal_rate_cleanup ON cloud_invest_signal_rate_windows
  FOR DELETE TO xyra_cloud_runtime_app
  USING (window_start < now() - interval '2 days');
CREATE POLICY cloud_invest_signal_events_scope ON cloud_invest_signal_events
  USING (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE POLICY cloud_invest_signal_claims_scope ON cloud_invest_signal_claims
  USING (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true)
     AND workspace_id::text=current_setting('app.workspace_id',true));

GRANT SELECT ON cloud_invest_signal_sources TO xyra_app_login;
GRANT SELECT,INSERT,UPDATE (request_count) ON cloud_invest_signal_rate_windows TO xyra_app_login;
GRANT DELETE ON cloud_invest_signal_rate_windows TO xyra_app_login;
GRANT SELECT,INSERT ON cloud_invest_signal_events TO xyra_app_login;
GRANT UPDATE (status,claim_device_id,lease_id,lease_fence,lease_expires_at,
              ack_decision_id,ack_idempotency_key,acked_at,queue_job_id)
  ON cloud_invest_signal_events TO xyra_app_login;
GRANT SELECT,INSERT ON cloud_invest_signal_claims TO xyra_app_login;
GRANT INSERT,SELECT ON cloud_queue_jobs TO xyra_app_login;

-- Source/key enrollment is performed by an owner-controlled migration/bootstrap process. The
-- Worker has no INSERT/UPDATE/DELETE permission on the allowlist and cannot broaden its own trust.
