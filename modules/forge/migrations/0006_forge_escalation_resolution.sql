ALTER TABLE forge_escalations ADD CONSTRAINT forge_escalations_scope_id UNIQUE (tenant_id,workspace_id,id);

CREATE TABLE forge_escalation_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  escalation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('resolved','rejected')),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 4000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,escalation_id) REFERENCES forge_escalations(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE forge_escalation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_escalation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_escalation_events_scope ON forge_escalation_events USING (
  tenant_id::text = current_setting('app.tenant_id',true) AND workspace_id::text = current_setting('app.workspace_id',true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id',true) AND workspace_id::text = current_setting('app.workspace_id',true)
);
CREATE TRIGGER forge_escalation_events_immutable BEFORE UPDATE OR DELETE ON forge_escalation_events FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
