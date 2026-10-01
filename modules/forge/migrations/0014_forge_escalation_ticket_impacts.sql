CREATE TABLE forge_escalation_ticket_impacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  escalation_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  prior_state text NOT NULL CHECK (prior_state IN ('ready','queued','running','review')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, escalation_id, ticket_id),
  FOREIGN KEY (tenant_id, workspace_id, escalation_id) REFERENCES forge_escalations(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, ticket_id) REFERENCES forge_nodes(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX forge_escalation_ticket_impacts_ticket ON forge_escalation_ticket_impacts(tenant_id, workspace_id, ticket_id);
ALTER TABLE forge_escalation_ticket_impacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_escalation_ticket_impacts FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_escalation_ticket_impacts_scope ON forge_escalation_ticket_impacts
  USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE TRIGGER forge_escalation_ticket_impacts_immutable BEFORE UPDATE OR DELETE ON forge_escalation_ticket_impacts
  FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
