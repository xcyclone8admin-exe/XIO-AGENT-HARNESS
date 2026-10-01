-- Cloud-authorized, fenced two-phase source erasure. No provider deletion is local.
ALTER TABLE brain_source_erasures
  DROP CONSTRAINT brain_source_erasures_status_check,
  DROP CONSTRAINT brain_source_erasures_tenant_id_workspace_id_source_id_key;
ALTER TABLE brain_source_erasures ADD CONSTRAINT brain_source_erasures_status_check CHECK (status IN (
  'waiting_cloud','cloud_request_pending','eligible','purge_claimed','local_purged_ack_pending',
  'complete','retained_shared','retained_hold','unavailable','eligibility_expired',
  'eligibility_invalidated','retryable_failure','terminal_failure','abort_pending','aborted'
));
ALTER TABLE brain_source_erasures
  ADD COLUMN protocol_version text NOT NULL DEFAULT 'cloud-erasure-v1',
  ADD COLUMN attempt_id uuid,
  ADD COLUMN source_version text,
  ADD COLUMN cloud_operation_id uuid,
  ADD COLUMN cloud_request_digest text,
  ADD COLUMN cloud_attempt_no integer CHECK (cloud_attempt_no IS NULL OR cloud_attempt_no > 0),
  ADD COLUMN reservation_id uuid,
  ADD COLUMN reference_state_version text,
  ADD COLUMN hold_state_version text,
  ADD COLUMN reservation_expires_at timestamptz,
  ADD COLUMN claim_id uuid,
  ADD COLUMN claim_generation bigint CHECK (claim_generation IS NULL OR claim_generation > 0),
  ADD COLUMN local_purge_receipt_id uuid,
  ADD COLUMN local_purge_receipt_digest text,
  ADD COLUMN no_purge_abort_receipt_id uuid,
  ADD COLUMN no_purge_abort_receipt_digest text,
  ADD COLUMN cloud_audit_receipt_id uuid;
CREATE UNIQUE INDEX brain_source_erasure_attempt_id ON brain_source_erasures(tenant_id,workspace_id,attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX brain_source_erasure_cloud_operation ON brain_source_erasures(tenant_id,workspace_id,cloud_operation_id) WHERE cloud_operation_id IS NOT NULL;

ALTER TABLE brain_source_erasure_attempts DROP CONSTRAINT brain_source_erasure_attempts_outcome_check;
ALTER TABLE brain_source_erasure_attempts ADD CONSTRAINT brain_source_erasure_attempts_outcome_check CHECK (outcome IN (
  'waiting_cloud','cloud_request_pending','eligible','purge_claimed','local_purged_ack_pending',
  'complete','retained_shared','retained_hold','unavailable','eligibility_expired',
  'eligibility_invalidated','retryable_failure','terminal_failure','abort_pending','aborted'
));

ALTER TABLE brain_sources ADD COLUMN cloud_object_ref_ids jsonb CHECK(cloud_object_ref_ids IS NULL OR jsonb_typeof(cloud_object_ref_ids)='array');
-- Full BRAIN-declared object-ref snapshots are only candidates until Cloud issues a receipt.
-- They are local retry state, not authority to delete Cloud objects.
CREATE TABLE brain_source_blob_reference_sets (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, source_id uuid NOT NULL,
  source_version_id uuid NOT NULL, content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  ingestion_id uuid, object_ref_ids jsonb CHECK(object_ref_ids IS NULL OR jsonb_typeof(object_ref_ids)='array'),
  status text NOT NULL CHECK(status IN ('unknown','pending','verified_nonempty','verified_empty','unavailable','invalidated')),
  cloud_snapshot_id uuid, source_version text CHECK(source_version IS NULL OR source_version ~ '^cloud-ingest-v2:sha256:[0-9a-f]{64}$'), reference_state_version bigint CHECK(reference_state_version IS NULL OR reference_state_version>0),
  reference_set_digest text CHECK(reference_set_digest IS NULL OR reference_set_digest ~ '^[0-9a-f]{64}$'), finalized_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20), last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,source_version_id)
);
ALTER TABLE brain_source_blob_reference_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_blob_reference_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_blob_reference_sets_scope ON brain_source_blob_reference_sets USING
  (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
  CREATE INDEX brain_source_blob_reference_pending ON brain_source_blob_reference_sets(tenant_id,workspace_id,updated_at,id) WHERE status NOT IN ('verified_nonempty','verified_empty');

CREATE TABLE brain_source_erasure_receipts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, erasure_id uuid NOT NULL,
  attempt_id uuid NOT NULL, operation_id uuid, source_id uuid NOT NULL, receipt_kind text NOT NULL CHECK (receipt_kind IN ('local_purge','no_purge_abort')),
  source_version text NOT NULL, claim_id uuid, claim_generation bigint,
  record_counts jsonb NOT NULL CHECK (jsonb_typeof(record_counts)='object'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,erasure_id) REFERENCES brain_source_erasures(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,erasure_id,receipt_kind),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE brain_source_erasure_outbox (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, erasure_id uuid NOT NULL,
  attempt_id uuid NOT NULL, operation_id uuid NOT NULL, receipt_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('local_ack','abort')), attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
  delivered_at timestamptz, last_error_code text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,erasure_id) REFERENCES brain_source_erasures(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,receipt_id) REFERENCES brain_source_erasure_receipts(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,erasure_id,attempt_id,event_type),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE brain_source_erasure_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, erasure_id uuid NOT NULL,
  attempt_id uuid NOT NULL, operation_id uuid, event_type text NOT NULL, cloud_status text,
  request_digest text, reservation_id uuid, reference_state_version text, hold_state_version text,
  claim_id uuid, claim_generation bigint, audit_receipt_id uuid, response_digest text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'), occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,erasure_id) REFERENCES brain_source_erasures(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX brain_erasure_outbox_pending ON brain_source_erasure_outbox(tenant_id,workspace_id,next_attempt_at,id) WHERE delivered_at IS NULL;
CREATE INDEX brain_erasure_events_page ON brain_source_erasure_events(tenant_id,workspace_id,erasure_id,occurred_at DESC,id DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_cap_brain_erasure') THEN
    CREATE ROLE xyra_cap_brain_erasure NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION brain_erasure_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role_name text := current_setting('role',true);
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF role_name <> 'xyra_cap_brain_erasure' THEN
      RAISE EXCEPTION 'erasure status requires verified server capability workflow';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM brain_source_erasure_attempts a WHERE a.tenant_id=NEW.tenant_id AND a.workspace_id=NEW.workspace_id
        AND a.erasure_id=NEW.id AND a.outcome=NEW.status AND a.audit_reference IS NOT NULL
    ) THEN RAISE EXCEPTION 'erasure status requires matching audit evidence'; END IF;
  END IF;
  IF NEW.status='complete' AND (NEW.completion_receipt IS NULL OR NEW.completed_at IS NULL OR NEW.local_purge_receipt_id IS NULL OR NEW.cloud_audit_receipt_id IS NULL) THEN
    RAISE EXCEPTION 'completed erasure requires local and Cloud completion evidence';
  END IF;
  IF OLD.status='purge_claimed' AND NEW.status='aborted' AND EXISTS (
    SELECT 1 FROM brain_source_erasure_receipts r WHERE r.tenant_id=OLD.tenant_id AND r.workspace_id=OLD.workspace_id
      AND r.erasure_id=OLD.id AND r.receipt_kind='local_purge'
  ) THEN RAISE EXCEPTION 'purged erasure must replay local acknowledgement, not abort'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION brain_reject_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('role',true)='xyra_cap_brain_erasure' AND current_setting('xyra.brain_erasure_purge',true)='1'
    AND TG_TABLE_NAME IN ('brain_source_versions','brain_chunks','brain_signals','brain_claims','brain_promotions','brain_facts','brain_contradictions') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME;
END $$;

CREATE OR REPLACE FUNCTION brain_purge_source(
  p_erasure_id uuid, p_source_id uuid, p_attempt_id uuid, p_source_version text, p_claim_id uuid, p_claim_generation bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  t uuid := current_setting('app.tenant_id',true)::uuid;
  w uuid := current_setting('app.workspace_id',true)::uuid;
  op brain_source_erasures%ROWTYPE;
  before_counts jsonb;
  deleted_counts jsonb := '{}'::jsonb;
  n bigint;
BEGIN
  IF current_setting('role',true) <> 'xyra_cap_brain_erasure' THEN RAISE EXCEPTION 'BRAIN_ERASURE_CAPABILITY_REQUIRED'; END IF;
  SELECT * INTO op FROM brain_source_erasures WHERE tenant_id=t AND workspace_id=w AND id=p_erasure_id FOR UPDATE;
  IF NOT FOUND OR op.source_id<>p_source_id OR op.attempt_id<>p_attempt_id OR op.status<>'purge_claimed'
    OR op.source_version<>p_source_version OR op.claim_id<>p_claim_id OR op.claim_generation<>p_claim_generation THEN
    RAISE EXCEPTION 'BRAIN_ERASURE_CLAIM_MISMATCH';
  END IF;
  PERFORM 1 FROM brain_sources WHERE tenant_id=t AND workspace_id=w AND id=p_source_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BRAIN_ERASURE_SOURCE_MISSING'; END IF;
  IF EXISTS (SELECT 1 FROM brain_source_erasure_receipts WHERE tenant_id=t AND workspace_id=w AND erasure_id=p_erasure_id AND receipt_kind='no_purge_abort') THEN
    RAISE EXCEPTION 'BRAIN_ERASURE_ABORT_ALREADY_COMMITTED';
  END IF;
  PERFORM set_config('xyra.brain_erasure_purge','1',true);
  before_counts := jsonb_build_object(
    'brain_sources',(SELECT count(*) FROM brain_sources WHERE tenant_id=t AND workspace_id=w AND id=p_source_id),
    'brain_source_versions',(SELECT count(*) FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id),
    'brain_chunks',(SELECT count(*) FROM brain_chunks WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id),
    'brain_signals',(SELECT count(*) FROM brain_signals WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id),
    'brain_claims',(SELECT count(*) FROM brain_claims c JOIN brain_signals s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id WHERE c.tenant_id=t AND c.workspace_id=w AND s.source_id=p_source_id),
    'brain_promotions',(SELECT count(*) FROM brain_promotions p JOIN brain_claims c ON c.tenant_id=p.tenant_id AND c.workspace_id=p.workspace_id AND c.id=p.claim_id JOIN brain_signals s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id WHERE p.tenant_id=t AND p.workspace_id=w AND s.source_id=p_source_id),
    'brain_facts',(SELECT count(*) FROM brain_facts f JOIN brain_claims c ON c.tenant_id=f.tenant_id AND c.workspace_id=f.workspace_id AND c.id=f.claim_id JOIN brain_signals s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id WHERE f.tenant_id=t AND f.workspace_id=w AND s.source_id=p_source_id),
    'brain_contradictions',(SELECT count(*) FROM brain_contradictions c WHERE c.tenant_id=t AND c.workspace_id=w AND (c.claim_id IN (SELECT x.id FROM brain_claims x JOIN brain_signals s ON s.tenant_id=x.tenant_id AND s.workspace_id=x.workspace_id AND s.id=x.signal_id WHERE s.source_id=p_source_id) OR c.fact_id IN (SELECT f.id FROM brain_facts f JOIN brain_claims x ON x.tenant_id=f.tenant_id AND x.workspace_id=f.workspace_id AND x.id=f.claim_id JOIN brain_signals s ON s.tenant_id=x.tenant_id AND s.workspace_id=x.workspace_id AND s.id=x.signal_id WHERE s.source_id=p_source_id))),
    'brain_memories',(SELECT count(*) FROM brain_memories WHERE tenant_id=t AND workspace_id=w AND (source_id=p_source_id OR source_version_id IN (SELECT id FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id))),
    'object_edges',(SELECT jsonb_array_length(external_blob_refs) FROM brain_sources WHERE tenant_id=t AND workspace_id=w AND id=p_source_id),
    'index_rows',(SELECT count(*) FROM brain_chunks WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id),
    'blob_reference_sets',(SELECT count(*) FROM brain_source_blob_reference_sets WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id)
  );
  UPDATE brain_facts SET supersedes_id=NULL WHERE tenant_id=t AND workspace_id=w AND supersedes_id IN (
    SELECT f.id FROM brain_facts f JOIN brain_claims c ON c.tenant_id=f.tenant_id AND c.workspace_id=f.workspace_id AND c.id=f.claim_id
    JOIN brain_signals s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id WHERE s.source_id=p_source_id
  ) AND id NOT IN (
    SELECT f.id FROM brain_facts f JOIN brain_claims c ON c.tenant_id=f.tenant_id AND c.workspace_id=f.workspace_id AND c.id=f.claim_id
    JOIN brain_signals s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id WHERE s.source_id=p_source_id
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('detached_fact_links',n);
  UPDATE brain_memories SET supersedes_id=NULL WHERE tenant_id=t AND workspace_id=w AND supersedes_id IN (
    SELECT id FROM brain_memories WHERE tenant_id=t AND workspace_id=w AND (source_id=p_source_id OR source_version_id IN (SELECT id FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id))
  ) AND id NOT IN (SELECT id FROM brain_memories WHERE tenant_id=t AND workspace_id=w AND (source_id=p_source_id OR source_version_id IN (SELECT id FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id)));
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('detached_memory_links',n);
  DELETE FROM brain_contradictions c WHERE c.tenant_id=t AND c.workspace_id=w AND (c.claim_id IN (
    SELECT x.id FROM brain_claims x JOIN brain_signals s ON s.tenant_id=x.tenant_id AND s.workspace_id=x.workspace_id AND s.id=x.signal_id WHERE s.source_id=p_source_id
  ) OR c.fact_id IN (
    SELECT f.id FROM brain_facts f JOIN brain_claims x ON x.tenant_id=f.tenant_id AND x.workspace_id=f.workspace_id AND x.id=f.claim_id
    JOIN brain_signals s ON s.tenant_id=x.tenant_id AND s.workspace_id=x.workspace_id AND s.id=x.signal_id WHERE s.source_id=p_source_id
  ));
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_contradictions',n);
  DELETE FROM brain_facts f USING brain_claims c,brain_signals s WHERE f.tenant_id=t AND f.workspace_id=w AND c.tenant_id=f.tenant_id AND c.workspace_id=f.workspace_id AND c.id=f.claim_id AND s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id AND s.source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_facts',n);
  DELETE FROM brain_promotions p USING brain_claims c,brain_signals s WHERE p.tenant_id=t AND p.workspace_id=w AND c.tenant_id=p.tenant_id AND c.workspace_id=p.workspace_id AND c.id=p.claim_id AND s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id AND s.source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_promotions',n);
  DELETE FROM brain_claims c USING brain_signals s WHERE c.tenant_id=t AND c.workspace_id=w AND s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id AND s.id=c.signal_id AND s.source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_claims',n);
  DELETE FROM brain_memories WHERE tenant_id=t AND workspace_id=w AND (source_id=p_source_id OR source_version_id IN (SELECT id FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id));
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_memories',n);
  DELETE FROM brain_signals WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_signals',n);
  DELETE FROM brain_chunks WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_chunks',n);
  DELETE FROM brain_source_versions WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_source_versions',n);
  DELETE FROM brain_source_blob_reference_sets WHERE tenant_id=t AND workspace_id=w AND source_id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('blob_reference_sets',n);
  DELETE FROM brain_sources WHERE tenant_id=t AND workspace_id=w AND id=p_source_id;
  GET DIAGNOSTICS n = ROW_COUNT; deleted_counts := deleted_counts || jsonb_build_object('brain_sources',n);
  deleted_counts := deleted_counts || jsonb_build_object('object_edges',0,'index_rows',0);
  RETURN jsonb_build_object('before',before_counts,'deleted',deleted_counts,'after',jsonb_build_object(
    'brain_sources',0,'brain_source_versions',0,'brain_chunks',0,'brain_signals',0,'brain_claims',0,
    'brain_promotions',0,'brain_facts',0,'brain_contradictions',0,'brain_memories',0,'object_edges',0,'index_rows',0,'blob_reference_sets',0));
END $$;
REVOKE ALL ON FUNCTION brain_purge_source(uuid,uuid,uuid,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_purge_source(uuid,uuid,uuid,text,uuid,bigint) TO xyra_cap_brain_erasure;

ALTER TABLE brain_source_erasure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_erasure_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_erasure_receipts_scope ON brain_source_erasure_receipts USING
 (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
ALTER TABLE brain_source_erasure_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_erasure_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_erasure_outbox_scope ON brain_source_erasure_outbox USING
 (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
ALTER TABLE brain_source_erasure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_erasure_events FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_erasure_events_scope ON brain_source_erasure_events USING
 (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE TRIGGER brain_erasure_receipts_immutable BEFORE UPDATE OR DELETE ON brain_source_erasure_receipts FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_erasure_events_immutable BEFORE UPDATE OR DELETE ON brain_source_erasure_events FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
