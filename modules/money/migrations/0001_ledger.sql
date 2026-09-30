-- Shared ledger schema. Keep every externally referenced key and column additive-only (ADR-0016).
-- Tenant and workspace identifiers repeat through every relationship so one tenant cannot point
-- into another tenant's otherwise-guessable UUID rows.
CREATE TABLE ledger_assets (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._:-]{0,31}$'),
  scale integer NOT NULL CHECK (scale BETWEEN 0 AND 18),
  kind text NOT NULL CHECK (kind IN ('fiat', 'crypto', 'security', 'unit')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, code),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE ledger_books (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  base_asset text NOT NULL,
  owner_module text NOT NULL CHECK (owner_module IN ('money', 'invest', 'studio', 'corporate')),
  purpose text NOT NULL CHECK (purpose IN ('business', 'fund', 'portfolio', 'production', 'entity')),
  subject_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_hlc text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, id, environment),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, base_asset)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT
);

CREATE TABLE ledger_accounts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_hlc text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, id, book_id, environment),
  UNIQUE (tenant_id, workspace_id, book_id, code),
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE ledger_transactions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  effective_date date NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  correlation_id uuid,
  reverses_id uuid,
  posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, id, book_id, environment),
  UNIQUE (tenant_id, workspace_id, reverses_id),
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, reverses_id, book_id, environment)
    REFERENCES ledger_transactions(tenant_id, workspace_id, id, book_id, environment)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX ledger_transactions_scope_date
  ON ledger_transactions(tenant_id, workspace_id, environment, book_id, effective_date DESC, id DESC);
CREATE INDEX ledger_transactions_correlation
  ON ledger_transactions(tenant_id, workspace_id, correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE ledger_entries (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 499),
  book_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  account_id uuid NOT NULL,
  asset text NOT NULL CHECK (asset ~ '^[A-Z0-9][A-Z0-9._:-]{0,31}$'),
  units numeric(38, 0) NOT NULL CHECK (units <> 0),
  memo text CHECK (memo IS NULL OR length(memo) <= 500),
  external_ref text CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, transaction_id, line_no),
  UNIQUE (tenant_id, workspace_id, account_id, external_ref),
  FOREIGN KEY (tenant_id, workspace_id, transaction_id, book_id, environment)
    REFERENCES ledger_transactions(tenant_id, workspace_id, id, book_id, environment)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, workspace_id, book_id)
    REFERENCES ledger_books(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, account_id, book_id, environment)
    REFERENCES ledger_accounts(tenant_id, workspace_id, id, book_id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, asset)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX ledger_entries_scope_account_asset
  ON ledger_entries(tenant_id, workspace_id, book_id, environment, account_id, asset, created_at DESC);

CREATE TABLE ledger_balances (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  account_id uuid NOT NULL,
  asset text NOT NULL,
  units numeric(38, 0) NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  as_of_hlc text NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, workspace_id, account_id, asset),
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, account_id, book_id, environment)
    REFERENCES ledger_accounts(tenant_id, workspace_id, id, book_id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, asset)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT
);
CREATE INDEX ledger_balances_scope_book ON ledger_balances(tenant_id, workspace_id, environment, book_id);

CREATE TABLE ledger_reconciliation_runs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  book_id uuid,
  run_key text NOT NULL CHECK (length(run_key) BETWEEN 1 AND 200),
  checked_balances integer NOT NULL CHECK (checked_balances >= 0),
  discrepancy_count integer NOT NULL CHECK (discrepancy_count >= 0),
  status text NOT NULL CHECK (status IN ('clean', 'discrepancies')),
  started_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, workspace_id, environment, book_id, run_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE ledger_discrepancies (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid,
  kind text NOT NULL CHECK (kind IN ('balance_mismatch', 'missing_balance', 'orphan_balance', 'duplicate_import')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved')),
  owner_id uuid,
  environment text NOT NULL CHECK (environment IN ('actual', 'paper', 'live')),
  book_id uuid NOT NULL,
  account_id uuid,
  asset text,
  expected_units numeric(38, 0),
  recorded_units numeric(38, 0),
  external_ref text,
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 2000),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, run_id) REFERENCES ledger_reconciliation_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, book_id, environment)
    REFERENCES ledger_books(tenant_id, workspace_id, id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, account_id, book_id, environment)
    REFERENCES ledger_accounts(tenant_id, workspace_id, id, book_id, environment) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, asset)
    REFERENCES ledger_assets(tenant_id, workspace_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX ledger_discrepancies_scope_status
  ON ledger_discrepancies(tenant_id, workspace_id, environment, status, created_at DESC);

-- Reject mutation of every journal table. The app role receives no DELETE grant, and the trigger
-- also protects against accidental writes made by an owner-context service.
CREATE TRIGGER ledger_assets_immutable BEFORE UPDATE OR DELETE ON ledger_assets
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER ledger_reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON ledger_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();

CREATE FUNCTION ledger_guard_book_identity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.base_asset IS DISTINCT FROM OLD.base_asset
    OR NEW.owner_module IS DISTINCT FROM OLD.owner_module
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
  THEN
    RAISE EXCEPTION 'ledger book identity is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_books_guard_identity BEFORE UPDATE ON ledger_books
  FOR EACH ROW EXECUTE FUNCTION ledger_guard_book_identity();

CREATE FUNCTION ledger_guard_account_identity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.book_id IS DISTINCT FROM OLD.book_id
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.code IS DISTINCT FROM OLD.code
  THEN
    RAISE EXCEPTION 'ledger account identity is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_accounts_guard_identity BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_guard_account_identity();

CREATE FUNCTION ledger_reject_live_posting() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.environment = 'live' THEN
    RAISE EXCEPTION 'LIVE_TRADING_DISABLED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_transactions_live_disabled BEFORE INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_live_posting();

-- Entries update this workspace-local projection in the same database transaction.
CREATE FUNCTION ledger_project_entry_balance() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  entry_hlc text := COALESCE(NULLIF(current_setting('app.hlc', true), ''), '');
BEGIN
  INSERT INTO ledger_balances (
    tenant_id, workspace_id, book_id, environment, account_id, asset, units, entry_count, as_of_hlc
  ) VALUES (
    NEW.tenant_id, NEW.workspace_id, NEW.book_id, NEW.environment, NEW.account_id, NEW.asset,
    NEW.units, 1, entry_hlc
  )
  ON CONFLICT (tenant_id, workspace_id, account_id, asset) DO UPDATE SET
    units = ledger_balances.units + EXCLUDED.units,
    entry_count = ledger_balances.entry_count + 1,
    as_of_hlc = GREATEST(ledger_balances.as_of_hlc, EXCLUDED.as_of_hlc);
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_project_balance AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_project_entry_balance();

-- The composite FKs reject cross-book/environment/account entries independently of this trigger.
-- These deferred checks additionally require two entries and a zero sum for every asset at commit.
CREATE FUNCTION ledger_check_transaction() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  tx_id uuid;
  tx_tenant uuid;
  tx_workspace uuid;
  entry_total bigint;
  imbalance_count bigint;
BEGIN
  tx_id := NEW.id;
  tx_tenant := NEW.tenant_id;
  tx_workspace := NEW.workspace_id;

  SELECT
    (SELECT count(*) FROM ledger_entries
      WHERE tenant_id = tx_tenant AND workspace_id = tx_workspace AND transaction_id = tx_id),
    (SELECT count(*) FROM (
      SELECT sum(units) AS total_units
      FROM ledger_entries
      WHERE tenant_id = tx_tenant AND workspace_id = tx_workspace AND transaction_id = tx_id
      GROUP BY asset
    ) per_asset WHERE total_units <> 0)
    INTO entry_total, imbalance_count;

  IF entry_total < 2 THEN
    RAISE EXCEPTION 'TOO_FEW_ENTRIES' USING ERRCODE = '23514';
  END IF;
  IF imbalance_count <> 0 THEN
    RAISE EXCEPTION 'UNBALANCED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction();

-- Explicit deferred environment check complements the environment-bearing composite FKs.
CREATE FUNCTION ledger_check_transaction_environment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  tx_id uuid;
  tx_tenant uuid;
  tx_workspace uuid;
  bad_entries bigint;
BEGIN
  tx_id := NEW.id;
  tx_tenant := NEW.tenant_id;
  tx_workspace := NEW.workspace_id;
  SELECT count(*) INTO bad_entries
  FROM ledger_entries e
  JOIN ledger_transactions t
    ON t.tenant_id = e.tenant_id AND t.workspace_id = e.workspace_id AND t.id = e.transaction_id
  WHERE e.tenant_id = tx_tenant AND e.workspace_id = tx_workspace AND e.transaction_id = tx_id
    AND (e.book_id <> t.book_id OR e.environment <> t.environment);
  IF bad_entries <> 0 THEN
    RAISE EXCEPTION 'CROSS_ENVIRONMENT' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transactions_environment
  AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_environment();

-- The local sidecar and Neon app role see only the active tenant/workspace context.
ALTER TABLE ledger_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_books FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_reconciliation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_discrepancies FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_assets_scope ON ledger_assets USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_books_scope ON ledger_books USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_accounts_scope ON ledger_accounts USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_transactions_scope ON ledger_transactions USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_entries_scope ON ledger_entries USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_balances_scope ON ledger_balances USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_reconciliation_runs_scope ON ledger_reconciliation_runs USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY ledger_discrepancies_scope ON ledger_discrepancies USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
