-- GROWTH module tables: contacts, companies, deals, sequences, funnels, content, ads, brand deals.
-- Foundational objects (reject_append_mutation, workspaces) are owned by platform.

CREATE TABLE growth_companies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  domain text CHECK (length(domain) <= 253),
  industry text CHECK (length(industry) <= 100),
  size_band text CHECK (size_band IN ('1-10','11-50','51-200','201-1000','1001+')),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_companies_scope ON growth_companies(tenant_id, workspace_id, name);

CREATE TABLE growth_contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  email text CHECK (length(email) <= 320),
  phone text CHECK (length(phone) <= 30),
  company_id uuid,
  segment text CHECK (length(segment) <= 100),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, company_id) REFERENCES growth_companies(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_contacts_scope ON growth_contacts(tenant_id, workspace_id, name);

CREATE TABLE growth_deals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  contact_id uuid,
  company_id uuid,
  pipeline text NOT NULL CHECK (length(pipeline) <= 100),
  stage text NOT NULL CHECK (length(stage) <= 100),
  value_cents integer,
  currency text CHECK (length(currency) <= 3),
  expected_close_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, contact_id) REFERENCES growth_contacts(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, company_id) REFERENCES growth_companies(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_deals_scope_pipeline ON growth_deals(tenant_id, workspace_id, pipeline, stage, created_at DESC);

CREATE TABLE growth_sequences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  send_approval_policy text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_sequences_scope ON growth_sequences(tenant_id, workspace_id, status, created_at DESC);

CREATE TABLE growth_sequence_enrollments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sequence_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  send_approval_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id, sequence_id) REFERENCES growth_sequences(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, contact_id) REFERENCES growth_contacts(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX growth_sequence_enrollments_scope ON growth_sequence_enrollments(tenant_id, workspace_id, sequence_id, created_at DESC);

CREATE TABLE growth_funnels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('neural','radial','linear')),
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_funnels_scope ON growth_funnels(tenant_id, workspace_id, created_at DESC);

CREATE TABLE growth_content_posts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body text NOT NULL,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','failed')),
  publish_approval_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_content_posts_scope ON growth_content_posts(tenant_id, workspace_id, status, scheduled_at DESC);

CREATE TABLE growth_ad_campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  platform text NOT NULL CHECK (platform IN ('google','meta','linkedin','tiktok','other')),
  autonomy_mode text NOT NULL DEFAULT 'manual' CHECK (autonomy_mode IN ('manual','supervised','autonomous')),
  daily_budget_cents integer,
  total_budget_cents integer,
  currency text CHECK (length(currency) <= 3),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  spend_approval_policy text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_ad_campaigns_scope ON growth_ad_campaigns(tenant_id, workspace_id, status, created_at DESC);

CREATE TABLE growth_brand_deals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  partner_name text NOT NULL CHECK (length(partner_name) BETWEEN 1 AND 300),
  partner_contact text CHECK (length(partner_contact) <= 320),
  value_cents integer,
  currency text CHECK (length(currency) <= 3),
  deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'prospecting' CHECK (status IN ('prospecting','negotiating','active','completed','cancelled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX growth_brand_deals_scope ON growth_brand_deals(tenant_id, workspace_id, status, created_at DESC);

ALTER TABLE growth_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_funnels ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_content_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_brand_deals ENABLE ROW LEVEL SECURITY;

ALTER TABLE growth_companies FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_deals FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_sequences FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_sequence_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_funnels FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_content_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_ad_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_brand_deals FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_companies_scope ON growth_companies USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_contacts_scope ON growth_contacts USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_deals_scope ON growth_deals USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_sequences_scope ON growth_sequences USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_sequence_enrollments_scope ON growth_sequence_enrollments USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_funnels_scope ON growth_funnels USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_content_posts_scope ON growth_content_posts USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_ad_campaigns_scope ON growth_ad_campaigns USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY growth_brand_deals_scope ON growth_brand_deals USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

CREATE TRIGGER growth_sequence_enrollments_immutable BEFORE UPDATE OR DELETE ON growth_sequence_enrollments
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
