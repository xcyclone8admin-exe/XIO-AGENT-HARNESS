CREATE TABLE studio_productions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  format text NOT NULL CHECK (format IN ('film','video','content','campaign')),
  phase text NOT NULL DEFAULT 'development' CHECK (phase IN ('development','pre-production','production','post','delivery','release')),
  owner_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE TABLE studio_production_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  from_phase text,
  to_phase text NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE TABLE studio_budget_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  account_code text NOT NULL,
  asset text NOT NULL DEFAULT 'USD',
  planned_units numeric(38,0) NOT NULL CHECK (planned_units >= 0),
  committed_units numeric(38,0) NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  overage_threshold_bps integer NOT NULL DEFAULT 0 CHECK (overage_threshold_bps BETWEEN 0 AND 100000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE studio_schedule_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('phase','shoot_day','milestone')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE TABLE studio_schedule_dependencies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (item_id <> depends_on_id),
  FOREIGN KEY (tenant_id, workspace_id, item_id) REFERENCES studio_schedule_items(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, depends_on_id) REFERENCES studio_schedule_items(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, item_id, depends_on_id)
);
CREATE TABLE studio_crew_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  person_ref text NOT NULL,
  role text NOT NULL CHECK (length(role) BETWEEN 1 AND 120),
  rate_units numeric(38,0) NOT NULL CHECK (rate_units >= 0),
  asset text NOT NULL DEFAULT 'USD',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  nda_status text NOT NULL DEFAULT 'unknown' CHECK (nda_status IN ('unknown','pending','signed','declined')),
  release_status text NOT NULL DEFAULT 'unknown' CHECK (release_status IN ('unknown','pending','signed','declined')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE studio_rights (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  subject text NOT NULL,
  territory text NOT NULL,
  starts_on date NOT NULL,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','restricted','expired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on >= starts_on),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE TABLE studio_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  r2_key text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  rights_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, rights_id) REFERENCES studio_rights(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, production_id, content_hash),
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE TABLE studio_deliverables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  production_id uuid NOT NULL,
  asset_id uuid,
  distributor text NOT NULL,
  spec_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending-approval','approved','delivered','blocked')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, production_id) REFERENCES studio_productions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, asset_id) REFERENCES studio_assets(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX studio_productions_scope ON studio_productions(tenant_id,workspace_id,created_at DESC);
CREATE INDEX studio_schedule_window ON studio_schedule_items(tenant_id,workspace_id,starts_at,ends_at);
CREATE INDEX studio_crew_window ON studio_crew_assignments(tenant_id,workspace_id,person_ref,starts_at,ends_at);
CREATE INDEX studio_rights_expiry ON studio_rights(tenant_id,workspace_id,expires_on) WHERE status='cleared';
CREATE OR REPLACE FUNCTION studio_reject_append_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only studio history'; END $$;
CREATE TRIGGER studio_history_immutable BEFORE UPDATE OR DELETE ON studio_production_history FOR EACH ROW EXECUTE FUNCTION studio_reject_append_mutation();
ALTER TABLE studio_productions ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_productions FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_productions_scope ON studio_productions USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_production_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_production_history FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_production_history_scope ON studio_production_history USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_budget_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_budget_lines_scope ON studio_budget_lines USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_schedule_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_schedule_items FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_schedule_items_scope ON studio_schedule_items USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_schedule_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_schedule_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_schedule_dependencies_scope ON studio_schedule_dependencies USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_crew_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_crew_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_crew_assignments_scope ON studio_crew_assignments USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_rights ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_rights FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_rights_scope ON studio_rights USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_assets_scope ON studio_assets USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE studio_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_deliverables FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_deliverables_scope ON studio_deliverables USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
