CREATE TABLE forge_projects (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200), description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','approved','active','blocked','review','complete','canceled')),
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_nodes (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  parent_id uuid, kind text NOT NULL CHECK (kind IN ('epic','spec','plan','wave','ticket','subtask')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500), description text NOT NULL DEFAULT '',
  state text NOT NULL, priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low')),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb, requirement_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb, owner_id uuid, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id) REFERENCES forge_projects(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, parent_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX forge_nodes_project_parent ON forge_nodes(tenant_id, workspace_id, project_id, parent_id, kind);

CREATE TABLE forge_specs (
  id text NOT NULL, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  template text NOT NULL, version integer NOT NULL CHECK (version > 0), title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','approved','superseded')),
  authority text NOT NULL CHECK (authority IN ('user','contract','architecture','system')),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb, supersedes jsonb NOT NULL DEFAULT '[]'::jsonb,
  requirement_ids jsonb NOT NULL DEFAULT '[]'::jsonb, frontmatter jsonb NOT NULL,
  body text NOT NULL, content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, project_id) REFERENCES forge_projects(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_context_manifests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, ticket_id uuid NOT NULL,
  budget_tokens integer NOT NULL CHECK (budget_tokens > 0), used_tokens integer NOT NULL CHECK (used_tokens BETWEEN 0 AND budget_tokens),
  items jsonb NOT NULL, omitted_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, ticket_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_approvals (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, epic_id uuid NOT NULL,
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, epic_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE TABLE forge_approval_decisions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, approval_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')), reason text NOT NULL,
  decided_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, approval_id) REFERENCES forge_approvals(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (approval_id)
);

CREATE TABLE forge_schedules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, epic_id uuid NOT NULL,
  approval_id uuid NOT NULL, state text NOT NULL CHECK (state IN ('queued','stopped','blocked','complete','failed')),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 2), max_budget_usd numeric(14,6) NOT NULL CHECK (max_budget_usd >= 0),
  spent_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0), resource_locks jsonb NOT NULL DEFAULT '[]'::jsonb,
  runnable_ticket_ids jsonb NOT NULL DEFAULT '[]'::jsonb, reason text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, epic_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, approval_id) REFERENCES forge_approvals(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_runs (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, schedule_id uuid NOT NULL,
  ticket_id uuid NOT NULL, state text NOT NULL CHECK (state IN ('queued','stopped','blocked','complete','failed','canceled')),
  external_execution boolean NOT NULL DEFAULT false CHECK (external_execution = false),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  FOREIGN KEY (tenant_id, workspace_id, schedule_id) REFERENCES forge_schedules(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, ticket_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_escalations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, ticket_id uuid NOT NULL,
  classification text NOT NULL CHECK (classification IN ('informational','material','critical')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000), evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_ticket_ids jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL CHECK (status IN ('open','resolved','rejected')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_by uuid, resolved_at timestamptz,
  FOREIGN KEY (tenant_id, workspace_id, ticket_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_findings (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, role text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','triaged','accepted','fixed','verified','waived')),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')), title text NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (jsonb_array_length(evidence_ids) > 0), affected_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1), reproduction text NOT NULL, remediation text NOT NULL, revalidation text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE forge_evidence (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, requirement_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('test','review','artifact','approval','migration','performance','security')),
  source text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), deterministic boolean NOT NULL,
  result text NOT NULL CHECK (result IN ('pass','fail','partial')), verified_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forge_evidence_requirement ON forge_evidence(tenant_id, workspace_id, requirement_id, verified_at DESC);

CREATE TABLE forge_gates (
  id text NOT NULL, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, requirement_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deterministic','human','ai-judgment')),
  status text NOT NULL CHECK (status IN ('pass','fail','pending','blocked')), hard boolean NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb, evaluated_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, id)
);

CREATE TABLE forge_promotions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40,64}$'),
  from_environment text NOT NULL CHECK (from_environment IN ('develop','staging','main')),
  to_environment text NOT NULL CHECK (to_environment IN ('develop','staging','main')),
  state text NOT NULL CHECK (state IN ('proposed','gates-passed','approved','promoted','rolled-back','rejected')),
  evidence_ids jsonb NOT NULL, missing_gate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_id uuid, rollback_of uuid, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, approval_id) REFERENCES forge_approvals(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, rollback_of) REFERENCES forge_promotions(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_adapter_configs (
  id text NOT NULL, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false CHECK (enabled = false),
  endpoint text, last_status text NOT NULL DEFAULT 'disabled' CHECK (last_status IN ('disabled','unavailable')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, workspace_id, id)
);

-- All Forge records use fail-closed workspace RLS; immutable logs reject mutation.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_projects','forge_nodes','forge_specs','forge_context_manifests','forge_approvals','forge_approval_decisions','forge_schedules','forge_runs','forge_escalations','forge_findings','forge_evidence','forge_gates','forge_promotions','forge_adapter_configs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true))', table_name || '_scope', table_name);
  END LOOP;
END $$;

-- Every domain row explicitly anchors its tenant/workspace to the platform owner row.
ALTER TABLE forge_approval_decisions ADD CONSTRAINT forge_approval_decisions_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_schedules ADD CONSTRAINT forge_schedules_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_runs ADD CONSTRAINT forge_runs_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_escalations ADD CONSTRAINT forge_escalations_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_findings ADD CONSTRAINT forge_findings_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_evidence ADD CONSTRAINT forge_evidence_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_gates ADD CONSTRAINT forge_gates_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_promotions ADD CONSTRAINT forge_promotions_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE forge_adapter_configs ADD CONSTRAINT forge_adapter_configs_workspace_fk FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;

CREATE FUNCTION forge_reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME; END;
$$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_context_manifests','forge_approvals','forge_approval_decisions','forge_runs','forge_escalations','forge_findings','forge_evidence','forge_gates','forge_promotions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()', table_name || '_immutable', table_name);
  END LOOP;
END $$;
