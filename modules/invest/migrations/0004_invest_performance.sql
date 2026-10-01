CREATE TABLE invest_performance_marks (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  nav_units numeric(38,0) NOT NULL CHECK (nav_units > 0),
  cash_units numeric(38,0) NOT NULL,
  benchmark_index_units numeric(38,0) NOT NULL CHECK (benchmark_index_units > 0),
  benchmark_source text NOT NULL CHECK (length(benchmark_source) BETWEEN 1 AND 120),
  benchmark_ref text NOT NULL CHECK (length(benchmark_ref) BETWEEN 1 AND 500),
  external_flow_units numeric(38,0) NOT NULL DEFAULT 0,
  cumulative_fee_units numeric(38,0) NOT NULL DEFAULT 0 CHECK (cumulative_fee_units >= 0),
  created_by uuid NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX invest_performance_marks_timeline ON invest_performance_marks(tenant_id,workspace_id,portfolio_id,captured_at,id);

CREATE TABLE invest_performance_reports (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  from_mark_id uuid NOT NULL,
  to_mark_id uuid NOT NULL,
  calculation_version text NOT NULL CHECK (calculation_version='invest-twr-fixed-v1'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,from_mark_id,to_mark_id),
  FOREIGN KEY (tenant_id,workspace_id,portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,from_mark_id) REFERENCES invest_performance_marks(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,to_mark_id) REFERENCES invest_performance_marks(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK (from_mark_id<>to_mark_id)
);

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['invest_performance_marks','invest_performance_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON %I USING (invest_controls_scope(tenant_id,workspace_id)) WITH CHECK (invest_controls_scope(tenant_id,workspace_id))',name||'_scope',name);
  END LOOP;
END $$;
CREATE TRIGGER invest_performance_marks_immutable BEFORE UPDATE OR DELETE ON invest_performance_marks FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_performance_reports_immutable BEFORE UPDATE OR DELETE ON invest_performance_reports FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
