import { createHash } from 'node:crypto';
import { canonicalJson, uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { ClaimDraft, IngestDraft, MemoryDraft, MemoryListInput, ProcedureListInput, SearchInput, type MemoryType } from '../contracts';
import { BrainErasureService } from './brain-erasure-service';
import type { CloudErasureClient } from './erasure-cloud';
import { BrainIngestionBeginInput, BrainIngestionBeginResult, BrainIngestionFinalizeInput, BrainIngestionFinalizationReceipt, BrainIngestionStatus, type CloudBrainIngestionClient } from './cloud-ingestion';
import { brainReferenceSetDigest, brainSourceVersionV2 } from './erasure-fingerprint';

type IdRow = Record<string, unknown> & { id: string };
type SearchRow = Record<string, unknown> & { source_id: string; source_version_id: string; chunk_id: string; content_text: string; rank: number };
const uuid = () => uuidv7();

/** Source-backed BRAIN data access. Every read/write carries an explicit tenant/workspace scope. */
export class BrainService {
  private readonly erasures: BrainErasureService;

  constructor(private readonly store: LocalScopedStore, cloud?: CloudErasureClient) {
    this.erasures = new BrainErasureService(store, cloud);
  }

  requestSourceErasure(scope: Scope, actorId: string, verifiedApprovalId: string | undefined, input: unknown) {
    return this.erasures.request(scope, actorId, verifiedApprovalId, input);
  }

  retrySourceErasure(scope: Scope, actorId: string, verifiedApprovalId: string | undefined, input: unknown) {
    return this.erasures.retry(scope, actorId, verifiedApprovalId, input);
  }

  sourceErasureStatus(scope: Scope, input: unknown) {
    return this.erasures.status(scope, input);
  }

  async beginCloudIngestion(scope: Scope, mode: 'with_objects' | 'text_only', cloud: CloudBrainIngestionClient, sourceId = uuid()) {
    const result = BrainIngestionBeginResult.parse(await cloud.begin(BrainIngestionBeginInput.parse({ protocolVersion: 'cloud-ingest-v2', sourceId, mode })));
    if (result.protocolVersion !== 'cloud-ingest-v2' || result.sourceId !== sourceId || result.tenantId !== scope.tenantId ||
      result.workspaceId !== scope.workspaceId || result.mode !== mode) throw new Error('CLOUD_INGESTION_BINDING_MISMATCH');
    return result;
  }

  /** Finalization is accepted only from the authenticated Cloud client and is persisted after local binding checks. */
  async finalizeCloudIngestion(scope: Scope, sourceVersionId: string, ingestionId: string, cloud: CloudBrainIngestionClient) {
    const local = await this.store.withServerScope(scope, 'brain_erasure', undefined, async (tx) => {
      const result = await tx.query<Record<string, unknown> & { id: string; source_id: string; content_digest: string; ingestion_id: string | null; status: string }>(
        `SELECT id,source_id,content_digest,ingestion_id,status FROM brain_source_blob_reference_sets
         WHERE tenant_id=$1 AND workspace_id=$2 AND source_version_id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, sourceVersionId]);
      return result.rows[0];
    });
    if (!local || local.ingestion_id !== ingestionId || local.status === 'unknown') throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
    const source = await this.store.query<Record<string, unknown> & { id: string; content_hash: string }>(scope,
      `SELECT s.id,v.content_hash FROM brain_sources s JOIN brain_source_versions v
       ON (v.tenant_id,v.workspace_id,v.source_id)=(s.tenant_id,s.workspace_id,s.id)
       WHERE s.tenant_id=$1 AND s.workspace_id=$2 AND v.id=$3`, [scope.tenantId, scope.workspaceId, sourceVersionId]);
    if (!source.rows[0] || source.rows[0].id !== local.source_id || source.rows[0].content_hash !== local.content_digest) throw new Error('SOURCE_CONTENT_VERSION_MISMATCH');
    const finalize = BrainIngestionFinalizeInput.parse({ protocolVersion: 'cloud-ingest-v2', sourceVersionId, contentDigest: local.content_digest });
    await cloud.finalize(ingestionId, finalize);
    const state = BrainIngestionStatus.parse(await cloud.status(ingestionId));
    if (state.status === 'invalidated') {
      await this.markReferenceSetUnavailable(scope, sourceVersionId, 'CLOUD_INGESTION_INVALIDATED');
      throw new Error('CLOUD_INGESTION_INVALIDATED');
    }
    if (state.status !== 'finalized') throw new Error('CLOUD_INGESTION_PENDING');
    const receipt = BrainIngestionFinalizationReceipt.parse(state.receipt);
    if (receipt.ingestionId !== ingestionId || receipt.sourceId !== local.source_id || receipt.sourceVersionId !== sourceVersionId ||
      receipt.tenantId !== scope.tenantId || receipt.workspaceId !== scope.workspaceId || receipt.contentDigest !== local.content_digest ||
      receipt.status !== 'finalized') throw new Error('CLOUD_INGESTION_RECEIPT_BINDING_MISMATCH');
    const refs = [...receipt.objectRefIds].sort();
    if (new Set(refs).size !== refs.length || canonicalJson(receipt.objectRefIds) !== canonicalJson(refs) ||
      (receipt.referenceState === 'verified_empty') !== (refs.length === 0)) throw new Error('CLOUD_INGESTION_REFERENCE_SET_INVALID');
    const expectedReferenceDigest = await brainReferenceSetDigest(receipt.sourceId, receipt.sourceVersionId, refs);
    if (receipt.referenceSetDigest !== expectedReferenceDigest) throw new Error('CLOUD_INGESTION_REFERENCE_DIGEST_MISMATCH');
    const expectedSourceVersion = await brainSourceVersionV2({ sourceId: receipt.sourceId, sourceVersionId, tenantId: scope.tenantId,
      workspaceId: scope.workspaceId, contentDigest: receipt.contentDigest, objectRefIds: refs, referenceStateVersion: receipt.referenceStateVersion });
    if (receipt.sourceVersion !== expectedSourceVersion) throw new Error('CLOUD_INGESTION_SOURCE_VERSION_MISMATCH');
    await this.store.withServerScope(scope, 'brain_erasure', undefined, async (tx) => {
      const current = await tx.query<Record<string, unknown> & { content_hash: string }>(`SELECT content_hash FROM brain_source_versions
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, sourceVersionId]);
      const state = await tx.query<Record<string, unknown> & { content_digest: string; ingestion_id: string | null }>(`SELECT content_digest,ingestion_id
        FROM brain_source_blob_reference_sets WHERE tenant_id=$1 AND workspace_id=$2 AND source_version_id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, sourceVersionId]);
      if (!current.rows[0] || current.rows[0].content_hash !== receipt.contentDigest || !state.rows[0] ||
        state.rows[0].content_digest !== receipt.contentDigest || state.rows[0].ingestion_id !== ingestionId) throw new Error('SOURCE_REFERENCE_SNAPSHOT_STALE');
      await tx.query(`UPDATE brain_sources SET cloud_object_ref_ids=$1::jsonb,updated_at=now() WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4`,
        [JSON.stringify(refs), scope.tenantId, scope.workspaceId, local.source_id]);
      await tx.query(`UPDATE brain_source_blob_reference_sets SET status=$1,object_ref_ids=$2::jsonb,source_version=$3,
        reference_state_version=$4,reference_set_digest=$5,finalized_at=$6,attempts=attempts+1,last_error_code=NULL,updated_at=now()
        WHERE tenant_id=$7 AND workspace_id=$8 AND source_version_id=$9`,
      [receipt.referenceState, JSON.stringify(refs), receipt.sourceVersion, receipt.referenceStateVersion, receipt.referenceSetDigest,
        receipt.finalizedAt, scope.tenantId, scope.workspaceId, sourceVersionId]);
    });
    return receipt;
  }

  private async markReferenceSetUnavailable(scope: Scope, sourceVersionId: string, code: string) {
    await this.store.withServerScope(scope, 'brain_erasure', undefined, async (tx) => {
      await tx.query(`UPDATE brain_source_blob_reference_sets SET status='unavailable',attempts=LEAST(20,attempts+1),
        last_error_code=$1,updated_at=now() WHERE tenant_id=$2 AND workspace_id=$3 AND source_version_id=$4`,
      [code.slice(0,160).replace(/[^a-zA-Z0-9_.:-]/g,'_'), scope.tenantId, scope.workspaceId, sourceVersionId]);
    });
  }

  async ingest(scope: Scope, actorId: string, input: unknown) {
    const draft = IngestDraft.parse(input);
    const sourceId = draft.sourceId ?? uuid();
    const versionId = uuid();
    const now = draft.capturedAt ?? new Date().toISOString();
    const normalizedContent = draft.content.normalize('NFC').replace(/\r\n?/g, '\n');
    const hash = createHash('sha256').update(normalizedContent, 'utf8').digest('hex');
    const chunks = splitChunks(normalizedContent, draft.chunkSize, draft.overlap);
    if (draft.embeddings && draft.embeddings.length !== chunks.length) throw new Error('EMBEDDING_CHUNK_COUNT_MISMATCH');
    const dimension = draft.embeddings?.[0]?.length;
    if (draft.embeddings?.some((vector) => vector.length !== dimension)) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
    const chunkIds = chunks.map(() => uuid());
    await this.store.query(scope, `INSERT INTO brain_sources(id,tenant_id,workspace_id,source_type,title,uri,trust_level,retention,external_blob_refs,cloud_object_ref_ids,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NULL,$10)`, [sourceId, scope.tenantId, scope.workspaceId, draft.source.sourceType, draft.source.title, draft.source.uri ?? null, draft.source.trustLevel, draft.source.retention, JSON.stringify(draft.source.externalBlobRefs), actorId]);
    await this.store.query(scope, `INSERT INTO brain_source_versions(id,tenant_id,workspace_id,source_id,version,content_hash,content_type,content_text,captured_at,created_by)
      VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`, [versionId, scope.tenantId, scope.workspaceId, sourceId, hash, draft.contentType, normalizedContent, now, actorId]);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]!;
      const vector = draft.embeddings?.[i];
      await this.store.query(scope, `INSERT INTO brain_chunks(id,tenant_id,workspace_id,source_id,source_version_id,ordinal,content_hash,content_text,embedding,embedding_model,embedding_version,dim,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13)`, [chunkIds[i], scope.tenantId, scope.workspaceId, sourceId, versionId, i, createHash('sha256').update(content).digest('hex'), content, vector ? `[${vector.join(',')}]` : null, vector ? draft.embeddingModel : null, vector ? draft.embeddingVersion : null, vector?.length ?? null, actorId]);
    }
    await this.store.withServerScope(scope, 'brain_erasure', undefined, async (tx) => {
      await tx.query(`INSERT INTO brain_source_blob_reference_sets(id,tenant_id,workspace_id,source_id,source_version_id,content_digest,
        ingestion_id,status,attempts,last_error_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)
        ON CONFLICT (tenant_id,workspace_id,source_version_id) DO NOTHING`,
      [uuid(), scope.tenantId, scope.workspaceId, sourceId, versionId, hash, draft.cloudIngestionId ?? null,
        draft.cloudIngestionId ? 'pending' : 'unknown', draft.cloudIngestionId ? null : 'CLOUD_INGESTION_REQUIRED']);
    });
    return { sourceId, sourceVersionId: versionId, versionId, chunkIds, contentDigest: hash };
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

function zProcedure(input: { title: string; type: 'skill' | 'sop' | 'xyra_pattern'; body: string; successfulRunId?: string }) {
  if (!input.title.trim() || !input.body.trim()) throw new Error('INVALID_PROCEDURE');
  if (!['skill', 'sop', 'xyra_pattern'].includes(input.type)) throw new Error('INVALID_PROCEDURE_TYPE');
  return input;
}
