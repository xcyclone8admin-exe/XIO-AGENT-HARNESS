import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { canonicalJson, sha256Hex } from '@xyra/core';
import manifest from '../manifest';
import { BrainService } from './brain-service';
import { GOLDEN_RETRIEVAL } from '../tests/golden-retrieval';

const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const workspaceC = '019a0000-0000-7000-8000-000000000013';
const actor = '019a0000-0000-7000-8000-000000000021';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };
const scopeC = { tenantId: tenantA, workspaceId: workspaceC };
const load = (owner: string, relative: string): Migration[] => {
  const dir = fileURLToPath(new URL(relative, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) => migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')));
};
let db: Awaited<ReturnType<typeof openLocalStore>>;
let store: LocalScopedStore;
let brain: BrainService;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('brain', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B', workspaceC, tenantA, 'A private']);
  store = new LocalScopedStore(db);
  brain = new BrainService(store);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('BRAIN schema and provenance', () => {
  it('creates all manifest-owned relations', async () => {
    const found = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const names = new Set(found.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !names.has(name))).toEqual([]);
  });

  it('ingests versioned source chunks and returns source/version/chunk citations in keyword mode', async () => {
    const created = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Quarterly plan', trustLevel: 'user' }, content: 'The approved quarterly plan prioritizes customer retention and product reliability. Retention is measured monthly.', contentType: 'text/plain', chunkSize: 128, overlap: 12 });
    expect(created.chunkIds.length).toBeGreaterThan(0);
    const hits = await brain.search(scopeA, { query: 'customer retention', limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ sourceId: created.sourceId, sourceVersionId: created.versionId, untrusted: true });
    expect(hits[0]?.citation).toContain(created.versionId);
    expect(hits[0]?.content).toContain('retention');
  });

  it('measures Recall@10 against the independent labeled golden corpus', async () => {
    const relevantSources = new Map<string, string>();
    for (let distractor = 0; distractor < 20; distractor++) {
      await brain.ingest(scopeA, actor, { source: { sourceType: 'golden-distractor', title: `Unrelated operational note ${distractor}` }, content: `Quarterly operational planning note ${distractor} discusses office seating and building access, with no policy values or procedures.`, contentType: 'text/plain' });
    }
    for (const item of GOLDEN_RETRIEVAL) {
      const result = await brain.ingest(scopeA, actor, { source: { sourceType: 'golden-corpus', title: item.title, trustLevel: 'reviewed' }, content: item.content, contentType: 'text/plain' });
      relevantSources.set(item.id, result.sourceId);
    }
    let retrievedRelevant = 0;
    let totalRelevant = 0;
    for (const item of GOLDEN_RETRIEVAL) {
      const labeled = new Set([relevantSources.get(item.id)!]);
      totalRelevant += labeled.size;
      const hits = await brain.search(scopeA, { query: item.query, limit: 10 });
      retrievedRelevant += new Set(hits.map(hit => hit.sourceId).filter(id => labeled.has(id))).size;
    }
    const recallAt10 = retrievedRelevant / totalRelevant;
    console.log(`Recall@10: ${retrievedRelevant}/${totalRelevant} = ${recallAt10.toFixed(3)}`);
    expect({ recallAt10, retrievedRelevant, totalRelevant }).toMatchObject({ totalRelevant: 12 });
    expect(recallAt10).toBeGreaterThanOrEqual(0.8);
  });

  it('filters by tenant/workspace inside SQL candidates before retrieval scoring', async () => {
    await brain.ingest(scopeB, actor, { source: { sourceType: 'document', title: 'Private plan', trustLevel: 'user' }, content: 'Secret cobalt project owl codeword is confidential.', contentType: 'text/plain' });
    await brain.ingest(scopeC, actor, { source: { sourceType: 'document', title: 'Near duplicate', trustLevel: 'user' }, content: 'Secret cobalt project owl codeword is confidential.', contentType: 'text/plain' });
    expect(await brain.search(scopeA, { query: 'cobalt owl confidential', limit: 10 })).toEqual([]);
    const searchSql = readFileSync(fileURLToPath(new URL('./brain-service.ts', import.meta.url)), 'utf8');
    expect(searchSql).toMatch(/WHERE c\.tenant_id=\$1 AND c\.workspace_id=\$2[\s\S]{0,150}to_tsvector/);
    expect(searchSql).toMatch(/WHERE c\.tenant_id=\$1 AND c\.workspace_id=\$2[\s\S]{0,150}c\.embedding IS NOT NULL/);
  });

  it('keeps source versions and chunks append-only and rejects cross-scope linkage', async () => {
    const a = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Evidence', trustLevel: 'reviewed' }, content: 'Reviewed factual evidence.', contentType: 'text/plain' });
    await expect(store.query(scopeA, 'UPDATE brain_source_versions SET content_text=$1 WHERE id=$2', ['forged', a.versionId])).rejects.toThrow();
    await expect(store.query(scopeA, 'DELETE FROM brain_chunks WHERE id=$1', [a.chunkIds[0]])).rejects.toThrow();
    await expect(db.query('INSERT INTO brain_signals(id,tenant_id,workspace_id,source_id,source_version_id,signal_type,created_by) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)', [tenantA, workspaceA, '019a0000-0000-7000-8000-000000000099', a.versionId, 'x', actor])).rejects.toThrow();
  });
});

describe('governed truth lifecycle', () => {
  async function claim(object: string, start = '2026-01-01T00:00:00.000Z', predicate = 'lead', end?: string) {
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'record', title: 'Truth evidence', trustLevel: 'reviewed' }, content: `The project lead is ${object}.`, contentType: 'text/plain' });
    const signal = await brain.createSignal(scopeA, actor, source.sourceId, source.versionId, source.chunkIds[0] ?? null, 'extracted');
    return brain.createClaim(scopeA, actor, { signalId: signal.signalId, subject: 'project', predicate, object, confidence: 0.9, effectiveFrom: start, effectiveTo: end ?? null });
  }

  it('requires matching promotion provenance; agent cannot insert Facts directly', async () => {
    await db.query('TRUNCATE brain_contradictions,brain_facts,brain_promotions,brain_claims,brain_signals,brain_chunks,brain_source_versions,brain_sources CASCADE');
    const c = await claim('Avery');
    await expect(brain.promoteClaim(scopeA, actor, c.id, { type: 'reviewer', reference: 'review-1', reason: 'verified', reviewerId: '019a0000-0000-7000-8000-000000000099', authorized: true })).rejects.toThrow('REVIEWER_MISMATCH');
    await expect(store.query(scopeA, `INSERT INTO brain_facts(id,tenant_id,workspace_id,claim_id,subject,predicate,object,confidence,effective_from,promotion_id,created_by)
      VALUES (gen_random_uuid(),$1,$2,$3,'project','lead','Forged',0.9,'2026-01-01Z',gen_random_uuid(),$4)`, [tenantA, workspaceA, c.id, actor])).rejects.toThrow();
    const promoted = await brain.promoteClaim(scopeA, actor, c.id, { type: 'reviewer', reference: 'review-verified-1', reason: 'Source confirms value', reviewerId: actor, authorized: true });
    expect(promoted).toMatchObject({ supersedesId: null });
    const facts = await brain.factsAsOf(scopeA, '2026-03-01T00:00:00Z');
    expect(facts).toEqual([expect.objectContaining({ object: 'Avery', authority_ref: 'review-verified-1' })]);
  });

  it('records contradictions and preserves superseded truth for deterministic as-of dates', async () => {
    await db.query('TRUNCATE brain_contradictions,brain_facts,brain_promotions,brain_claims,brain_signals,brain_chunks,brain_source_versions,brain_sources CASCADE');
    const oldClaim = await claim('Avery', '2025-01-01T00:00:00.000Z');
    const old = await brain.promoteClaim(scopeA, actor, oldClaim.id, { type: 'policy', reference: 'policy:verified-import', reason: 'Approved policy import', authorized: true });
    const newClaim = await claim('Jordan', '2026-01-01T00:00:00.000Z');
    expect(newClaim.contradictions).toEqual([old.factId]);
    const next = await brain.promoteClaim(scopeA, actor, newClaim.id, { type: 'reviewer', reference: 'review-change', reason: 'New reviewed evidence', reviewerId: actor, authorized: true }, old.factId);
    expect(next.supersedesId).toBe(old.factId);
    expect((await brain.factsAsOf(scopeA, '2025-08-01T00:00:00Z')).map(row => row.object)).toContain('Avery');
    expect((await brain.factsAsOf(scopeA, '2026-08-01T00:00:00Z')).map(row => row.object)).toContain('Jordan');
  });

  it('finds conflicting older facts when a newer co-predicate fact never superseded them', async () => {
    const oldClaim = await claim('Taylor', '2024-01-01T00:00:00.000Z', 'account_owner');
    const old = await brain.promoteClaim(scopeA, actor, oldClaim.id, { type: 'policy', reference: 'policy:owner-history', reason: 'Imported historical record', authorized: true });
    const laterClaim = await claim('Casey', '2025-01-01T00:00:00.000Z', 'account_owner');
    const later = await brain.promoteClaim(scopeA, actor, laterClaim.id, { type: 'policy', reference: 'policy:owner-later', reason: 'Later record did not explicitly supersede', authorized: true });
    expect(later.supersedesId).toBeNull();
    const newClaim = await claim('Morgan', '2026-01-01T00:00:00.000Z', 'account_owner');
    expect(newClaim.contradictions).toContain(old.factId);
    expect(newClaim.contradictions).toContain(later.factId);
  });

  it('restores a predecessor when its temporary superseding fact expires', async () => {
    const oldClaim = await claim('Avery', '2025-01-01T00:00:00.000Z', 'project_lead');
    const old = await brain.promoteClaim(scopeA, actor, oldClaim.id, { type: 'policy', reference: 'policy:project-lead', reason: 'Approved policy import', authorized: true });
    const temporary = await claim('Jordan', '2026-01-01T00:00:00.000Z', 'project_lead', '2026-03-01T00:00:00.000Z');
    await brain.promoteClaim(scopeA, actor, temporary.id, { type: 'reviewer', reference: 'review:temporary-lead', reason: 'Temporary assignment', reviewerId: actor, authorized: true }, old.factId);
    const afterExpiry = await brain.factsAsOf(scopeA, '2026-08-01T00:00:00.000Z');
    expect(afterExpiry.filter(row => row.predicate === 'project_lead').map(row => row.object)).toEqual(['Avery']);
  });
});

describe('scoped memories and reviewed procedures', () => {
  it('accepts the explicit seven memory types and isolates memory listing', async () => {
    for (const memoryType of ['preference', 'fact', 'project_state', 'decision', 'procedure', 'tool_knowledge', 'historical_outcome'] as const) {
      await brain.addMemory(scopeA, actor, { memoryType, title: memoryType, content: `Workspace A ${memoryType}` });
    }
    await brain.addMemory(scopeB, actor, { memoryType: 'decision', title: 'Secret', content: 'Workspace B private content' });
    expect((await brain.listMemories(scopeA)).items).toHaveLength(7);
    expect((await brain.listMemories(scopeA)).items.some(row => row.content === 'Workspace B private content')).toBe(false);
    const first = await brain.listMemories(scopeA, { limit: 3, memoryType: 'decision' });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeNull();
    const pageOne = await brain.listMemories(scopeA, { limit: 3 });
    const pageTwo = await brain.listMemories(scopeA, { limit: 3, cursor: pageOne.nextCursor ?? undefined });
    expect(pageOne.items.length).toBe(3);
    expect(pageTwo.items.length).toBe(3);
    expect(pageOne.items.map(row => row.id).filter(id => pageTwo.items.some(next => next.id === id))).toEqual([]);
  });

  it('keeps workflow patterns as candidates until a reviewer appends an approved version', async () => {
    await expect(brain.proposeProcedure(scopeA, actor, { title: 'Pattern', type: 'xyra_pattern', body: 'Steps' })).rejects.toThrow('SUCCESSFUL_RUN_REQUIRED');
    const candidate = await brain.proposeProcedure(scopeA, actor, { title: 'Pattern', type: 'xyra_pattern', body: 'Steps', successfulRunId: '019a0000-0000-7000-8000-000000000088' });
    await expect(brain.reviewProcedure(scopeA, actor, '019a0000-0000-7000-8000-000000000099', 'approved')).rejects.toThrow('PROCEDURE_CANDIDATE_NOT_FOUND');
    const approved = await brain.reviewProcedure(scopeA, actor, candidate.procedureId, 'approved');
    const rows = await store.query<Record<string, unknown>>(scopeA, 'SELECT version,status,reviewed_by FROM brain_procedures WHERE procedure_id=(SELECT procedure_id FROM brain_procedures WHERE id=$1) ORDER BY version', [candidate.procedureId]);
    expect(rows.rows).toEqual([expect.objectContaining({ version: 1, status: 'candidate', reviewed_by: null }), expect.objectContaining({ version: 2, status: 'approved', reviewed_by: actor })]);
    await expect(store.query(scopeA, 'UPDATE brain_procedures SET status=$1 WHERE id=$2', ['approved', candidate.procedureId])).rejects.toThrow();
    expect(approved.procedureId).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('source erasure coordination and retention evidence', () => {
  it('retains Bus approval evidence and leaves data pending while CLOUD cannot reference-check blobs', async () => {
    const blobRef = '019a0000-0000-7000-8000-000000000091';
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Erase request fixture', trustLevel: 'user', retention: 'seven_years', externalBlobRefs: [blobRef] }, content: 'Source text stays until coordinated erase approval.', contentType: 'text/plain' });
    const requestId = '019a0000-0000-7000-8000-000000000092';
    const inputHash = await sha256Hex(canonicalJson({ sourceId: source.sourceId }));
    await db.query(`INSERT INTO approval_requests(id,tenant_id,workspace_id,capability_id,input_hash,requested_by,reason,expires_at)
      VALUES ($1,$2,$3,'brain.sources.erase',$4,$5,'authorized test erase',now()+interval '1 hour')`, [requestId, tenantA, workspaceA, inputHash, actor]);
    await db.query(`INSERT INTO approval_decisions(id,tenant_id,workspace_id,request_id,decided_by,decision,reason)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'approved','reviewed')`, [tenantA, workspaceA, requestId, actor]);
    const job = await brain.requestSourceErasure(scopeA, actor, requestId, { sourceId: source.sourceId });
    expect(job).toMatchObject({ status: 'waiting_cloud', attempts: 0, retentionPolicy: 'seven_years', externalBlobRefs: [blobRef], lastErrorCode: 'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE' });
    expect(await brain.requestSourceErasure(scopeA, actor, requestId, { sourceId: source.sourceId })).toMatchObject({ id: job.id, attempts: 0 });
    expect((await brain.search(scopeA, { query: 'coordinated erase approval' })).length).toBeGreaterThan(0);
    const retryInput = { erasureId: job.id };
    const retryApprovalId = '019a0000-0000-7000-8000-000000000094';
    await expect(brain.retrySourceErasure(scopeA, actor, undefined, retryInput)).rejects.toThrow('ERASURE_APPROVAL_REQUIRED');
    const retried = await brain.retrySourceErasure(scopeA, actor, retryApprovalId, retryInput);
    expect(retried).toMatchObject({ status: 'waiting_cloud', attempts: 1 });
    const attempts = await store.query<Record<string, unknown>>(scopeA, 'SELECT outcome,retention_policy,error_code,deleted_blob_refs FROM brain_source_erasure_attempts WHERE erasure_id=$1 ORDER BY occurred_at,id', [job.id]);
    expect(attempts.rows).toHaveLength(3);
    expect(attempts.rows.every(row => row.outcome === 'waiting_cloud' && row.retention_policy === 'seven_years' && row.error_code === 'PRIVILEGED_PURGE_AND_CLOUD_REFERENCE_API_UNAVAILABLE' && JSON.stringify(row.deleted_blob_refs) === '[]')).toBe(true);
    expect(await brain.sourceErasureStatus(scopeA, { erasureId: job.id })).toMatchObject({ status: 'waiting_cloud', attempts: 1, audit: { items: expect.any(Array) } });
    await expect(store.query(scopeA, "UPDATE brain_source_erasures SET status='complete' WHERE id=$1", [job.id])).rejects.toThrow();
    await expect(brain.retrySourceErasure(scopeB, actor, retryApprovalId, retryInput)).rejects.toThrow('ERASURE_NOT_FOUND');
  });
});
