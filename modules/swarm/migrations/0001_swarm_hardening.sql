-- WP-SWARM review cycle 2 hardening on top of platform/0003_swarm (never edit an applied migration).

-- SWM-R-011: autonomy matches the contract's AutonomyLevel (0..4).
ALTER TABLE swarm_agent_profiles DROP CONSTRAINT swarm_agent_profiles_autonomy_level_check;
ALTER TABLE swarm_agent_profiles ADD CONSTRAINT swarm_agent_profiles_autonomy_level_check CHECK (autonomy_level BETWEEN 0 AND 4);

-- SWM-R-012: output_schema is a required profile field.
UPDATE swarm_agent_profiles SET output_schema = '{}'::jsonb WHERE output_schema IS NULL;
ALTER TABLE swarm_agent_profiles ALTER COLUMN output_schema SET NOT NULL;

-- New profiles default to the fail-closed approval policy; granting anything wider is a guarded write.
ALTER TABLE swarm_agent_profiles ALTER COLUMN approval_policy SET DEFAULT 'default.consequential';

-- SWM-R-003: the local app role can never write privilege-bearing or server-derived columns, whatever
-- its table grants. Creates must use the fail-closed defaults; updates must leave them unchanged.
CREATE FUNCTION swarm_profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF current_user <> 'xyra_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.capability_grants <> '[]'::jsonb
      OR NEW.autonomy_level <> 0
      OR NEW.secret_scopes <> '[]'::jsonb
      OR NEW.network_policy <> '{"mode":"none","allowedHosts":[]}'::jsonb
      OR NEW.filesystem_policy <> '{"mode":"none","allowedPaths":[]}'::jsonb
      OR NEW.approval_policy <> 'default.consequential'
      OR NEW.eval_history <> '[]'::jsonb THEN
      RAISE EXCEPTION 'guarded column write on %', TG_TABLE_NAME;
    END IF;
  ELSIF (NEW.capability_grants, NEW.autonomy_level, NEW.secret_scopes, NEW.network_policy,
         NEW.filesystem_policy, NEW.approval_policy, NEW.eval_history,
         NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM
        (OLD.capability_grants, OLD.autonomy_level, OLD.secret_scopes, OLD.network_policy,
         OLD.filesystem_policy, OLD.approval_policy, OLD.eval_history,
         OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'guarded column write on %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER swarm_agent_profiles_guard BEFORE INSERT OR UPDATE ON swarm_agent_profiles FOR EACH ROW EXECUTE FUNCTION swarm_profiles_guard();

-- Review probe (f): a run's start record is appended when it starts, so journal rows and child runs can
-- reference it while it is running. The terminal summary is a separate append-only outcome row.
CREATE TABLE swarm_run_outcomes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  termination text NOT NULL CHECK (termination IN ('COMPLETED','BUDGET_EXCEEDED','TIMEOUT','CANCELED','KILL_SWITCH','LEASE_LOST','NO_PROGRESS','CONCURRENCY_LIMIT','FAILED','DELEGATION_DENIED')),
  output text,
  iterations integer NOT NULL CHECK (iterations >= 0),
  actions integer NOT NULL CHECK (actions >= 0),
  failures integer NOT NULL CHECK (failures >= 0),
  cost_usd numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  ended_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, run_id),
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES swarm_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
INSERT INTO swarm_run_outcomes(id,tenant_id,workspace_id,run_id,termination,output,iterations,actions,failures,cost_usd,ended_at,created_by,created_at)
  SELECT id, tenant_id, workspace_id, id, termination, output, iterations, actions, failures, cost_usd, ended_at, created_by, created_at FROM swarm_runs;
ALTER TABLE swarm_runs DROP COLUMN termination, DROP COLUMN output, DROP COLUMN iterations, DROP COLUMN actions,
  DROP COLUMN failures, DROP COLUMN cost_usd, DROP COLUMN ended_at;

-- Review probe (e): a child run's parent must exist in the same tenant and workspace.
ALTER TABLE swarm_runs ADD CONSTRAINT swarm_runs_parent_fk
  FOREIGN KEY (tenant_id, workspace_id, parent_run_id) REFERENCES swarm_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT;

CREATE TRIGGER swarm_run_outcomes_immutable BEFORE UPDATE OR DELETE ON swarm_run_outcomes FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
ALTER TABLE swarm_run_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_run_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY swarm_run_outcomes_scope ON swarm_run_outcomes USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

-- SWM-R-014: the manifest's local Night Shift leash table. One row per workspace; never synced.
CREATE TABLE swarm_night_shift (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  max_runs integer NOT NULL CHECK (max_runs > 0),
  max_spend_usd numeric(14,6) NOT NULL CHECK (max_spend_usd >= 0),
  allowed_capability_ids jsonb NOT NULL DEFAULT '[]',
  autonomy_ceiling integer NOT NULL DEFAULT 0 CHECK (autonomy_ceiling BETWEEN 0 AND 4),
  state text NOT NULL DEFAULT 'IDLE' CHECK (state IN ('IDLE','RUNNING','MISSED','WAITING_FOR_LEASE','KILLED','COMPLETE')),
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  spent_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
ALTER TABLE swarm_night_shift ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm_night_shift FORCE ROW LEVEL SECURITY;
CREATE POLICY swarm_night_shift_scope ON swarm_night_shift USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
