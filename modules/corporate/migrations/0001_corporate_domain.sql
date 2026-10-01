CREATE TABLE corporate_entities (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, legal_name text NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 240), jurisdiction text NOT NULL, registration_number text, entity_type text NOT NULL CHECK(entity_type IN ('corporation','llc','partnership','trust','other')), parent_entity_id uuid, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','dissolved','inactive')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,workspace_id,parent_entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_ownership (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid NOT NULL, owner_entity_id uuid, owner_ref text, ownership_bps integer NOT NULL CHECK(ownership_bps BETWEEN 0 AND 10000), valid_from date NOT NULL, valid_to date, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((owner_entity_id IS NOT NULL) <> (owner_ref IS NOT NULL)), CHECK(valid_to IS NULL OR valid_to>=valid_from),
 FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,workspace_id,owner_entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_officers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid NOT NULL, person_ref text NOT NULL, title text NOT NULL, starts_on date NOT NULL, ends_on date, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_board_meetings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid NOT NULL, title text NOT NULL, scheduled_at timestamptz NOT NULL, quorum integer NOT NULL CHECK(quorum>0), status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','held','cancelled')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT, UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_resolutions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, title text NOT NULL, body text NOT NULL, votes_for integer NOT NULL DEFAULT 0 CHECK(votes_for>=0), votes_against integer NOT NULL DEFAULT 0 CHECK(votes_against>=0), votes_abstain integer NOT NULL DEFAULT 0 CHECK(votes_abstain>=0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')), adopted_at timestamptz, content_hash text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,meeting_id) REFERENCES corporate_board_meetings(tenant_id,workspace_id,id) ON DELETE RESTRICT,
 CHECK((status='draft' AND content_hash IS NULL) OR (status<>'draft' AND content_hash ~ '^[a-f0-9]{64}$')),
 UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_minutes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, meeting_id uuid NOT NULL, body text NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), approved_at timestamptz NOT NULL, approved_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,meeting_id) REFERENCES corporate_board_meetings(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_policies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, policy_key text NOT NULL, version integer NOT NULL CHECK(version>0), title text NOT NULL, body text NOT NULL, effective_on date NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT, UNIQUE(workspace_id,policy_key,version), UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_attestations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, policy_id uuid NOT NULL, person_ref text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','attested','declined')), responded_at timestamptz, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,policy_id) REFERENCES corporate_policies(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_policy_exceptions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, policy_id uuid NOT NULL, subject_ref text NOT NULL, reason text NOT NULL, expires_on date, status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','denied','expired')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,policy_id) REFERENCES corporate_policies(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_okrs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, parent_id uuid, title text NOT NULL, owner_ref text NOT NULL, scope text NOT NULL CHECK(scope IN ('company','department','agent')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','complete','cancelled')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,workspace_id,parent_id) REFERENCES corporate_okrs(tenant_id,workspace_id,id) ON DELETE RESTRICT, UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_key_results (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, objective_id uuid NOT NULL, title text NOT NULL, baseline numeric(38,6) NOT NULL, target numeric(38,6) NOT NULL, current_value numeric(38,6) NOT NULL, unit text NOT NULL, linked_ref text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(target<>baseline), FOREIGN KEY(tenant_id,workspace_id,objective_id) REFERENCES corporate_okrs(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_compliance_items (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid, title text NOT NULL, jurisdiction text NOT NULL, due_on date NOT NULL, owner_ref text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','complete','overdue')), evidence_ref text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_controls (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, control_key text NOT NULL, title text NOT NULL, owner_ref text NOT NULL, evidence_ref text, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','effective','deficient')), next_review_on date, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT, UNIQUE(workspace_id,control_key)
);
CREATE TABLE corporate_people (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, person_ref text NOT NULL, display_name text NOT NULL, node_kind text NOT NULL DEFAULT 'person' CHECK(node_kind IN ('person','agent','team')), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT, UNIQUE(workspace_id,person_ref), UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_reporting_lines (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, person_id uuid NOT NULL, manager_id uuid NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(person_id<>manager_id),
 FOREIGN KEY(tenant_id,workspace_id,person_id) REFERENCES corporate_people(tenant_id,workspace_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,workspace_id,manager_id) REFERENCES corporate_people(tenant_id,workspace_id,id) ON DELETE RESTRICT, UNIQUE(workspace_id,person_id)
);
CREATE TABLE corporate_share_classes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid NOT NULL, name text NOT NULL, authorized_units numeric(38,0) NOT NULL CHECK(authorized_units>=0), unit_scale integer NOT NULL DEFAULT 0 CHECK(unit_scale BETWEEN 0 AND 18), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT, UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE corporate_equity_grants (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, share_class_id uuid NOT NULL, holder_ref text NOT NULL, granted_units numeric(38,0) NOT NULL CHECK(granted_units>=0), vested_units numeric(38,0) NOT NULL DEFAULT 0 CHECK(vested_units>=0), vest_start date, vest_end date, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(vested_units<=granted_units), CHECK(vest_end IS NULL OR vest_start IS NULL OR vest_end>=vest_start), FOREIGN KEY(tenant_id,workspace_id,share_class_id) REFERENCES corporate_share_classes(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE corporate_approval_policies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, entity_id uuid, capability_pattern text NOT NULL, threshold_units numeric(38,0), asset text, approver_refs text[] NOT NULL CHECK(cardinality(approver_refs)>0), minimum_approvers integer NOT NULL DEFAULT 1 CHECK(minimum_approvers>0), enabled boolean NOT NULL DEFAULT true, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX corporate_entities_scope ON corporate_entities(tenant_id,workspace_id,legal_name);
CREATE INDEX corporate_compliance_due ON corporate_compliance_items(tenant_id,workspace_id,due_on) WHERE status NOT IN ('complete','submitted');
CREATE INDEX corporate_attestation_pending ON corporate_attestations(tenant_id,workspace_id,policy_id) WHERE status='pending';
CREATE INDEX corporate_audit_scope ON audit_events(tenant_id,workspace_id,occurred_at DESC);
CREATE OR REPLACE FUNCTION corporate_reject_append_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'approved corporate records are immutable'; END $$;
CREATE TRIGGER corporate_minutes_immutable BEFORE UPDATE OR DELETE ON corporate_minutes FOR EACH ROW EXECUTE FUNCTION corporate_reject_append_mutation();
CREATE TRIGGER corporate_resolution_immutable BEFORE UPDATE OR DELETE ON corporate_resolutions FOR EACH ROW WHEN (OLD.status<>'draft') EXECUTE FUNCTION corporate_reject_append_mutation();
ALTER TABLE corporate_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_entities_scope ON corporate_entities USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_ownership_scope ON corporate_ownership USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_officers FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_officers_scope ON corporate_officers USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_board_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_board_meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_board_meetings_scope ON corporate_board_meetings USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_resolutions_scope ON corporate_resolutions USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_minutes FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_minutes_scope ON corporate_minutes USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_policies_scope ON corporate_policies USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_attestations_scope ON corporate_attestations USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_policy_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_policy_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_policy_exceptions_scope ON corporate_policy_exceptions USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_okrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_okrs FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_okrs_scope ON corporate_okrs USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_key_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_key_results FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_key_results_scope ON corporate_key_results USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_compliance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_compliance_items FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_compliance_items_scope ON corporate_compliance_items USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_controls_scope ON corporate_controls USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_people FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_people_scope ON corporate_people USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_reporting_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_reporting_lines_scope ON corporate_reporting_lines USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_share_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_share_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_share_classes_scope ON corporate_share_classes USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_equity_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_equity_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_equity_grants_scope ON corporate_equity_grants USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
ALTER TABLE corporate_approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_approval_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_approval_policies_scope ON corporate_approval_policies USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);

CREATE TABLE corporate_intercompany_links (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, correlation_id uuid NOT NULL, from_entity_id uuid NOT NULL, to_entity_id uuid NOT NULL, effective_on date NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(from_entity_id<>to_entity_id), FOREIGN KEY(tenant_id,workspace_id,from_entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT, FOREIGN KEY(tenant_id,workspace_id,to_entity_id) REFERENCES corporate_entities(tenant_id,workspace_id,id) ON DELETE RESTRICT, UNIQUE(workspace_id,correlation_id)
);
ALTER TABLE corporate_intercompany_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_intercompany_links FORCE ROW LEVEL SECURITY;
CREATE POLICY corporate_intercompany_links_scope ON corporate_intercompany_links USING (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid AND workspace_id=current_setting('app.workspace_id',true)::uuid);
CREATE OR REPLACE FUNCTION corporate_validate_ownership_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE existing_bps integer;
BEGIN
  PERFORM 1 FROM corporate_entities WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND id=NEW.entity_id FOR UPDATE;
  SELECT COALESCE(SUM(ownership_bps),0) INTO existing_bps FROM corporate_ownership WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND entity_id=NEW.entity_id AND valid_to IS NULL;
  IF NEW.valid_to IS NULL AND existing_bps + NEW.ownership_bps > 10000 THEN RAISE EXCEPTION 'ownership exceeds 100 percent'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER corporate_ownership_total BEFORE INSERT ON corporate_ownership FOR EACH ROW EXECUTE FUNCTION corporate_validate_ownership_total();
