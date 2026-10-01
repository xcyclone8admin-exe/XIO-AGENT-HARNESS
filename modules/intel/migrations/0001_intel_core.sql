-- modules/intel core schema. Every table is tenant+workspace scoped with RLS from this first
-- migration (XIO-REQ-INT-001). Append-only tables use reject_append_mutation() defined in
-- packages/db/migrations/0001_platform.sql, and workspaces/users are defined there too.
CREATE TABLE intel_watchlists (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  deleted_hlc text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE intel_watchlist_targets (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  watchlist_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('company', 'project', 'topic')),
  external_ref text,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, watchlist_id) REFERENCES intel_watchlists(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_watchlist_targets_scope_watchlist ON intel_watchlist_targets(tenant_id, workspace_id, watchlist_id);

CREATE TABLE intel_sources (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  identifier text NOT NULL CHECK (length(identifier) BETWEEN 1 AND 2000),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('feed', 'filing', 'news', 'manual')),
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, added_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);

-- Append-only: each insert is one observed snapshot of a source's content. Change detection
-- diffs against the latest snapshot per source via query, never a mutable "latest" column.
CREATE TABLE intel_source_snapshots (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  content_hash text NOT NULL,
  content text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, source_id) REFERENCES intel_sources(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_source_snapshots_scope_source ON intel_source_snapshots(tenant_id, workspace_id, source_id, observed_at DESC);

CREATE TABLE intel_change_events (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  watchlist_id uuid NOT NULL,
  source_id uuid NOT NULL,
  previous_snapshot_id uuid,
  current_snapshot_id uuid NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, watchlist_id) REFERENCES intel_watchlists(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, source_id) REFERENCES intel_sources(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, previous_snapshot_id) REFERENCES intel_source_snapshots(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, current_snapshot_id) REFERENCES intel_source_snapshots(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_change_events_scope_watchlist ON intel_change_events(tenant_id, workspace_id, watchlist_id, detected_at DESC);

CREATE TABLE intel_briefs (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  watchlist_id uuid NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, watchlist_id) REFERENCES intel_watchlists(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, generated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_briefs_scope_watchlist ON intel_briefs(tenant_id, workspace_id, watchlist_id, created_at DESC);

CREATE TABLE intel_brief_claims (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  claim_text text NOT NULL CHECK (length(claim_text) BETWEEN 1 AND 4000),
  relevance_score numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, brief_id) REFERENCES intel_briefs(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_brief_claims_scope_brief ON intel_brief_claims(tenant_id, workspace_id, brief_id);

-- Append-only; CHECK constraint enforces the hard invariant that every claim citation
-- references a source or a change event (XIO-REQ-INT-001). Repository-level validation also
-- rejects a zero-citation claim BEFORE issuing this insert (INTEL_CLAIM_REQUIRES_CITATION).
CREATE TABLE intel_brief_citations (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  source_id uuid,
  change_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  CHECK (source_id IS NOT NULL OR change_event_id IS NOT NULL),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, claim_id) REFERENCES intel_brief_claims(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, source_id) REFERENCES intel_sources(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, change_event_id) REFERENCES intel_change_events(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_brief_citations_scope_claim ON intel_brief_citations(tenant_id, workspace_id, claim_id);

CREATE TABLE intel_recommendations (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  brief_id uuid,
  claim_id uuid,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  routed_kind text CHECK (routed_kind IN ('task', 'workflow')),
  routed_external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, brief_id) REFERENCES intel_briefs(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, claim_id) REFERENCES intel_brief_claims(tenant_id, workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX intel_recommendations_scope ON intel_recommendations(tenant_id, workspace_id, created_at DESC);

CREATE TRIGGER intel_source_snapshots_append_only BEFORE UPDATE OR DELETE ON intel_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER intel_change_events_append_only BEFORE UPDATE OR DELETE ON intel_change_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER intel_briefs_append_only BEFORE UPDATE OR DELETE ON intel_briefs
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER intel_brief_claims_append_only BEFORE UPDATE OR DELETE ON intel_brief_claims
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER intel_brief_citations_append_only BEFORE UPDATE OR DELETE ON intel_brief_citations
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();
CREATE TRIGGER intel_recommendations_append_only BEFORE UPDATE OR DELETE ON intel_recommendations
  FOR EACH ROW EXECUTE FUNCTION reject_append_mutation();

ALTER TABLE intel_watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_watchlist_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_brief_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_brief_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_watchlists FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_watchlist_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_source_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_change_events FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_briefs FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_brief_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_brief_citations FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY intel_watchlists_scope ON intel_watchlists USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_watchlist_targets_scope ON intel_watchlist_targets USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_sources_scope ON intel_sources USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_source_snapshots_scope ON intel_source_snapshots USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_change_events_scope ON intel_change_events USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_briefs_scope ON intel_briefs USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_brief_claims_scope ON intel_brief_claims USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_brief_citations_scope ON intel_brief_citations USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY intel_recommendations_scope ON intel_recommendations USING
  (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));
