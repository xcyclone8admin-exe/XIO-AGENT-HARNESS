import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import {
  Brief, BriefGenerate, BriefGet, BriefList, ChangeDetect, ChangeEvent, ChangeEventsList,
  Citation, Claim, Recommendation, RecommendationCreate, RecommendationList, RelevanceScoreInput, RelevanceScoreResult,
  ScheduleDescribe, ScheduleDescriptor, Source, SourceAdd, SourceList, Watchlist, WatchlistCreate, WatchlistList, WatchlistTarget,
} from '../contracts';
import { diffSnapshots, hashContent, type SnapshotLike } from './change-detection';
import { scoreRelevance } from './relevance';

export interface IntelActor { readonly id: string; readonly tenantId: string; readonly workspaceId: string }
const timestamp = (value: unknown) => new Date(value as string | Date).toISOString();

/** Hard invariant: a brief claim must carry at least one citation (XIO-REQ-INT-001). Thrown
 * BEFORE any insert is issued so a zero-citation claim never reaches the database. */
export class IntelClaimRequiresCitationError extends Error {
  constructor() {
    super('INTEL_CLAIM_REQUIRES_CITATION');
    this.name = 'IntelClaimRequiresCitationError';
  }
}

interface CitationDraft {
  readonly sourceId: string | null;
  readonly changeEventId: string | null;
}

export class IntelRepository {
  constructor(private readonly store: LocalScopedStore) {}
  private scope(actor: IntelActor): Scope { return { tenantId: actor.tenantId, workspaceId: actor.workspaceId }; }

  // ---------------------------------------------------------------------------------------
  // Watchlists
  // ---------------------------------------------------------------------------------------

  async createWatchlist(actor: IntelActor, raw: unknown): Promise<Watchlist> {
    const input = WatchlistCreate.parse(raw);
    const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; created_by: string; created_at: string; updated_at: string }>(
      this.scope(actor),
      'INSERT INTO intel_watchlists(id,tenant_id,workspace_id,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,created_by,created_at,updated_at',
      [id, actor.tenantId, actor.workspaceId, input.name, actor.id],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_WATCHLIST_CREATE_FAILED');
    const targets: WatchlistTarget[] = [];
    for (const target of input.targets) {
      await this.store.query(
        this.scope(actor),
        'INSERT INTO intel_watchlist_targets(id,tenant_id,workspace_id,watchlist_id,name,kind,external_ref) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [uuidv7(), actor.tenantId, actor.workspaceId, id, target.name, target.kind, target.externalRef],
      );
      targets.push(WatchlistTarget.parse(target));
    }
    return Watchlist.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, targets, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }

  private async targetsFor(actor: IntelActor, watchlistId: string): Promise<WatchlistTarget[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { name: string; kind: string; external_ref: string | null }>(
      this.scope(actor),
      'SELECT name, kind, external_ref FROM intel_watchlist_targets WHERE tenant_id=$1 AND workspace_id=$2 AND watchlist_id=$3 ORDER BY name',
      [actor.tenantId, actor.workspaceId, watchlistId],
    );
    return rows.map((row) => WatchlistTarget.parse({ name: row.name, kind: row.kind, externalRef: row.external_ref }));
  }

  async watchlists(actor: IntelActor, _raw: unknown = WatchlistList.parse({})): Promise<Watchlist[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; created_by: string; created_at: string; updated_at: string }>(
      this.scope(actor),
      'SELECT id, name, created_by, created_at, updated_at FROM intel_watchlists WHERE deleted_hlc IS NULL ORDER BY created_at DESC',
    );
    const result: Watchlist[] = [];
    for (const row of rows) {
      const targets = await this.targetsFor(actor, row.id);
      result.push(Watchlist.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, targets, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
    }
    return result;
  }

  async requireWatchlist(actor: IntelActor, watchlistId: string): Promise<Watchlist> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; created_by: string; created_at: string; updated_at: string }>(
      this.scope(actor),
      'SELECT id, name, created_by, created_at, updated_at FROM intel_watchlists WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_hlc IS NULL',
      [actor.tenantId, actor.workspaceId, watchlistId],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_WATCHLIST_NOT_FOUND');
    const targets = await this.targetsFor(actor, row.id);
    return Watchlist.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, targets, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }

  // ---------------------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------------------

  async addSource(actor: IntelActor, raw: unknown): Promise<Source> {
    const input = SourceAdd.parse(raw);
    const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; identifier: string; title: string; kind: string; added_by: string; created_at: string }>(
      this.scope(actor),
      'INSERT INTO intel_sources(id,tenant_id,workspace_id,identifier,title,kind,added_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,identifier,title,kind,added_by,created_at',
      [id, actor.tenantId, actor.workspaceId, input.identifier, input.title, input.kind, actor.id],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_SOURCE_ADD_FAILED');
    return Source.parse({ id: row.id, workspaceId: actor.workspaceId, identifier: row.identifier, title: row.title, kind: row.kind, addedBy: row.added_by, createdAt: timestamp(row.created_at) });
  }

  async sources(actor: IntelActor, _raw: unknown = SourceList.parse({})): Promise<Source[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; identifier: string; title: string; kind: string; added_by: string; created_at: string }>(
      this.scope(actor),
      'SELECT id, identifier, title, kind, added_by, created_at FROM intel_sources ORDER BY created_at DESC',
    );
    return rows.map((row) => Source.parse({ id: row.id, workspaceId: actor.workspaceId, identifier: row.identifier, title: row.title, kind: row.kind, addedBy: row.added_by, createdAt: timestamp(row.created_at) }));
  }

  private async requireSource(actor: IntelActor, sourceId: string): Promise<void> {
    const found = await this.store.query(this.scope(actor), 'SELECT id FROM intel_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, sourceId]);
    if (!found.rows.length) throw new Error('INTEL_SOURCE_NOT_FOUND');
  }

  private async latestSnapshot(actor: IntelActor, sourceId: string): Promise<SnapshotLike | null> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; content_hash: string; content: string }>(
      this.scope(actor),
      'SELECT id, content_hash, content FROM intel_source_snapshots WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 ORDER BY observed_at DESC, id DESC LIMIT 1',
      [actor.tenantId, actor.workspaceId, sourceId],
    );
    const row = rows[0];
    return row ? { id: row.id, contentHash: row.content_hash, content: row.content } : null;
  }

  // ---------------------------------------------------------------------------------------
  // Change detection (fixture/manual-input driven, NOT a live crawler)
  // ---------------------------------------------------------------------------------------

  async detectChanges(actor: IntelActor, raw: unknown): Promise<{ events: ChangeEvent[] }> {
    const input = ChangeDetect.parse(raw);
    await this.requireWatchlist(actor, input.watchlistId);
    const events: ChangeEvent[] = [];
    for (const snapshot of input.snapshots) {
      await this.requireSource(actor, snapshot.sourceId);
      const previous = await this.latestSnapshot(actor, snapshot.sourceId);
      const contentHash = hashContent(snapshot.content);
      const snapshotId = uuidv7();
      const observedAt = snapshot.observedAt ?? new Date().toISOString();
      await this.store.query(
        this.scope(actor),
        'INSERT INTO intel_source_snapshots(id,tenant_id,workspace_id,source_id,content_hash,content,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [snapshotId, actor.tenantId, actor.workspaceId, snapshot.sourceId, contentHash, snapshot.content, observedAt],
      );
      const diff = diffSnapshots(previous, { id: snapshotId, contentHash, content: snapshot.content });
      if (!diff.changed) continue;
      const eventId = uuidv7();
      const { rows } = await this.store.query<Record<string, unknown> & { id: string; watchlist_id: string; source_id: string; previous_snapshot_id: string | null; current_snapshot_id: string; detected_at: string; summary: string }>(
        this.scope(actor),
        'INSERT INTO intel_change_events(id,tenant_id,workspace_id,watchlist_id,source_id,previous_snapshot_id,current_snapshot_id,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,watchlist_id,source_id,previous_snapshot_id,current_snapshot_id,detected_at,summary',
        [eventId, actor.tenantId, actor.workspaceId, input.watchlistId, snapshot.sourceId, previous?.id ?? null, snapshotId, diff.summary],
      );
      const row = rows[0];
      if (!row) throw new Error('INTEL_CHANGE_EVENT_CREATE_FAILED');
      events.push(ChangeEvent.parse({ id: row.id, watchlistId: row.watchlist_id, sourceId: row.source_id, previousSnapshotId: row.previous_snapshot_id, currentSnapshotId: row.current_snapshot_id, detectedAt: timestamp(row.detected_at), summary: row.summary }));
    }
    return { events };
  }

  async changeEvents(actor: IntelActor, raw: unknown): Promise<ChangeEvent[]> {
    const { watchlistId } = ChangeEventsList.parse(raw);
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; watchlist_id: string; source_id: string; previous_snapshot_id: string | null; current_snapshot_id: string; detected_at: string; summary: string }>(
      this.scope(actor),
      'SELECT id, watchlist_id, source_id, previous_snapshot_id, current_snapshot_id, detected_at, summary FROM intel_change_events WHERE tenant_id=$1 AND workspace_id=$2 AND watchlist_id=$3 ORDER BY detected_at DESC',
      [actor.tenantId, actor.workspaceId, watchlistId],
    );
    return rows.map((row) => ChangeEvent.parse({ id: row.id, watchlistId: row.watchlist_id, sourceId: row.source_id, previousSnapshotId: row.previous_snapshot_id, currentSnapshotId: row.current_snapshot_id, detectedAt: timestamp(row.detected_at), summary: row.summary }));
  }

  // ---------------------------------------------------------------------------------------
  // Briefs & claims. Every claim carries >=1 citation referencing a row that exists in this
  // tenant/workspace scope: INTEL_CLAIM_REQUIRES_CITATION is thrown BEFORE any insert runs.
  // ---------------------------------------------------------------------------------------

  private async validateCitations(actor: IntelActor, citations: readonly CitationDraft[]): Promise<void> {
    if (!citations.length) throw new IntelClaimRequiresCitationError();
    for (const citation of citations) {
      if (!citation.sourceId && !citation.changeEventId) throw new IntelClaimRequiresCitationError();
      if (citation.sourceId) await this.requireSource(actor, citation.sourceId);
      if (citation.changeEventId) {
        const found = await this.store.query(this.scope(actor), 'SELECT id FROM intel_change_events WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, citation.changeEventId]);
        if (!found.rows.length) throw new Error('INTEL_CHANGE_EVENT_NOT_FOUND');
      }
    }
  }

  /** Inserts one claim and its citations. Rejects (throws IntelClaimRequiresCitationError)
   * BEFORE issuing any insert when citations is empty or every citation is unanchored. */
  private async createClaimWithCitations(
    actor: IntelActor,
    briefId: string,
    claimText: string,
    relevanceScore: number,
    citations: readonly CitationDraft[],
  ): Promise<Claim> {
    await this.validateCitations(actor, citations);
    const claimId = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; brief_id: string; claim_text: string; relevance_score: string; created_at: string }>(
      this.scope(actor),
      'INSERT INTO intel_brief_claims(id,tenant_id,workspace_id,brief_id,claim_text,relevance_score) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,brief_id,claim_text,relevance_score,created_at',
      [claimId, actor.tenantId, actor.workspaceId, briefId, claimText, relevanceScore],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_CLAIM_CREATE_FAILED');
    const persisted: Citation[] = [];
    for (const citation of citations) {
      const citationId = uuidv7();
      const { rows: citationRows } = await this.store.query<Record<string, unknown> & { id: string; claim_id: string; source_id: string | null; change_event_id: string | null; created_at: string }>(
        this.scope(actor),
        'INSERT INTO intel_brief_citations(id,tenant_id,workspace_id,claim_id,source_id,change_event_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,claim_id,source_id,change_event_id,created_at',
        [citationId, actor.tenantId, actor.workspaceId, claimId, citation.sourceId, citation.changeEventId],
      );
      const citationRow = citationRows[0];
      if (!citationRow) throw new Error('INTEL_CITATION_CREATE_FAILED');
      persisted.push(Citation.parse({ id: citationRow.id, claimId: citationRow.claim_id, sourceId: citationRow.source_id, changeEventId: citationRow.change_event_id, createdAt: timestamp(citationRow.created_at) }));
    }
    return Claim.parse({ id: row.id, briefId: row.brief_id, claimText: row.claim_text, relevanceScore: Number(row.relevance_score), citations: persisted, createdAt: timestamp(row.created_at) });
  }

  private async claimsFor(actor: IntelActor, briefId: string): Promise<Claim[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; brief_id: string; claim_text: string; relevance_score: string; created_at: string }>(
      this.scope(actor),
      'SELECT id, brief_id, claim_text, relevance_score, created_at FROM intel_brief_claims WHERE tenant_id=$1 AND workspace_id=$2 AND brief_id=$3 ORDER BY relevance_score DESC, created_at',
      [actor.tenantId, actor.workspaceId, briefId],
    );
    const claims: Claim[] = [];
    for (const row of rows) {
      const { rows: citationRows } = await this.store.query<Record<string, unknown> & { id: string; claim_id: string; source_id: string | null; change_event_id: string | null; created_at: string }>(
        this.scope(actor),
        'SELECT id, claim_id, source_id, change_event_id, created_at FROM intel_brief_citations WHERE tenant_id=$1 AND workspace_id=$2 AND claim_id=$3 ORDER BY created_at',
        [actor.tenantId, actor.workspaceId, row.id],
      );
      const citations = citationRows.map((c) => Citation.parse({ id: c.id, claimId: c.claim_id, sourceId: c.source_id, changeEventId: c.change_event_id, createdAt: timestamp(c.created_at) }));
      claims.push(Claim.parse({ id: row.id, briefId: row.brief_id, claimText: row.claim_text, relevanceScore: Number(row.relevance_score), citations, createdAt: timestamp(row.created_at) }));
    }
    return claims;
  }

  /**
   * Generates a brief for a watchlist from its recorded change events: one claim per change
   * event, each claim citing that change event (XIO-REQ-INT-001). Pure keyword/recency scoring
   * (relevance.ts) ranks the claims; watchlist target names are used as keywords.
   */
  async generateBrief(actor: IntelActor, raw: unknown): Promise<Brief> {
    const input = BriefGenerate.parse(raw);
    const watchlist = await this.requireWatchlist(actor, input.watchlistId);
    const events = await this.changeEvents(actor, { watchlistId: input.watchlistId });
    const briefId = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; watchlist_id: string; generated_at: string; generated_by: string; created_at: string }>(
      this.scope(actor),
      'INSERT INTO intel_briefs(id,tenant_id,workspace_id,watchlist_id,generated_by) VALUES($1,$2,$3,$4,$5) RETURNING id,watchlist_id,generated_at,generated_by,created_at',
      [briefId, actor.tenantId, actor.workspaceId, input.watchlistId, actor.id],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_BRIEF_CREATE_FAILED');
    const now = timestamp(row.generated_at);
    const keywords = watchlist.targets.map((target) => target.name);
    const claims: Claim[] = [];
    for (const event of events) {
      const score = scoreRelevance({ text: event.summary, keywords, observedAt: event.detectedAt, now });
      const claim = await this.createClaimWithCitations(actor, briefId, event.summary, score, [{ sourceId: null, changeEventId: event.id }]);
      claims.push(claim);
    }
    return Brief.parse({ id: row.id, workspaceId: actor.workspaceId, watchlistId: row.watchlist_id, generatedAt: timestamp(row.generated_at), generatedBy: row.generated_by, createdAt: timestamp(row.created_at), claims });
  }

  async briefs(actor: IntelActor, raw: unknown): Promise<Brief[]> {
    const input = BriefList.parse(raw);
    const params: unknown[] = [actor.tenantId, actor.workspaceId];
    let where = 'tenant_id=$1 AND workspace_id=$2';
    if (input.watchlistId) {
      params.push(input.watchlistId);
      where += ` AND watchlist_id=$${params.length}`;
    }
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; watchlist_id: string; generated_at: string; generated_by: string; created_at: string }>(
      this.scope(actor),
      `SELECT id, watchlist_id, generated_at, generated_by, created_at FROM intel_briefs WHERE ${where} ORDER BY created_at DESC`,
      params,
    );
    const briefs: Brief[] = [];
    for (const row of rows) {
      const claims = await this.claimsFor(actor, row.id);
      briefs.push(Brief.parse({ id: row.id, workspaceId: actor.workspaceId, watchlistId: row.watchlist_id, generatedAt: timestamp(row.generated_at), generatedBy: row.generated_by, createdAt: timestamp(row.created_at), claims }));
    }
    return briefs;
  }

  async brief(actor: IntelActor, raw: unknown): Promise<Brief> {
    const { briefId } = BriefGet.parse(raw);
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; watchlist_id: string; generated_at: string; generated_by: string; created_at: string }>(
      this.scope(actor),
      'SELECT id, watchlist_id, generated_at, generated_by, created_at FROM intel_briefs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
      [actor.tenantId, actor.workspaceId, briefId],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_BRIEF_NOT_FOUND');
    const claims = await this.claimsFor(actor, row.id);
    return Brief.parse({ id: row.id, workspaceId: actor.workspaceId, watchlistId: row.watchlist_id, generatedAt: timestamp(row.generated_at), generatedBy: row.generated_by, createdAt: timestamp(row.created_at), claims });
  }

  /** Pure scoring capability; does not touch the database. */
  scoreRelevance(_actor: IntelActor, raw: unknown): RelevanceScoreResult {
    const input = RelevanceScoreInput.parse(raw);
    return RelevanceScoreResult.parse({ score: scoreRelevance(input) });
  }

  // ---------------------------------------------------------------------------------------
  // Recommendations. routedTo defaults to null (unrouted). Cross-module routing into
  // modules/command, modules/flow or modules/connect is an integration owned outside this
  // module; this repository never writes routed_kind/routed_external_id itself.
  // ---------------------------------------------------------------------------------------

  async createRecommendation(actor: IntelActor, raw: unknown): Promise<Recommendation> {
    const input = RecommendationCreate.parse(raw);
    if (input.briefId) {
      const found = await this.store.query(this.scope(actor), 'SELECT id FROM intel_briefs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, input.briefId]);
      if (!found.rows.length) throw new Error('INTEL_BRIEF_NOT_FOUND');
    }
    if (input.claimId) {
      const found = await this.store.query(this.scope(actor), 'SELECT id FROM intel_brief_claims WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, input.claimId]);
      if (!found.rows.length) throw new Error('INTEL_CLAIM_NOT_FOUND');
    }
    const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; brief_id: string | null; claim_id: string | null; text: string; routed_kind: string | null; routed_external_id: string | null; created_at: string }>(
      this.scope(actor),
      'INSERT INTO intel_recommendations(id,tenant_id,workspace_id,brief_id,claim_id,text) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,brief_id,claim_id,text,routed_kind,routed_external_id,created_at',
      [id, actor.tenantId, actor.workspaceId, input.briefId, input.claimId, input.text],
    );
    const row = rows[0];
    if (!row) throw new Error('INTEL_RECOMMENDATION_CREATE_FAILED');
    return this.rowToRecommendation(actor, row);
  }

  private rowToRecommendation(actor: IntelActor, row: Record<string, unknown> & { id: string; brief_id: string | null; claim_id: string | null; text: string; routed_kind: string | null; routed_external_id: string | null; created_at: string }): Recommendation {
    return Recommendation.parse({
      id: row.id,
      workspaceId: actor.workspaceId,
      briefId: row.brief_id,
      claimId: row.claim_id,
      text: row.text,
      routedTo: row.routed_kind && row.routed_external_id ? { kind: row.routed_kind, externalId: row.routed_external_id } : null,
      createdAt: timestamp(row.created_at),
    });
  }

  async recommendations(actor: IntelActor, _raw: unknown = RecommendationList.parse({})): Promise<Recommendation[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; brief_id: string | null; claim_id: string | null; text: string; routed_kind: string | null; routed_external_id: string | null; created_at: string }>(
      this.scope(actor),
      'SELECT id, brief_id, claim_id, text, routed_kind, routed_external_id, created_at FROM intel_recommendations ORDER BY created_at DESC',
    );
    return rows.map((row) => this.rowToRecommendation(actor, row));
  }

  /**
   * Typed descriptor only (XIO-REQ-INT-001). No real Cloudflare Cron Trigger is bound by this
   * module. The schema does not persist a per-watchlist schedule configuration, so this always
   * reports an unscheduled (cron: null, enabled: false) descriptor for a watchlist known to this
   * workspace — a deliberate, documented gap: wiring a real recurring detect/brief schedule is
   * an integration owned outside this module.
   */
  async scheduleDescribe(actor: IntelActor, raw: unknown): Promise<ScheduleDescriptor> {
    const { watchlistId } = ScheduleDescribe.parse(raw);
    const watchlist = await this.requireWatchlist(actor, watchlistId);
    return ScheduleDescriptor.parse({ watchlistId: watchlist.id, cron: null, enabled: false });
  }
}
