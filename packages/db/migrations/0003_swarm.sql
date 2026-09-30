-- WP-SWARM agent profiles plus append-only run, journal, eval and prompt
-- records. Column names match the write surfaces in modules/swarm/manifest.ts.
CREATE TABLE swarm_agent_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role_id text NOT NULL CHECK (length(role_id) BETWEEN 1 AND 100),
  charter text NOT NULL CHECK (length(charter) BETWEEN 1 AND 100000),
  default_provider text NOT NULL,
  default_model text NOT NULL,
  fallbacks jsonb NOT NULL DEFAULT '[]',
  capability_grants jsonb NOT NULL DEFAULT '[]',
  secret_scopes jsonb NOT NULL DEFAULT '[]',
  network_policy jsonb NOT NULL DEFAULT '{"mode":"none","allowedHosts":[]}',
  filesystem_policy jsonb NOT NULL DEFAULT '{"mode":"none","allowedPaths":[]}',
  budgets jsonb NOT NULL,
  approval_policy text NOT NULL,
  memory_scope jsonb NOT NULL,
  output_schema jsonb,
  autonomy_level integer NOT NULL DEFAULT 0 CHECK (autonomy_level BETWEEN 0 AND 5),
  eval_history jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE swarm_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  parent_run_id uuid,
  termination text NOT NULL CHECK (termination IN ('COMPLETED','BUDGET_EXCEEDED','TIMEOUT','CANCELED','KILL_SWITCH','LEASE_LOST','NO_PROGRESS','CONCURRENCY_LIMIT','FAILED','DELEGATION_DENIED')),
  output text,
  iterations integer NOT NULL CHECK (iterations >= 0),
  actions integer NOT NULL CHECK (actions >= 0),
  failures integer NOT NULL CHECK (failures >= 0),
  cost_usd numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  budgets jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, profile_id) REFERENCES swarm_agent_profiles(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX swarm_runs_scope ON swarm_runs(tenant_id, workspace_id, created_at DESC);

CREATE TABLE swarm_run_journal (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, run_id, seq),
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES swarm_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE swarm_model_evals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  model_id text NOT NULL,
  eval_id text NOT NULL,
  metrics jsonb NOT NULL,
  ran_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE swarm_prompt_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  prompt_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  purpose text NOT NULL,
  template text NOT NULL,
  required_capabilities jsonb NOT NULL DEFAULT '[]',
  output_contract jsonb,
  retired_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, prompt_id, version),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

-- swarm_night_shift is authority 'local' (sidecar-only, no server table until WP-CLOUD lease authority exists).

-- Runs, journal entries, evals and prompt versions are append-only. Retiring a
-- prompt appends a new version carrying retired_at; rows are never edited.
CREATE TRIGGER swarm_runs_immutable BEFORE UPDATE OR DELETE ON swarm_runs FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER swarm_run_journal_immutable BEFORE UPDATE OR DELETE ON swarm_run_journal FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER swarm_model_evals_immutable BEFORE UPDATE OR DELETE ON swarm_model_evals FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER swarm_prompt_versions_immutable BEFORE UPDATE OR DELETE ON swarm_prompt_versions FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();

ALTER TABLE swarm_agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_agent_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE swarm_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE swarm_run_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_run_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE swarm_model_evals ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_model_evals FORCE ROW LEVEL SECURITY;
ALTER TABLE swarm_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_prompt_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY swarm_agent_profiles_scope ON swarm_agent_profiles USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY swarm_runs_scope ON swarm_runs USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY swarm_run_journal_scope ON swarm_run_journal USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY swarm_model_evals_scope ON swarm_model_evals USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY swarm_prompt_versions_scope ON swarm_prompt_versions USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
