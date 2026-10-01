-- Cloud authentication, webhook and background-work state. The Worker uses only
-- the non-owner xyra_app_login role; all tokens and replay keys are stored hashed.
-- Auth transactions are isolated by a trusted per-transaction auth ID until the
-- user/tenant is known, then by tenant_id and (where applicable) workspace_id.

CREATE TABLE cloud_passkeys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transports) = 'array'),
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT 'Passkey' CHECK (length(label) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cloud_passkeys_user ON cloud_passkeys(tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE cloud_auth_transactions (
  id uuid PRIMARY KEY,
  purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'register')),
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid,
  target_workspace_id uuid NOT NULL,
  state_hash bytea NOT NULL UNIQUE,
  pkce_challenge text CHECK (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  device_id uuid,
  device_public_jwk jsonb CHECK (device_public_jwk IS NULL OR jsonb_typeof(device_public_jwk) = 'object'),
  device_thumbprint text CHECK (device_thumbprint IS NULL OR device_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  redirect_uri text CHECK (redirect_uri IS NULL OR length(redirect_uri) BETWEEN 20 AND 256),
  nonce text CHECK (nonce IS NULL OR length(nonce) BETWEEN 16 AND 128),
  challenge text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tenant_id IS NULL) = (user_id IS NULL)),
  CHECK (
    (purpose = 'login' AND pkce_challenge IS NOT NULL AND device_id IS NOT NULL
      AND device_public_jwk IS NOT NULL AND device_thumbprint IS NOT NULL AND redirect_uri IS NOT NULL AND nonce IS NOT NULL)
    OR (purpose = 'register' AND tenant_id IS NOT NULL AND user_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cloud_auth_transactions_expiry ON cloud_auth_transactions(expires_at);

CREATE TABLE cloud_auth_codes (
  code_hash bytea PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE REFERENCES cloud_auth_transactions(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_public_jwk jsonb NOT NULL CHECK (jsonb_typeof(device_public_jwk) = 'object'),
  device_thumbprint text NOT NULL CHECK (length(device_thumbprint) = 43),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cloud_auth_codes_expiry ON cloud_auth_codes(expires_at);

CREATE TABLE cloud_refresh_families (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_public_jwk jsonb NOT NULL CHECK (jsonb_typeof(device_public_jwk) = 'object'),
  device_thumbprint text NOT NULL CHECK (length(device_thumbprint) = 43),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cloud_refresh_families_user ON cloud_refresh_families(tenant_id, user_id, device_id);

CREATE TABLE cloud_refresh_tokens (
  token_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  family_id uuid NOT NULL REFERENCES cloud_refresh_families(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replaced_by_hash bytea,
  UNIQUE (family_id, generation),
  CHECK ((used_at IS NULL) = (replaced_by_hash IS NULL))
);
CREATE INDEX cloud_refresh_tokens_family ON cloud_refresh_tokens(family_id);
CREATE INDEX cloud_refresh_tokens_expiry ON cloud_refresh_tokens(expires_at);

CREATE TABLE cloud_dpop_replays (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  jti_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, jti_hash)
);
CREATE INDEX cloud_dpop_replays_expiry ON cloud_dpop_replays(expires_at);

CREATE TABLE cloud_webhook_receipts (
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  payload_hash bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  processed_at timestamptz,
  failure_code text,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE cloud_queue_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  job_type text NOT NULL CHECK (length(job_type) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, job_type, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX cloud_queue_jobs_ready ON cloud_queue_jobs(status, next_attempt_at) WHERE status IN ('pending', 'running');

CREATE TABLE cloud_cron_runs (
  job_name text NOT NULL CHECK (length(job_name) BETWEEN 1 AND 128),
  window_start timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'failed')),
  PRIMARY KEY (job_name, window_start)
);

CREATE TABLE cloud_purge_markers (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  server_seq bigint NOT NULL CHECK (server_seq >= 0),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, workspace_id, server_seq),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

-- Defense in depth. Pre-auth transactions can only be read with the matching
-- trusted auth transaction id; tenant-bound records require the same tenant.
ALTER TABLE cloud_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_auth_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_refresh_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_dpop_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_queue_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_cron_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_purge_markers ENABLE ROW LEVEL SECURITY;

ALTER TABLE cloud_passkeys FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_auth_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_auth_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_refresh_families FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_refresh_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_dpop_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_webhook_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_queue_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_cron_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_purge_markers FORCE ROW LEVEL SECURITY;

CREATE POLICY cloud_passkeys_scope ON cloud_passkeys USING (
  tenant_id::text = current_setting('app.tenant_id', true) OR
  (credential_id = current_setting('app.auth_credential_id', true) AND EXISTS (
    SELECT 1 FROM cloud_auth_transactions t
     WHERE t.id::text = current_setting('app.auth_transaction_id', true)
       AND t.tenant_id IS NULL AND t.consumed_at IS NULL AND t.expires_at > now()
  ))
) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY cloud_auth_transactions_scope ON cloud_auth_transactions USING (
  (tenant_id IS NOT NULL AND tenant_id::text = current_setting('app.tenant_id', true)) OR
  (tenant_id IS NULL AND id::text = current_setting('app.auth_transaction_id', true))
) WITH CHECK (
  (tenant_id IS NOT NULL AND tenant_id::text = current_setting('app.tenant_id', true)) OR
  (tenant_id IS NULL AND id::text = current_setting('app.auth_transaction_id', true))
);
CREATE POLICY cloud_auth_codes_scope ON cloud_auth_codes USING (
  tenant_id::text = current_setting('app.tenant_id', true) OR
  transaction_id::text = current_setting('app.auth_transaction_id', true)
) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY cloud_refresh_families_scope ON cloud_refresh_families USING (
  tenant_id::text = current_setting('app.tenant_id', true) OR
  id IN (SELECT family_id FROM cloud_refresh_tokens
          WHERE encode(token_hash,'hex') = current_setting('app.refresh_token_hash', true))
) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY cloud_refresh_tokens_scope ON cloud_refresh_tokens USING (
  tenant_id::text = current_setting('app.tenant_id', true) OR
  encode(token_hash,'hex') = current_setting('app.refresh_token_hash', true)
) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
CREATE POLICY cloud_dpop_replays_scope ON cloud_dpop_replays USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
-- Cron may purge only expired replay records; the trigger below independently
-- rejects deletion of any unexpired proof, even if a future policy is widened.
CREATE POLICY cloud_dpop_replays_expired_cleanup ON cloud_dpop_replays
  FOR DELETE USING (current_user = 'xyra_app_login' AND expires_at < now());
CREATE POLICY cloud_webhook_receipts_worker ON cloud_webhook_receipts USING (current_user = 'xyra_app_login') WITH CHECK (current_user = 'xyra_app_login');
CREATE POLICY cloud_queue_jobs_scope ON cloud_queue_jobs USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY cloud_cron_runs_worker ON cloud_cron_runs USING (current_user = 'xyra_app_login') WITH CHECK (current_user = 'xyra_app_login');
CREATE POLICY cloud_purge_markers_scope ON cloud_purge_markers USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

-- Auth proofs and webhook receipts are append-only. Rotating token rows record
-- one-way use transitions; family revocation is the only mutable auth decision.
CREATE FUNCTION reject_cloud_immutable_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at < now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER cloud_dpop_replays_immutable BEFORE UPDATE OR DELETE ON cloud_dpop_replays FOR EACH ROW EXECUTE FUNCTION reject_cloud_immutable_mutation();
CREATE TRIGGER cloud_webhook_receipts_immutable BEFORE UPDATE OR DELETE ON cloud_webhook_receipts FOR EACH ROW EXECUTE FUNCTION reject_cloud_immutable_mutation();

-- Dedicated Neon Worker login. It can read current server authority but cannot
-- write membership/profile records or take ownership of any table.
DO $cloud_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xyra_app_login') THEN
    CREATE ROLE xyra_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE xyra_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$cloud_role$;
GRANT USAGE ON SCHEMA public TO xyra_app_login;
GRANT SELECT ON memberships, workspaces, users, swarm_agent_profiles TO xyra_app_login;

GRANT SELECT, INSERT ON cloud_auth_transactions, cloud_auth_codes,
  cloud_refresh_families, cloud_refresh_tokens, cloud_dpop_replays,
  cloud_webhook_receipts, cloud_queue_jobs, cloud_cron_runs, cloud_purge_markers TO xyra_app_login;
GRANT SELECT (tenant_id,user_id,credential_id,public_key,sign_count,transports,device_type,backed_up,revoked_at),
  INSERT (id,tenant_id,user_id,credential_id,public_key,sign_count,transports,device_type,backed_up,label)
  ON cloud_passkeys TO xyra_app_login;
GRANT UPDATE (tenant_id,user_id,consumed_at) ON cloud_auth_transactions TO xyra_app_login;
GRANT UPDATE (consumed_at) ON cloud_auth_codes TO xyra_app_login;
GRANT UPDATE (sign_count, last_used_at, revoked_at, label) ON cloud_passkeys TO xyra_app_login;
GRANT UPDATE (revoked_at, revoke_reason) ON cloud_refresh_families TO xyra_app_login;
GRANT UPDATE (used_at, replaced_by_hash) ON cloud_refresh_tokens TO xyra_app_login;
GRANT UPDATE (status, attempts, next_attempt_at, locked_until, last_error_code, updated_at)
  ON cloud_queue_jobs TO xyra_app_login;
GRANT UPDATE (finished_at, outcome) ON cloud_cron_runs TO xyra_app_login;
GRANT DELETE ON cloud_dpop_replays TO xyra_app_login;
