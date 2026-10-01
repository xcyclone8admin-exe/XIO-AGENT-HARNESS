-- Invest-owned PAPER trading records. Ledger position rows remain the source of truth.
-- Every foreign key repeats tenant/workspace scope; all removals are tombstones or reversals.

CREATE TABLE invest_instruments (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  asset_code text NOT NULL,
  symbol text NOT NULL CHECK (symbol = upper(symbol) AND length(symbol) BETWEEN 1 AND 32),
  asset_class text NOT NULL CHECK (asset_class IN ('equity', 'crypto', 'fixed_income', 'fund')),
  quantity_scale integer NOT NULL CHECK (quantity_scale BETWEEN 0 AND 18),
  exchange_code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, symbol),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, asset_code)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT
);

CREATE TABLE invest_portfolios (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  book_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'paper' CHECK (environment = 'paper'),
  base_asset text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_hlc text,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, book_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_asset)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE invest_mandates (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'expired', 'revoked')),
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, portfolio_id, version),
  FOREIGN KEY (tenant_id, workspace_id, portfolio_id)
    REFERENCES invest_portfolios(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE invest_restricted_rules (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('restricted', 'watch')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, instrument_id, version),
  FOREIGN KEY (tenant_id, workspace_id, instrument_id)
    REFERENCES invest_instruments(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE invest_market_prices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  price_units numeric(38, 0) NOT NULL CHECK (price_units > 0),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  source_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  volatility_bps integer NOT NULL CHECK (volatility_bps BETWEEN 0 AND 1000000),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, instrument_id, source, payload_hash),
  FOREIGN KEY (tenant_id, workspace_id, instrument_id)
    REFERENCES invest_instruments(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX invest_market_prices_latest
  ON invest_market_prices(tenant_id, workspace_id, instrument_id, received_at DESC, id DESC);

CREATE TABLE invest_risk_decisions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  order_id uuid,
  allowed boolean NOT NULL,
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  quote_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  evaluated_by uuid NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, portfolio_id)
    REFERENCES invest_portfolios(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, instrument_id)
    REFERENCES invest_instruments(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, mandate_id)
    REFERENCES invest_mandates(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, quote_id)
    REFERENCES invest_market_prices(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, evaluated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE invest_orders (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  risk_decision_id uuid NOT NULL,
  environment text NOT NULL DEFAULT 'paper' CHECK (environment = 'paper'),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type text NOT NULL CHECK (order_type IN ('market', 'limit')),
  quantity_units numeric(38, 0) NOT NULL CHECK (quantity_units > 0),
  limit_price_units numeric(38, 0) CHECK (limit_price_units IS NULL OR limit_price_units > 0),
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'submitted', 'partially_filled', 'filled', 'cancelled', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_hlc text,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id, portfolio_id)
    REFERENCES invest_portfolios(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, instrument_id)
    REFERENCES invest_instruments(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, mandate_id)
    REFERENCES invest_mandates(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, risk_decision_id)
    REFERENCES invest_risk_decisions(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((order_type = 'limit') = (limit_price_units IS NOT NULL))
);
CREATE INDEX invest_orders_status ON invest_orders(tenant_id, workspace_id, status, created_at DESC);

CREATE TABLE invest_order_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  order_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('proposed', 'approved', 'rejected', 'submitted', 'partial_fill', 'filled', 'cancelled', 'expired')),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('proposed', 'approved', 'rejected', 'submitted', 'partially_filled', 'filled', 'cancelled', 'expired')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, order_id)
    REFERENCES invest_orders(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE invest_fills (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  order_id uuid NOT NULL,
  quantity_units numeric(38, 0) NOT NULL CHECK (quantity_units > 0),
  price_units numeric(38, 0) NOT NULL CHECK (price_units > 0),
  fee_units numeric(38, 0) NOT NULL DEFAULT 0 CHECK (fee_units >= 0),
  execution_ref text NOT NULL CHECK (length(execution_ref) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, execution_ref),
  FOREIGN KEY (tenant_id, workspace_id, order_id)
    REFERENCES invest_orders(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE invest_breaches (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  instrument_id uuid,
  severity text NOT NULL CHECK (severity IN ('warning', 'high', 'critical')),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_by uuid NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, portfolio_id)
    REFERENCES invest_portfolios(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, instrument_id)
    REFERENCES invest_instruments(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE FUNCTION invest_check_portfolio_book() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_books b
    WHERE b.tenant_id = NEW.tenant_id AND b.workspace_id = NEW.workspace_id
      AND b.id = NEW.book_id AND b.environment = 'paper'
      AND b.owner_module = 'invest' AND b.purpose = 'portfolio'
  ) THEN RAISE EXCEPTION 'invest portfolio requires its own PAPER portfolio book'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invest_portfolios_book_guard BEFORE INSERT OR UPDATE OF book_id, tenant_id, workspace_id
  ON invest_portfolios FOR EACH ROW EXECUTE FUNCTION invest_check_portfolio_book();

CREATE FUNCTION invest_check_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN RAISE EXCEPTION 'orders must start proposed'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected', 'cancelled', 'expired')) OR
    (OLD.status = 'approved' AND NEW.status IN ('submitted', 'cancelled', 'expired')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('partially_filled', 'filled', 'cancelled', 'expired')) OR
    (OLD.status = 'partially_filled' AND NEW.status IN ('partially_filled', 'filled', 'cancelled', 'expired'))
  ) THEN RAISE EXCEPTION 'invalid order state transition: % -> %', OLD.status, NEW.status; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER invest_orders_transition BEFORE INSERT OR UPDATE OF status
  ON invest_orders FOR EACH ROW EXECUTE FUNCTION invest_check_order_transition();

CREATE FUNCTION invest_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Invest audit rows are append-only'; END $$;
CREATE TRIGGER invest_mandates_immutable BEFORE UPDATE OR DELETE ON invest_mandates FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_restricted_rules_immutable BEFORE UPDATE OR DELETE ON invest_restricted_rules FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_market_prices_immutable BEFORE UPDATE OR DELETE ON invest_market_prices FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_risk_decisions_immutable BEFORE UPDATE OR DELETE ON invest_risk_decisions FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_order_events_immutable BEFORE UPDATE OR DELETE ON invest_order_events FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_fills_immutable BEFORE UPDATE OR DELETE ON invest_fills FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();

CREATE FUNCTION invest_scope_matches(tenant_id uuid, workspace_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY[
    'invest_instruments', 'invest_portfolios', 'invest_mandates', 'invest_restricted_rules',
    'invest_market_prices', 'invest_risk_decisions', 'invest_orders', 'invest_order_events',
    'invest_fills', 'invest_breaches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY %I ON %I USING (invest_scope_matches(tenant_id, workspace_id)) WITH CHECK (invest_scope_matches(tenant_id, workspace_id))', name || '_scope', name);
  END LOOP;
END $$;

-- Runtime grants are applied after migrations from manifest authority/class declarations.
