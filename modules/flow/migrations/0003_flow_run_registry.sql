-- flow_runs.run_id is a logical run identifier repeated across every lifecycle event row for that
-- run (0001's comment on flow_runs says so explicitly) — it has no unique constraint of its own,
-- so flow_checkpoints.run_id's manifest `references: { table: 'flow_runs' }` was never backed by a
-- real foreign key. This adds the durable per-run identity that reference should have pointed at,
-- backfills it from existing data, and wires real composite FKs from every table that holds a
-- run_id (additive; ADR-0016).

CREATE TABLE flow_run_registry (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, run_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, workflow_id) REFERENCES flow_workflows(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

-- Backfill: one registry row per existing logical run, derived from its earliest (trigger) event.
INSERT INTO flow_run_registry (tenant_id, workspace_id, run_id, workflow_id, trigger, created_by, created_at)
SELECT DISTINCT ON (tenant_id, workspace_id, run_id)
  tenant_id, workspace_id, run_id, workflow_id, trigger, created_by, created_at
FROM flow_runs
ORDER BY tenant_id, workspace_id, run_id, created_at ASC;

ALTER TABLE flow_run_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_run_registry_scope ON flow_run_registry USING (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true)
);

-- Every existing run now has a registry row; add the real composite FKs the manifest declares.
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_run_registry_fk
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES flow_run_registry(tenant_id, workspace_id, run_id) ON DELETE RESTRICT;
ALTER TABLE flow_checkpoints ADD CONSTRAINT flow_checkpoints_run_registry_fk
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES flow_run_registry(tenant_id, workspace_id, run_id) ON DELETE RESTRICT;
ALTER TABLE flow_approvals ADD CONSTRAINT flow_approvals_run_registry_fk
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES flow_run_registry(tenant_id, workspace_id, run_id) ON DELETE RESTRICT;
