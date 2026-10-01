ALTER TABLE forge_nodes ADD COLUMN evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE forge_schedules DROP CONSTRAINT forge_schedules_state_check;
ALTER TABLE forge_schedules ADD CONSTRAINT forge_schedules_state_check CHECK (state IN ('queued','stopped','blocked','complete','failed','canceled'));
ALTER TABLE forge_schedules ADD COLUMN blocked_ticket_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE forge_evidence ADD CONSTRAINT forge_evidence_scope_id UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE forge_findings ADD CONSTRAINT forge_findings_scope_id UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE forge_runs DROP CONSTRAINT forge_runs_pkey;
ALTER TABLE forge_runs ADD CONSTRAINT forge_runs_pkey PRIMARY KEY (tenant_id, workspace_id, id);
ALTER TABLE forge_runs ADD CONSTRAINT forge_runs_scope_id UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE forge_runs ADD CONSTRAINT forge_runs_schedule_ticket_unique UNIQUE (tenant_id, workspace_id, schedule_id, ticket_id, state);

CREATE TABLE forge_node_evidence (
  tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, ticket_id uuid NOT NULL, evidence_id uuid NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, ticket_id, evidence_id),
  FOREIGN KEY (tenant_id, workspace_id, ticket_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, evidence_id) REFERENCES forge_evidence(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE forge_finding_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, finding_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('triaged','accepted','fixed','verified','waived','open')),
  detail text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, finding_id) REFERENCES forge_findings(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['forge_node_evidence','forge_finding_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true) AND workspace_id::text = current_setting(''app.workspace_id'', true))', table_name || '_scope', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation()', table_name || '_immutable', table_name);
  END LOOP;
END $$;
