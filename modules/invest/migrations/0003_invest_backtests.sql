CREATE TABLE invest_backtest_datasets (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  data_version integer NOT NULL CHECK (data_version > 0),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 120),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  bars jsonb NOT NULL CHECK (jsonb_typeof(bars)='array' AND jsonb_array_length(bars) BETWEEN 2 AND 10000),
  data_hash text NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,instrument_id,data_version),
  FOREIGN KEY (tenant_id,workspace_id,instrument_id) REFERENCES invest_instruments(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE invest_backtest_strategies (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  strategy_key text NOT NULL CHECK (length(strategy_key) BETWEEN 1 AND 120),
  strategy_version integer NOT NULL CHECK (strategy_version > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  strategy_hash text NOT NULL CHECK (strategy_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,strategy_key,strategy_version),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE invest_backtest_runs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  strategy_id uuid NOT NULL,
  engine_version text NOT NULL CHECK (engine_version='momentum-next-bar-v1'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  total_fees_units numeric(38,0) NOT NULL CHECK (total_fees_units>=0),
  net_pnl_units numeric(38,0) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,dataset_id,strategy_id),
  FOREIGN KEY (tenant_id,workspace_id,dataset_id) REFERENCES invest_backtest_datasets(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,strategy_id) REFERENCES invest_backtest_strategies(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['invest_backtest_datasets','invest_backtest_strategies','invest_backtest_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY %I ON %I USING (invest_controls_scope(tenant_id,workspace_id)) WITH CHECK (invest_controls_scope(tenant_id,workspace_id))',name||'_scope',name);
  END LOOP;
END $$;
CREATE TRIGGER invest_backtest_datasets_immutable BEFORE UPDATE OR DELETE ON invest_backtest_datasets FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_backtest_strategies_immutable BEFORE UPDATE OR DELETE ON invest_backtest_strategies FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_backtest_runs_immutable BEFORE UPDATE OR DELETE ON invest_backtest_runs FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
