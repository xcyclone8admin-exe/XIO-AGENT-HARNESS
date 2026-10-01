-- modules/data core schema. Every table is tenant+workspace scoped with RLS from this first
-- migration (REQ-DATA-002). Append-only tables use reject_append_mutation() defined in
-- packages/db/migrations/0001_platform.sql, and workspaces/users are defined there too.
CREATE TABLE data_datasets (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('sheet', 'derived')),
  deleted_hlc text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE data_sheet_cells (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index BETWEEN 0 AND 1000000),
  col_index integer NOT NULL CHECK (col_index BETWEEN 0 AND 16384),
  formula text,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, dataset_id, row_index, col_index),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, dataset_id) REFERENCES data_datasets(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX data_sheet_cells_scope_dataset ON data_sheet_cells(tenant_id, workspace_id, dataset_id);

CREATE TABLE data_pipelines (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  steps jsonb NOT NULL,
  schedule_cron text,
  schedule_enabled boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE data_pipeline_runs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, pipeline_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, pipeline_id) REFERENCES data_pipelines(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX data_pipeline_runs_scope_pipeline ON data_pipeline_runs(tenant_id, workspace_id, pipeline_id, started_at DESC);

CREATE TABLE data_lineage_edges (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  output_dataset_id uuid NOT NULL,
  input_dataset_id uuid,
  pipeline_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, output_dataset_id) REFERENCES data_datasets(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, input_dataset_id) REFERENCES data_datasets(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, pipeline_run_id) REFERENCES data_pipeline_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX data_lineage_edges_scope_output ON data_lineage_edges(tenant_id, workspace_id, output_dataset_id);

CREATE TABLE data_sql_audit_log (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  statement text NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  executed_by uuid NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, executed_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER data_lineage_edges_append_only BEFORE UPDATE OR DELETE ON data_lineage_edges
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER data_sql_audit_log_append_only BEFORE UPDATE OR DELETE ON data_sql_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();

-- DELETE on data_pipeline_runs is always rejected; UPDATE is allowed only for the trusted
-- data_pipeline_run capability role (see manifest serverWriteCapabilities) while the run is
-- still 'running', and never changes the row's identity columns. This gives checkpointing a
-- real path while keeping the run append-only (immutable) once it reaches a terminal status.
CREATE FUNCTION data_guard_pipeline_run_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'data pipeline run rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'completed' OR OLD.status = 'failed' THEN
    RAISE EXCEPTION 'data pipeline run is immutable once terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'data pipeline run identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_pipeline_runs_guard BEFORE UPDATE OR DELETE ON data_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION data_guard_pipeline_run_mutation();

ALTER TABLE data_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sheet_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_lineage_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_sql_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_datasets FORCE ROW LEVEL SECURITY;
ALTER TABLE data_sheet_cells FORCE ROW LEVEL SECURITY;
ALTER TABLE data_pipelines FORCE ROW LEVEL SECURITY;
ALTER TABLE data_pipeline_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE data_lineage_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE data_sql_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY data_datasets_scope ON data_datasets USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY data_sheet_cells_scope ON data_sheet_cells USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY data_pipelines_scope ON data_pipelines USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY data_pipeline_runs_scope ON data_pipeline_runs USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY data_lineage_edges_scope ON data_lineage_edges USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY data_sql_audit_log_scope ON data_sql_audit_log USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
