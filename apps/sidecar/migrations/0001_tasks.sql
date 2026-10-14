-- Local host orchestration. These relations are not synced or exposed as module tools.
CREATE TABLE host_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, actor_id, request_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE host_task_events (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence>0),
  event jsonb NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,task_id,sequence),
  FOREIGN KEY (tenant_id,workspace_id,task_id) REFERENCES host_tasks(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE host_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE host_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_task_events FORCE ROW LEVEL SECURITY;
CREATE POLICY host_tasks_scope ON host_tasks USING
  (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE POLICY host_task_events_scope ON host_task_events USING
  (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE TRIGGER host_task_events_immutable BEFORE UPDATE OR DELETE ON host_task_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
