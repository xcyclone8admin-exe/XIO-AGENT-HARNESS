import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex, uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { ClaimDraft, ErasureRequestInput, ErasureRetryInput, ErasureStatusInput, IngestDraft, MemoryDraft, MemoryListInput, ProcedureListInput, SearchInput, type MemoryType } from '../contracts';

type IdRow = Record<string, unknown> & { id: string };
type SearchRow = Record<string, unknown> & { source_id: string; source_version_id: string; chunk_id: string; content_text: string; rank: number };
const uuid = () => uuidv7();

/** Source-backed BRAIN data access. Every read/write carries an explicit tenant/workspace scope. */
export class BrainService {
  constructor(private readonly store: LocalScopedStore) {}

  async ingest(scope: Scope, actorId: string, input: unknown) {
    const draft = IngestDraft.parse(input);
    const sourceId = uuid();
    const versionId = uuid();
    const now = draft.capturedAt ?? new Date().toISOString();
    const hash = createHash('sha256').update(draft.content).digest('hex');
    const chunks = splitChunks(draft.content, draft.chunkSize, draft.overlap);
    if (draft.embeddings && draft.embeddings.length !== chunks.length) throw new Error('EMBEDDING_CHUNK_COUNT_MISMATCH');
    const dimension = draft.embeddings?.[0]?.length;
    if (draft.embeddings?.some((vector) => vector.length !== dimension)) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
    const chunkIds = chunks.map(() => uuid());
    await this.store.query(scope, `INSERT INTO brain_sources(id,tenant_id,workspace_id,source_type,title,uri,trust_level,retention,external_blob_refs,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [sourceId, scope.tenantId, scope.workspaceId, draft.source.sourceType, draft.source.title, draft.source.uri ?? null, draft.source.trustLevel, draft.source.retention, JSON.stringify(draft.source.externalBlobRefs), actorId]);
    await this.store.query(scope, `INSERT INTO brain_source_versions(id,tenant_id,workspace_id,source_id,version,content_hash,content_type,content_text,captured_at,created_by)
      VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`, [versionId, scope.tenantId, scope.workspaceId, sourceId, hash, draft.contentType, draft.content, now, actorId]);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]!;
      const vector = draft.embeddings?.[i];
      await this.store.query(scope, `INSERT INTO brain_chunks(id,tenant_id,workspace_id,source_id,source_version_id,ordinal,content_hash,content_text,embedding,embedding_model,embedding_version,dim,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13)`, [chunkIds[i], scope.tenantId, scope.workspaceId, sourceId, versionId, i, createHash('sha256').update(content).digest('hex'), content, vector ? `[${vector.join(',')}]` : null, vector ? draft.embeddingModel : null, vector ? draft.embeddingVersion : null, vector?.length ?? null, actorId]);
    }
    return { sourceId, versionId, chunkIds };
  }

  async search(scope: Scope, input: unknown) {
    const { query, limit, vector: embedding, embeddingModel, embeddingVersion } = SearchInput.parse(input);
    const vectorMode = !!embedding?.length;
    // Scope predicate is inside each ranked SQL subquery, before ts_rank or vector distance.
    const keywordSql = `WITH authorized AS (
      SELECT c.id chunk_id,c.source_id,c.source_version_id,c.content_text,
        ts_rank_cd(to_tsvector('english',c.content_text), plainto_tsquery('english',$3)) rank
      FROM brain_chunks c JOIN brain_sources s ON (s.tenant_id,s.workspace_id,s.id)=(c.tenant_id,c.workspace_id,c.source_id)
      JOIN brain_source_versions v ON (v.tenant_id,v.workspace_id,v.id)=(c.tenant_id,c.workspace_id,c.source_version_id)
      WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND s.tenant_id=$1 AND s.workspace_id=$2
        AND v.tenant_id=$1 AND v.workspace_id=$2 AND to_tsvector('english',c.content_text) @@ plainto_tsquery('english',$3)
    ) SELECT *,row_number() OVER(ORDER BY rank DESC,chunk_id) rnk FROM authorized ORDER BY rank DESC,chunk_id LIMIT $4`;
    const keywords = await this.store.query<SearchRow>(scope, keywordSql, [scope.tenantId, scope.workspaceId, query, limit * 3]);
    let vectorRows: SearchRow[] = [];
    if (vectorMode) {
      const vectorText = `[${embedding!.join(',')}]`;
      const vectorSql = `WITH authorized AS (
        SELECT c.id chunk_id,c.source_id,c.source_version_id,c.content_text,(1-(c.embedding <=> $3::vector))::float8 rank
        FROM brain_chunks c JOIN brain_sources s ON (s.tenant_id,s.workspace_id,s.id)=(c.tenant_id,c.workspace_id,c.source_id)
        JOIN brain_source_versions v ON (v.tenant_id,v.workspace_id,v.id)=(c.tenant_id,c.workspace_id,c.source_version_id)
        WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND s.tenant_id=$1 AND s.workspace_id=$2
          AND v.tenant_id=$1 AND v.workspace_id=$2 AND c.embedding IS NOT NULL
          AND c.embedding_model=$4 AND c.embedding_version=$5 AND c.dim=$6
      ) SELECT *,row_number() OVER(ORDER BY rank DESC,chunk_id) rnk FROM authorized ORDER BY rank DESC,chunk_id LIMIT $7`;
      try {
        const result = await this.store.query<SearchRow>(scope, vectorSql, [scope.tenantId, scope.workspaceId, vectorText, embeddingModel ?? '', embeddingVersion ?? '', embedding!.length, limit * 3]);
        vectorRows = result.rows;
      } catch {
        // Full text remains available if pgvector is unavailable or its index needs repair.
        vectorRows = [];
      }
    }
    const fused = new Map<string, { row: SearchRow; score: number }>();
    for (const [list, weight] of [[keywords.rows, 1], [vectorRows, 1]] as const) {
      for (const item of list) {
        const prior = fused.get(item.chunk_id);
        const score = 1 / (60 + Number(item.rnk));
        fused.set(item.chunk_id, { row: item, score: (prior?.score ?? 0) + score * weight });
      }
    }
    return [...fused.values()].sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id)).slice(0, limit).map(({ row, score }) => ({
      sourceId: row.source_id, sourceVersionId: row.source_version_id, chunkId: row.chunk_id,
      citation: `${row.source_id}@${row.source_version_id}#${row.chunk_id}`, content: row.content_text, score, untrusted: true as const,
    }));
  }

  async createSignal(scope: Scope, actorId: string, sourceId: string, versionId: string, chunkId: string | null, signalType: string, payload: unknown = {}) {
    const id = uuid();
    await this.store.query(scope, `INSERT INTO brain_signals(id,tenant_id,workspace_id,source_id,source_version_id,chunk_id,signal_type,payload,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [id, scope.tenantId, scope.workspaceId, sourceId, versionId, chunkId, signalType, JSON.stringify(payload), actorId]);
    return { signalId: id };
  }

  async createClaim(scope: Scope, actorId: string, input: unknown) {
    const d = ClaimDraft.parse(input);
    const id = uuid();
    await this.store.query(scope, `INSERT INTO brain_claims(id,tenant_id,workspace_id,signal_id,subject,predicate,object,confidence,effective_from,effective_to,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, scope.tenantId, scope.workspaceId, d.signalId, d.subject, d.predicate, d.object, d.confidence, d.effectiveFrom, d.effectiveTo ?? null, actorId]);
    const conflicts = await this.store.query<IdRow>(scope, `SELECT f.id FROM brain_facts f WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND f.subject=$3 AND f.predicate=$4
      AND f.effective_from < COALESCE($6::timestamptz, 'infinity'::timestamptz) AND COALESCE(f.effective_to, 'infinity'::timestamptz) > $5 AND f.object<>$7
      AND NOT EXISTS (SELECT 1 FROM brain_facts superseder WHERE superseder.tenant_id=f.tenant_id AND superseder.workspace_id=f.workspace_id
        AND superseder.supersedes_id=f.id AND superseder.effective_from<=$5 AND (superseder.effective_to IS NULL OR superseder.effective_to>$5))`,
    [scope.tenantId, scope.workspaceId, d.subject, d.predicate, d.effectiveFrom, d.effectiveTo ?? null, d.object]);
    for (const conflict of conflicts.rows) await this.store.query(scope, `INSERT INTO brain_contradictions(id,tenant_id,workspace_id,claim_id,fact_id,status,created_by) VALUES ($1,$2,$3,$4,$5,'open',$6) ON CONFLICT DO NOTHING`, [uuid(), scope.tenantId, scope.workspaceId, id, conflict.id, actorId]);
    return { id, contradictions: conflicts.rows.map(({ id: factId }) => factId) };
  }

  /** Reviewer/policy authority must be supplied by the trusted caller after policy evaluation. */
  async promoteClaim(scope: Scope, actorId: string, claimId: string, authority: { type: 'reviewer' | 'policy'; reference: string; reason: string; reviewerId?: string; authorized: true }, supersedesId?: string) {
    if (authority.authorized !== true || !authority.reference || !authority.reason.trim()) throw new Error('PROMOTION_AUTHORITY_REQUIRED');
    if (authority.type === 'reviewer' && authority.reviewerId !== actorId) throw new Error('REVIEWER_MISMATCH');
    const claimResult = await this.store.query<Record<string, unknown> & { id: string; subject: string; predicate: string; object: string; confidence: number; effective_from: string; effective_to: string | null }>(scope,
      'SELECT id,subject,predicate,object,confidence,effective_from,effective_to FROM brain_claims WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, claimId]);
    const claim = claimResult.rows[0];
    if (!claim) throw new Error('CLAIM_NOT_FOUND');
    const promotionId = uuid();
    await this.store.query(scope, `INSERT INTO brain_promotions(id,tenant_id,workspace_id,claim_id,reviewer_id,authority_type,authority_ref,reason,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [promotionId, scope.tenantId, scope.workspaceId, claimId, authority.reviewerId ?? actorId, authority.type, authority.reference, authority.reason, actorId]);
    const same = await this.store.query<IdRow>(scope, `SELECT id FROM brain_facts WHERE tenant_id=$1 AND workspace_id=$2 AND subject=$3 AND predicate=$4 AND object=$5 AND effective_from=$6 AND effective_to IS NOT DISTINCT FROM $7 ORDER BY created_at DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId, claim.subject, claim.predicate, claim.object, claim.effective_from, claim.effective_to]);
    const effectiveSupersedes = supersedesId ?? same.rows[0]?.id ?? null;
    if (effectiveSupersedes) {
      const predecessor = await this.store.query<IdRow>(scope, 'SELECT id FROM brain_facts WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND subject=$4 AND predicate=$5', [scope.tenantId, scope.workspaceId, effectiveSupersedes, claim.subject, claim.predicate]);
      if (!predecessor.rows.length) throw new Error('SUPERSESSION_SCOPE_OR_KEY_MISMATCH');
    }
    const factId = uuid();
    await this.store.query(scope, `INSERT INTO brain_facts(id,tenant_id,workspace_id,claim_id,subject,predicate,object,confidence,effective_from,effective_to,supersedes_id,promotion_id,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [factId, scope.tenantId, scope.workspaceId, claimId, claim.subject, claim.predicate, claim.object, claim.confidence, claim.effective_from, claim.effective_to, effectiveSupersedes, promotionId, actorId]);
    return { factId, promotionId, supersedesId: effectiveSupersedes };
  }

  async factsAsOf(scope: Scope, date: string) {
    const at = new Date(date);
    if (!Number.isFinite(at.valueOf())) throw new Error('INVALID_AS_OF_DATE');
    const result = await this.store.query(scope, `SELECT f.id,f.claim_id,f.subject,f.predicate,f.object,f.confidence,f.effective_from,f.effective_to,f.supersedes_id,p.authority_type,p.authority_ref
      FROM brain_facts f JOIN brain_promotions p ON (p.tenant_id,p.workspace_id,p.id)=(f.tenant_id,f.workspace_id,f.promotion_id)
      WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND f.effective_from<=$3 AND (f.effective_to IS NULL OR f.effective_to>$3)
        AND NOT EXISTS(SELECT 1 FROM brain_facts newer WHERE newer.tenant_id=f.tenant_id AND newer.workspace_id=f.workspace_id AND newer.supersedes_id=f.id AND newer.effective_from<=$3 AND (newer.effective_to IS NULL OR newer.effective_to>$3))
      ORDER BY f.subject,f.predicate,f.effective_from DESC,f.id`, [scope.tenantId, scope.workspaceId, at.toISOString()]);
    return result.rows;
  }

  async addMemory(scope: Scope, actorId: string, input: unknown) {
    const d = MemoryDraft.parse(input);
    const id = uuid();
    await this.store.query(scope, `INSERT INTO brain_memories(id,tenant_id,workspace_id,memory_type,title,content,source_id,source_version_id,confidence,importance,effective_from,effective_to,supersedes_id,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, scope.tenantId, scope.workspaceId, d.memoryType satisfies MemoryType, d.title, d.content, d.sourceId ?? null, d.sourceVersionId ?? null, d.confidence ?? null, d.importance ?? null, d.effectiveFrom ?? null, d.effectiveTo ?? null, d.supersedesId ?? null, actorId]);
    return id;
  }

  async proposeProcedure(scope: Scope, actorId: string, input: { title: string; type: 'skill' | 'sop' | 'xyra_pattern'; body: string; successfulRunId?: string }) {
    const parsed = zProcedure(input);
    if (parsed.type === 'xyra_pattern' && !parsed.successfulRunId) throw new Error('SUCCESSFUL_RUN_REQUIRED');
    const id = uuid();
    await this.store.query(scope, `INSERT INTO brain_procedures(id,tenant_id,workspace_id,procedure_id,version,title,procedure_type,body,status,source_run_id,created_by)
      VALUES ($1,$2,$3,$4,1,$5,$6,$7,'candidate',$8,$9)`, [id, scope.tenantId, scope.workspaceId, uuid(), parsed.title, parsed.type, parsed.body, parsed.successfulRunId ?? null, actorId]);
    return { procedureId: id };
  }

  async reviewProcedure(scope: Scope, reviewerId: string, procedureId: string, decision: 'approved' | 'rejected') {
    const old = await this.store.query<Record<string, unknown> & { procedure_id: string; version: number; title: string; procedure_type: string; body: string; source_run_id: string | null }>(scope,
      "SELECT procedure_id,version,title,procedure_type,body,source_run_id FROM brain_procedures WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='candidate'", [scope.tenantId, scope.workspaceId, procedureId]);
    const row = old.rows[0];
    if (!row) throw new Error('PROCEDURE_CANDIDATE_NOT_FOUND');
    const id = uuid();
    await this.store.query(scope, `INSERT INTO brain_procedures(id,tenant_id,workspace_id,procedure_id,version,title,procedure_type,body,status,source_run_id,reviewed_by,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, [id, scope.tenantId, scope.workspaceId, row.procedure_id, Number(row.version) + 1, row.title, row.procedure_type, row.body, decision, row.source_run_id, reviewerId]);
    return { procedureId: id };
  }

  async listProcedures(scope: Scope, input: unknown = {}) {
    const parsed = ProcedureListInput.parse(input);
    return (await this.store.query(scope, `SELECT id,procedure_id,version,title,procedure_type,body,status,source_run_id,reviewed_by,created_at
      FROM brain_procedures WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC,id DESC LIMIT $4`, [scope.tenantId, scope.workspaceId, parsed.status ?? null, parsed.limit])).rows;
  }

  /** Persist an approved erasure intent. Blob and source bytes remain until CLOUD can safely coordinate deletion. */
  async requestSourceErasure(scope: Scope, actorId: string, approvalRequestId: string | undefined, input: unknown) {
    const request = ErasureRequestInput.parse(input);
    if (!approvalRequestId) throw new Error('ERASURE_APPROVAL_REQUIRED');
    const inputHash = await sha256Hex(canonicalJson(request));
    await this.assertErasureApproval(scope, approvalRequestId, request, 'brain.sources.erase');
    const source = await this.store.query<Record<string, unknown> & { id: string; retention: string; external_blob_refs: string[] }>(scope,
      'SELECT id,retention,external_blob_refs FROM brain_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, request.sourceId]);
    const row = source.rows[0];
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    const id = uuid();
    await this.store.query(scope, 'INSERT INTO brain_source_erasures(id,tenant_id,workspace_id,source_id,status,requested_by,approval_request_id,approval_input_hash,retention_policy,external_blob_refs,last_error_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT DO NOTHING',
    [id, scope.tenantId, scope.workspaceId, request.sourceId, 'waiting_cloud', actorId, approvalRequestId, inputHash, row.retention, JSON.stringify(row.external_blob_refs), 'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE']);
    const existing = await this.store.query<Record<string, unknown> & { id: string; source_id: string; status: string; attempts: number; retention_policy: string; external_blob_refs: string[]; last_error_code: string | null; completion_receipt: string | null }>(scope,
      'SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt FROM brain_source_erasures WHERE tenant_id=$1 AND workspace_id=$2 AND (source_id=$3 OR (approval_request_id=$4 AND approval_input_hash=$5)) ORDER BY created_at LIMIT 1', [scope.tenantId, scope.workspaceId, request.sourceId, approvalRequestId, inputHash]);
    const erasure = existing.rows[0];
    if (!erasure) throw new Error('ERASURE_INTENT_CREATE_FAILED');
    if (erasure.attempts > 0) return erasureRequestView(erasure);
    await this.store.query(scope, `INSERT INTO brain_source_erasure_attempts(id,tenant_id,workspace_id,erasure_id,actor_id,outcome,checked_blob_refs,deleted_blob_refs,retention_policy,error_code)
      VALUES ($1,$2,$3,$4,$5,'waiting_cloud','[]'::jsonb,'[]'::jsonb,$6,'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE') ON CONFLICT DO NOTHING`,
    [uuid(), scope.tenantId, scope.workspaceId, erasure.id, actorId, erasure.retention_policy]);
    return erasureRequestView(erasure);
  }

  /** Retry is explicit and bounded. This records the dependency blocker; it never deletes a shared object itself. */
  async retrySourceErasure(scope: Scope, actorId: string, input: unknown) {
    const { erasureId, approvalRequestId } = ErasureRetryInput.parse(input);
    const old = await this.store.query<Record<string, unknown> & { id: string; source_id: string; status: string; attempts: number; retention_policy: string; external_blob_refs: string[]; last_error_code: string | null; completion_receipt: string | null }>(scope,
      'SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt FROM brain_source_erasures WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, erasureId]);
    const row = old.rows[0];
    if (!row) throw new Error('ERASURE_NOT_FOUND');
    if (row.status === 'complete') return erasureView(row);
    if (Number(row.attempts) >= 5) throw new Error('ERASURE_RETRY_LIMIT');
    if (row.status !== 'waiting_cloud') throw new Error('ERASURE_PRIVILEGED_WORKFLOW_REQUIRED');
    await this.assertErasureApproval(scope, approvalRequestId, { erasureId, attempt: Number(row.attempts) + 1 }, 'brain.sources.erase.retry');
    const attempts = Number(row.attempts) + 1;
    await this.store.query(scope, `INSERT INTO brain_source_erasure_attempts(id,tenant_id,workspace_id,erasure_id,actor_id,outcome,checked_blob_refs,deleted_blob_refs,retention_policy,error_code)
      VALUES ($1,$2,$3,$4,$5,'waiting_cloud','[]'::jsonb,'[]'::jsonb,$6,'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE')`, [uuid(), scope.tenantId, scope.workspaceId, erasureId, actorId, row.retention_policy]);
    await this.store.query(scope, "UPDATE brain_source_erasures SET attempts=$1,last_error_code='PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE',updated_at=now() WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4", [attempts, scope.tenantId, scope.workspaceId, erasureId]);
    return { ...erasureRequestView({ ...row, attempts }), status: 'waiting_cloud' as const, lastErrorCode: 'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE', completionReceipt: null };
  }

  async sourceErasureStatus(scope: Scope, input: unknown) {
    const { erasureId, limit, cursor } = ErasureStatusInput.parse(input);
    const result = await this.store.query<Record<string, unknown> & { id: string; source_id: string; status: string; attempts: number; retention_policy: string; external_blob_refs: string[]; last_error_code: string | null; completion_receipt: string | null }>(scope,
      'SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt FROM brain_source_erasures WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, erasureId]);
    if (!result.rows[0]) throw new Error('ERASURE_NOT_FOUND');
    const attempts = await this.store.query<Record<string, unknown> & { id: string; occurred_at: string; checked_blob_refs: string[]; deleted_blob_refs: string[]; retention_policy: string; audit_reference: string | null; error_code: string | null; outcome: string }>(scope, `SELECT id,outcome,checked_blob_refs,deleted_blob_refs,retention_policy,audit_reference,error_code,occurred_at
      FROM brain_source_erasure_attempts WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3
        AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4,$5::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT $6`,
    [scope.tenantId, scope.workspaceId, erasureId, cursor?.occurredAt ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = attempts.rows.length > limit;
    const items = attempts.rows.slice(0, limit);
    const last = items.at(-1);
    return { ...erasureView(result.rows[0]), audit: { items, nextCursor: hasMore && last ? { occurredAt: new Date(last.occurred_at).toISOString(), id: last.id } : null } };
  }

  private async assertErasureApproval(scope: Scope, approvalRequestId: string, input: unknown, capabilityId: string) {
    const inputHash = await sha256Hex(canonicalJson(input));
    const result = await this.store.query<IdRow>(scope, `SELECT r.id FROM approval_requests r JOIN approval_decisions d
      ON d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.request_id=r.id
      WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.id=$3 AND r.capability_id=$4
        AND r.input_hash=$5 AND r.expires_at>now() AND d.decision='approved' AND d.valid=true
        AND (r.capability_id<>'brain.sources.erase.retry' OR d.decided_by<>r.requested_by) LIMIT 1`,
    [scope.tenantId, scope.workspaceId, approvalRequestId, capabilityId, inputHash]);
    if (!result.rows.length) throw new Error('ERASURE_APPROVAL_INVALID');
  }

  async listMemories(scope: Scope, input: unknown = {}) {
    const parsed = MemoryListInput.parse(input);
    const limit = parsed.limit;
    const rows = await this.store.query<Record<string, unknown> & { id: string; updated_at: string }>(scope, `SELECT id,memory_type,title,content,source_id,source_version_id,confidence,importance,effective_from,effective_to,supersedes_id,updated_at
      FROM brain_memories WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR memory_type=$3)
        AND ($4::timestamptz IS NULL OR (updated_at,id)<($4,$5::uuid)) ORDER BY updated_at DESC,id DESC LIMIT $6`,
    [scope.tenantId, scope.workspaceId, parsed.memoryType ?? null, parsed.cursor?.updatedAt ?? null, parsed.cursor?.id ?? null, limit + 1]);
    const hasMore = rows.rows.length > limit;
    const items = rows.rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? { updatedAt: new Date(last.updated_at).toISOString(), id: last.id } : null };
  }
}

function splitChunks(text: string, size: number, overlap: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(size * 0.5)) end = boundary;
    }
    const value = text.slice(start, end).trim();
    if (value) parts.push(value);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return parts;
}

function erasureView(row: { id: string; source_id: string; status: string; attempts: number; retention_policy: string; external_blob_refs: string[]; last_error_code: string | null; completion_receipt: string | null }) {
  return { id: row.id, sourceId: row.source_id, status: row.status as 'waiting_cloud' | 'retryable_failure' | 'local_purge_pending' | 'complete', attempts: Number(row.attempts), retentionPolicy: row.retention_policy, externalBlobRefs: row.external_blob_refs, lastErrorCode: row.last_error_code, completionReceipt: row.completion_receipt };
}

function erasureRequestView(row: { id: string; source_id: string; status: string; attempts: number; retention_policy: string; external_blob_refs: string[]; last_error_code: string | null }) {
  if (row.status !== 'waiting_cloud') throw new Error('ERASURE_PRIVILEGED_WORKFLOW_REQUIRED');
  return { id: row.id, sourceId: row.source_id, status: 'waiting_cloud' as const, attempts: Number(row.attempts), retentionPolicy: row.retention_policy, externalBlobRefs: row.external_blob_refs, lastErrorCode: row.last_error_code, completionReceipt: null };
}

function zProcedure(input: { title: string; type: 'skill' | 'sop' | 'xyra_pattern'; body: string; successfulRunId?: string }) {
  if (!input.title.trim() || !input.body.trim()) throw new Error('INVALID_PROCEDURE');
  if (!['skill', 'sop', 'xyra_pattern'].includes(input.type)) throw new Error('INVALID_PROCEDURE_TYPE');
  return input;
}
