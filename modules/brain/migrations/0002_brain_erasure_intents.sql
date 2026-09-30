-- A durable, approved erasure intent. No blob deletion is performed here: the CLOUD
-- reference-check/deletion/audit contract is not yet available, so these stay pending.
ALTER TABLE brain_sources ADD COLUMN external_blob_refs jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(external_blob_refs)='array');

CREATE TABLE brain_source_erasures (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, source_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('waiting_cloud','retryable_failure','local_purge_pending','complete')),
  requested_by uuid NOT NULL, approval_request_id uuid NOT NULL, approval_input_hash text NOT NULL,
  retention_policy text NOT NULL, external_blob_refs jsonb NOT NULL CHECK(jsonb_typeof(external_blob_refs)='array'),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), completion_receipt text,
  last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,source_id)
);
CREATE UNIQUE INDEX brain_source_erasure_idempotency ON brain_source_erasures(tenant_id,workspace_id,approval_request_id,approval_input_hash);
CREATE TABLE brain_source_erasure_attempts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, erasure_id uuid NOT NULL,
  actor_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN ('waiting_cloud','retryable_failure','local_purge_pending','complete')),
  checked_blob_refs jsonb NOT NULL DEFAULT '[]'::jsonb, deleted_blob_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  retention_policy text NOT NULL, audit_reference text, error_code text, occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,erasure_id) REFERENCES brain_source_erasures(tenant_id,workspace_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION brain_erasure_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF current_user <> 'xyra_server' THEN
      RAISE EXCEPTION 'erasure status requires privileged server workflow';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM brain_source_erasure_attempts a WHERE a.tenant_id=NEW.tenant_id AND a.workspace_id=NEW.workspace_id
        AND a.erasure_id=NEW.id AND a.outcome=NEW.status AND a.audit_reference IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'erasure status requires matching audit evidence';
    END IF;
  END IF;
  IF NEW.status = 'complete' AND (NEW.completion_receipt IS NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'completed erasure requires completion evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_source_erasure_state_guard BEFORE UPDATE ON brain_source_erasures FOR EACH ROW EXECUTE FUNCTION brain_erasure_state_guard();
CREATE FUNCTION brain_erasure_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME; END $$;
CREATE TRIGGER brain_erasure_attempts_immutable BEFORE UPDATE OR DELETE ON brain_source_erasure_attempts FOR EACH ROW EXECUTE FUNCTION brain_erasure_attempt_immutable();

ALTER TABLE brain_source_erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_erasures FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_erasures_scope ON brain_source_erasures USING
  (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
ALTER TABLE brain_source_erasure_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_source_erasure_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY brain_source_erasure_attempts_scope ON brain_source_erasure_attempts USING
  (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND workspace_id::text=current_setting('app.workspace_id',true));
CREATE INDEX brain_source_erasures_pending ON brain_source_erasures(tenant_id,workspace_id,updated_at,id) WHERE status<>'complete';
