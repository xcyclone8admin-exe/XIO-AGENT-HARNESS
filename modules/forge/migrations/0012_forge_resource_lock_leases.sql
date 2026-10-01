CREATE TABLE forge_resource_lock_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 256),
  owner_schedule_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active','released')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, owner_schedule_id) REFERENCES forge_schedules(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND released_at IS NULL) OR (status = 'released' AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX forge_resource_lock_active_unique
  ON forge_resource_lock_leases(tenant_id, workspace_id, resource_key)
  WHERE status = 'active';
CREATE INDEX forge_resource_lock_owner
  ON forge_resource_lock_leases(tenant_id, workspace_id, owner_schedule_id, status);

ALTER TABLE forge_resource_lock_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge_resource_lock_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY forge_resource_lock_leases_scope ON forge_resource_lock_leases
  USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
