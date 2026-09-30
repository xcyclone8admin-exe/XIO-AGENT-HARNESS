-- BRAIN records keep source evidence and truth history in the same tenant/workspace.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE brain_sources (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
  source_type text NOT NULL CHECK (length(source_type) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500), uri text,
  trust_level text NOT NULL CHECK (trust_level IN ('untrusted','user','reviewed','authoritative')),
  retention text NOT NULL DEFAULT 'workspace', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id)
);
CREATE TABLE brain_source_versions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, source_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), content_hash text NOT NULL CHECK(length(content_hash) BETWEEN 32 AND 128),
  content_type text NOT NULL, content_text text, captured_at timestamptz NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,source_id) REFERENCES brain_sources(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,source_id,version), UNIQUE (tenant_id,workspace_id,id,source_id)
);
CREATE TABLE brain_chunks (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, source_id uuid NOT NULL, source_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal >= 0), content_hash text NOT NULL, content_text text NOT NULL,
  embedding vector, embedding_model text, embedding_version text, dim integer CHECK(dim IS NULL OR dim > 0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,source_id) REFERENCES brain_sources(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_version_id) REFERENCES brain_source_versions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_version_id,source_id) REFERENCES brain_source_versions(tenant_id,workspace_id,id,source_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,source_version_id,ordinal),
  CHECK ((embedding IS NULL AND embedding_model IS NULL AND embedding_version IS NULL AND dim IS NULL) OR
         (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_version IS NOT NULL AND dim IS NOT NULL))
);
CREATE TABLE brain_signals (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, source_id uuid NOT NULL, source_version_id uuid NOT NULL, chunk_id uuid,
  signal_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,source_id) REFERENCES brain_sources(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_version_id) REFERENCES brain_source_versions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_version_id,source_id) REFERENCES brain_source_versions(tenant_id,workspace_id,id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,chunk_id) REFERENCES brain_chunks(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id)
);
CREATE TABLE brain_claims (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, signal_id uuid NOT NULL,
  subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, confidence numeric(7,6) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  effective_from timestamptz NOT NULL, effective_to timestamptz CHECK(effective_to IS NULL OR effective_to > effective_from),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,signal_id) REFERENCES brain_signals(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id)
);
CREATE TABLE brain_promotions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, claim_id uuid NOT NULL, reviewer_id uuid NOT NULL,
  authority_type text NOT NULL CHECK(authority_type IN ('reviewer','policy')), authority_ref text NOT NULL, reason text NOT NULL CHECK(length(reason)>0),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,claim_id) REFERENCES brain_claims(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,claim_id)
);
CREATE TABLE brain_facts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, claim_id uuid NOT NULL,
  subject text NOT NULL, predicate text NOT NULL, object text NOT NULL, confidence numeric(7,6) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  effective_from timestamptz NOT NULL, effective_to timestamptz CHECK(effective_to IS NULL OR effective_to > effective_from),
  supersedes_id uuid, promotion_id uuid NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,claim_id) REFERENCES brain_claims(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,supersedes_id) REFERENCES brain_facts(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,promotion_id) REFERENCES brain_promotions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,claim_id)
);
CREATE TABLE brain_contradictions (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, claim_id uuid NOT NULL, fact_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('open','resolved','dismissed')), resolution text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,claim_id) REFERENCES brain_claims(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,fact_id) REFERENCES brain_facts(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,claim_id,fact_id)
);
CREATE TABLE brain_memories (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
  memory_type text NOT NULL CHECK(memory_type IN ('preference','fact','project_state','decision','procedure','tool_knowledge','historical_outcome')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300), content text NOT NULL CHECK(length(content)>0), source_id uuid, source_version_id uuid,
  confidence numeric(7,6) CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1), importance numeric(7,6) CHECK(importance IS NULL OR importance BETWEEN 0 AND 1),
  effective_from timestamptz, effective_to timestamptz CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from), supersedes_id uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_id) REFERENCES brain_sources(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,source_version_id) REFERENCES brain_source_versions(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,supersedes_id) REFERENCES brain_memories(tenant_id,workspace_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id)
);
CREATE TABLE brain_procedures (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, procedure_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  title text NOT NULL, procedure_type text NOT NULL CHECK(procedure_type IN ('skill','sop','xyra_pattern')), body text NOT NULL,
  status text NOT NULL CHECK(status IN ('candidate','approved','rejected')), source_run_id uuid, reviewed_by uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,procedure_id,version),
  CHECK ((status='approved' AND reviewed_by IS NOT NULL) OR (status<>'approved' AND reviewed_by IS NULL))
);

CREATE INDEX brain_sources_scope ON brain_sources(tenant_id,workspace_id,created_at DESC);
CREATE INDEX brain_chunks_scope ON brain_chunks(tenant_id,workspace_id,source_id,source_version_id);
CREATE INDEX brain_chunks_text ON brain_chunks USING gin(to_tsvector('english',content_text));
CREATE INDEX brain_claims_subject ON brain_claims(tenant_id,workspace_id,subject,predicate,effective_from DESC);
CREATE INDEX brain_facts_asof ON brain_facts(tenant_id,workspace_id,subject,predicate,effective_from,effective_to);
CREATE INDEX brain_memories_type ON brain_memories(tenant_id,workspace_id,memory_type,updated_at DESC);

CREATE FUNCTION brain_reject_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only relation %', TG_TABLE_NAME; END $$;
CREATE TRIGGER brain_versions_immutable BEFORE UPDATE OR DELETE ON brain_source_versions FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_chunks_immutable BEFORE UPDATE OR DELETE ON brain_chunks FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_signals_immutable BEFORE UPDATE OR DELETE ON brain_signals FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_claims_immutable BEFORE UPDATE OR DELETE ON brain_claims FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_promotions_immutable BEFORE UPDATE OR DELETE ON brain_promotions FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_facts_immutable BEFORE UPDATE OR DELETE ON brain_facts FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_contradictions_immutable BEFORE UPDATE OR DELETE ON brain_contradictions FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();
CREATE TRIGGER brain_procedures_immutable BEFORE UPDATE OR DELETE ON brain_procedures FOR EACH ROW EXECUTE FUNCTION brain_reject_immutable();

-- A Fact may only be inserted by the review/policy promotion path and must exactly project the claim.
CREATE FUNCTION brain_guard_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c brain_claims%ROWTYPE; p brain_promotions%ROWTYPE;
BEGIN
  SELECT * INTO c FROM brain_claims WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND id=NEW.claim_id;
  SELECT * INTO p FROM brain_promotions WHERE tenant_id=NEW.tenant_id AND workspace_id=NEW.workspace_id AND id=NEW.promotion_id AND claim_id=NEW.claim_id;
  IF c.id IS NULL OR p.id IS NULL OR NEW.subject IS DISTINCT FROM c.subject OR NEW.predicate IS DISTINCT FROM c.predicate OR NEW.object IS DISTINCT FROM c.object OR NEW.confidence IS DISTINCT FROM c.confidence OR NEW.effective_from IS DISTINCT FROM c.effective_from OR NEW.effective_to IS DISTINCT FROM c.effective_to THEN
    RAISE EXCEPTION 'fact requires matching claim and authorized promotion';
  END IF;
  IF current_user='xyra_app' AND NOT (
    (p.authority_type='reviewer' AND p.reviewer_id=NEW.created_by) OR
    (p.authority_type='policy' AND p.authority_ref LIKE 'policy:%')
  ) THEN
    RAISE EXCEPTION 'fact promotion requires reviewer or authorized policy provenance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brain_facts_guard BEFORE INSERT ON brain_facts FOR EACH ROW EXECUTE FUNCTION brain_guard_fact();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['brain_sources','brain_source_versions','brain_chunks','brain_signals','brain_claims','brain_promotions','brain_facts','brain_contradictions','brain_memories','brain_procedures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true) AND workspace_id::text=current_setting(''app.workspace_id'',true))', t||'_scope', t);
  END LOOP;
END $$;
