-- Versioned controls and immutable governance records for PAPER investment workflows.
CREATE TABLE invest_market_sessions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  exchange_code text NOT NULL CHECK (length(exchange_code) BETWEEN 1 AND 32),
  session_date date NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  is_open boolean NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, exchange_code, session_date, source),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  CHECK (closes_at > opens_at)
);

CREATE TABLE invest_tax_lots (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  instrument_id uuid NOT NULL,
  opening_fill_id uuid NOT NULL,
  acquired_units numeric(38,0) NOT NULL CHECK (acquired_units > 0),
  remaining_units numeric(38,0) NOT NULL CHECK (remaining_units >= 0 AND remaining_units <= acquired_units),
  cost_basis_units numeric(38,0) NOT NULL CHECK (cost_basis_units >= 0),
  remaining_basis_units numeric(38,0) NOT NULL CHECK (remaining_basis_units >= 0 AND remaining_basis_units <= cost_basis_units),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,opening_fill_id),
  FOREIGN KEY (tenant_id,workspace_id,portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,instrument_id) REFERENCES invest_instruments(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,opening_fill_id) REFERENCES invest_fills(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  CHECK ((remaining_units=0) = (closed_at IS NOT NULL))
);
CREATE INDEX invest_tax_lots_fifo ON invest_tax_lots(tenant_id,workspace_id,portfolio_id,instrument_id,opened_at,id) WHERE remaining_units>0;

CREATE TABLE invest_tax_lot_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  fill_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('acquired','disposed')),
  quantity_units numeric(38,0) NOT NULL CHECK (quantity_units>0),
  basis_units numeric(38,0) NOT NULL CHECK (basis_units>=0),
  proceeds_units numeric(38,0) NOT NULL CHECK (proceeds_units>=0),
  realized_gain_units numeric(38,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,lot_id) REFERENCES invest_tax_lots(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,fill_id) REFERENCES invest_fills(tenant_id,workspace_id,id) ON DELETE RESTRICT
);

CREATE TABLE invest_portfolio_risk_state (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  risk_date date NOT NULL,
  day_open_nav_units numeric(38,0) NOT NULL CHECK (day_open_nav_units >= 0),
  high_water_nav_units numeric(38,0) NOT NULL CHECK (high_water_nav_units >= 0),
  daily_loss_units numeric(38,0) NOT NULL DEFAULT 0 CHECK (daily_loss_units >= 0),
  kill_switch boolean NOT NULL DEFAULT false,
  kill_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, portfolio_id, risk_date),
  FOREIGN KEY (tenant_id, workspace_id, portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  CHECK ((kill_switch AND kill_reason IS NOT NULL) OR NOT kill_switch)
);

CREATE TABLE invest_limit_changes (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  previous_limits jsonb NOT NULL CHECK (jsonb_typeof(previous_limits)='object'),
  proposed_limits jsonb NOT NULL CHECK (jsonb_typeof(proposed_limits)='object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,mandate_id) REFERENCES invest_mandates(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,approved_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE invest_ic_memos (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  portfolio_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  thesis text NOT NULL CHECK (length(thesis) BETWEEN 1 AND 20000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources)='array' AND jsonb_array_length(sources)>0),
  risk_review jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(risk_review)='object'),
  status text NOT NULL CHECK (status IN ('draft','in_review','approved','rejected','expired')),
  expires_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,portfolio_id,version),
  FOREIGN KEY (tenant_id,workspace_id,portfolio_id) REFERENCES invest_portfolios(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='approved') = (expires_at IS NOT NULL))
);

CREATE TABLE invest_ic_votes (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  memo_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  vote text NOT NULL CHECK (vote IN ('approve','reject','recuse')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  UNIQUE (tenant_id,workspace_id,memo_id,voter_id),
  FOREIGN KEY (tenant_id,workspace_id,memo_id) REFERENCES invest_ic_memos(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,voter_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE invest_ic_memo_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  memo_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('drafted','vote_recorded','approved','rejected','expired')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  actor_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,memo_id) REFERENCES invest_ic_memos(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,actor_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION invest_controls_scope(tenant_id uuid, workspace_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['invest_market_sessions','invest_tax_lots','invest_tax_lot_events','invest_portfolio_risk_state','invest_limit_changes','invest_ic_memos','invest_ic_votes','invest_ic_memo_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY %I ON %I USING (invest_controls_scope(tenant_id,workspace_id)) WITH CHECK (invest_controls_scope(tenant_id,workspace_id))', name || '_scope', name);
  END LOOP;
END $$;
CREATE TRIGGER invest_market_sessions_immutable BEFORE UPDATE OR DELETE ON invest_market_sessions FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_tax_lot_events_immutable BEFORE UPDATE OR DELETE ON invest_tax_lot_events FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_limit_changes_immutable BEFORE UPDATE OR DELETE ON invest_limit_changes FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_ic_memo_events_immutable BEFORE UPDATE OR DELETE ON invest_ic_memo_events FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
CREATE TRIGGER invest_ic_votes_immutable BEFORE UPDATE OR DELETE ON invest_ic_votes FOR EACH ROW EXECUTE FUNCTION invest_immutable_row();
