ALTER TABLE forge_nodes ADD COLUMN archived_at timestamptz;
ALTER TABLE forge_nodes ADD COLUMN archive_reason text;
ALTER TABLE forge_nodes ADD CONSTRAINT forge_nodes_archive_pair CHECK ((archived_at IS NULL AND archive_reason IS NULL) OR (archived_at IS NOT NULL AND length(archive_reason) BETWEEN 1 AND 4000));

CREATE TABLE forge_node_archive_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  node_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,node_id) REFERENCES forge_nodes(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX forge_node_archive_once ON forge_node_archive_events(tenant_id,workspace_id,node_id);
ALTER TABLE forge_node_archive_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_node_archive_events FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_node_archive_events_scope ON forge_node_archive_events USING (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
) WITH CHECK (
  tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true)
);
CREATE TRIGGER forge_node_archive_events_immutable BEFORE UPDATE OR DELETE ON forge_node_archive_events FOR EACH ROW EXECUTE FUNCTION forge_reject_immutable_mutation();
