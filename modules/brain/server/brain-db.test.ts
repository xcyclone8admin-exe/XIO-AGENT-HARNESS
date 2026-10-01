import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { canonicalJson, sha256Hex, uuidv7 } from '@xyra/core';
import type { CloudBrainIngestionFinalizationReceipt } from '@xyra/contracts';
import manifest from '../manifest';
import { BrainService } from './brain-service';
import type { CloudErasureClient } from './erasure-cloud';
import { brainReferenceSetDigest, brainSourceVersionV2 } from './erasure-fingerprint';
import type { CloudBrainIngestionClient } from './cloud-ingestion';
import { SYNC_PROTOCOL_VERSION, SYNC_SCHEMA_VERSION, type PushRequest, type PushResponse } from '@xyra/contracts';
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

async function acknowledgeReferenceSync(scope: typeof scopeA, source: { sourceId: string; versionId: string; contentDigest: string }, refs: string[]) {
  const hlc = '1790726400000-0000-test';
  const fieldWrites = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, hlc, baseHlc: null }]));
  const changes: PushRequest['changes'] = [
    { table: 'brain_sources', id: source.sourceId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, op: 'upsert', fields: fieldWrites({ cloud_object_ref_ids: refs }), hlc },
    { table: 'brain_source_versions', id: source.versionId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, op: 'append', fields: fieldWrites({ source_id: source.sourceId, content_hash: source.contentDigest }), hlc },
  ];
  const request: PushRequest = { protocolVersion: SYNC_PROTOCOL_VERSION, schemaVersion: SYNC_SCHEMA_VERSION, nodeId: 'brain-test',
    idempotencyKey: `brain-ack-${source.versionId}`, changes };
  const response: PushResponse = { accepted: 0, conflicts: 0, serverSeq: '31', rejected: [], conflictHistory: [], replayed: false,
    changeOutcomes: changes.map((change, index) => ({ index, changeId: change.id, table: change.table, rowId: change.id, outcome: 'unchanged' as const,
      appliedFields: [], unchangedFields: Object.keys(change.fields).sort(), conflictedFields: [] })) };
  return brain.acceptCloudReferenceSync(scope, request, response);
}

async function trustCloudFinalization(scope: typeof scopeA, source: { sourceId: string; versionId: string; contentDigest: string }, ingestionId = uuidv7(), overrides: Partial<CloudBrainIngestionFinalizationReceipt> = {}) {
  await brain.stageCloudReference(scope, { mode: 'text_only', sourceId: source.sourceId, sourceVersionId: source.versionId, ingestionId });
  const refs: string[] = [];
  await acknowledgeReferenceSync(scope, source, refs);
  const receipt = {
    protocolVersion: 'cloud-ingest-v2' as const, status: 'finalized' as const, ingestionId,
    tenantId: scope.tenantId, workspaceId: scope.workspaceId, sourceId: source.sourceId, sourceVersionId: source.versionId,
    contentDigest: source.contentDigest, referenceState: 'verified_empty' as const, objectRefIds: refs,
    referenceSetDigest: await brainReferenceSetDigest(source.sourceId, source.versionId, refs),
    referenceStateVersion: 1, finalizedAt: new Date().toISOString(),
    sourceVersion: await brainSourceVersionV2({ sourceId: source.sourceId, sourceVersionId: source.versionId,
      tenantId: scope.tenantId, workspaceId: scope.workspaceId, contentDigest: source.contentDigest,
      objectRefIds: refs, referenceStateVersion: 1 }),
    ...overrides,
  };
  const cloud: CloudBrainIngestionClient = {
    async begin() { throw new Error('unused'); }, async finalize() { return receipt; },
    async status() { return { protocolVersion: 'cloud-ingest-v2', status: 'finalized', receipt }; },
  };
  await brain.finalizeCloudIngestion(scope, source.versionId, ingestionId, cloud);
  return receipt;
}

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

  it.each([
    ['tenant', { tenantId: tenantB }],
    ['source', { sourceId: '019a0000-0000-7000-8000-000000000099' }],
    ['ingestion', { ingestionId: '019a0000-0000-7000-8000-000000000098' }],
  ] as const)('rejects a Cloud-shaped finalization receipt with a swapped %s binding', async (_label, overrides) => {
    const ingestionId = uuidv7();
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Receipt binding', trustLevel: 'user' }, cloudIngestionId: ingestionId, content: 'Receipt binding test.', contentType: 'text/plain' });
    await expect(trustCloudFinalization(scopeA, source, ingestionId, overrides)).rejects.toThrow('CLOUD_INGESTION_RECEIPT_BINDING_MISMATCH');
    const saved = await store.query<Record<string, unknown> & { cloud_object_ref_ids: unknown }>(scopeA,
      'SELECT cloud_object_ref_ids FROM brain_sources WHERE id=$1', [source.sourceId]);
    expect(saved.rows[0]?.cloud_object_ref_ids).toEqual([]);
  });

  it('stages Cloud-issued object refs as pending and requires the current source version', async () => {
    const ingestionId = uuidv7();
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Cloud ref staging', trustLevel: 'user' }, cloudIngestionId: ingestionId, content: 'Cloud ref staging content.', contentType: 'text/plain' });
    const objectRefId = '019a0000-0000-7000-8000-000000000077';
    const staged = await brain.stageCloudReference(scopeA, { mode: 'with_objects', sourceId: source.sourceId, sourceVersionId: source.versionId, ingestionId, objectRefId });
    expect(staged).toMatchObject({ sourceId: source.sourceId, sourceVersionId: source.versionId, ingestionId, objectRefId,
      objectRefIds: [objectRefId], contentDigest: source.contentDigest, referenceState: 'pending', syncRequired: true });
    expect(staged.referenceSetDigest).toBe(await brainReferenceSetDigest(source.sourceId, source.versionId, [objectRefId]));
    expect(await brain.stageCloudReference(scopeA, { mode: 'with_objects', sourceId: source.sourceId, sourceVersionId: source.versionId, ingestionId, objectRefId }))
      .toMatchObject({ objectRefIds: [objectRefId], referenceState: 'pending', syncRequired: true });
    await expect(brain.stageCloudReference(scopeA, { mode: 'with_objects', sourceId: source.sourceId, sourceVersionId: uuidv7(), ingestionId, objectRefId }))
      .rejects.toThrow('SOURCE_VERSION_STALE');
    const rows = await store.query<Record<string, unknown> & { cloud_object_ref_ids: unknown; status: string; object_ref_ids: unknown }>(scopeA,
      `SELECT s.cloud_object_ref_ids,r.status,r.object_ref_ids FROM brain_sources s JOIN brain_source_blob_reference_sets r
       ON (r.tenant_id,r.workspace_id,r.source_id)=(s.tenant_id,s.workspace_id,s.id) WHERE s.id=$1 AND r.source_version_id=$2`, [source.sourceId, source.versionId]);
    expect(rows.rows[0]).toMatchObject({ cloud_object_ref_ids: [objectRefId], status: 'pending', object_ref_ids: [objectRefId] });
  });

  it('accepts only a fully bound native sync acknowledgement and persists idempotent evidence', async () => {
    const ingestionId = uuidv7();
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Sync ack', trustLevel: 'user' }, cloudIngestionId: ingestionId, content: 'Sync acknowledgement source.', contentType: 'text/plain' });
    const objectRefId = '019a0000-0000-7000-8000-000000000078';
    await brain.stageCloudReference(scopeA, { mode: 'with_objects', sourceId: source.sourceId, sourceVersionId: source.versionId, ingestionId, objectRefId });
    const secondIngestionId = uuidv7();
    const secondSource = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Second sync ack', trustLevel: 'user' }, cloudIngestionId: secondIngestionId, content: 'Second sync acknowledgement source.', contentType: 'text/plain' });
    await brain.stageCloudReference(scopeA, { mode: 'text_only', sourceId: secondSource.sourceId, sourceVersionId: secondSource.versionId, ingestionId: secondIngestionId });
    const fields = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, { value, hlc: '1790726400000-0000-test', baseHlc: null }]));
    const changes: PushRequest['changes'] = [
      { table: 'brain_sources', id: source.sourceId, tenantId: tenantA, workspaceId: workspaceA, op: 'upsert', fields: fields({ cloud_object_ref_ids: [objectRefId] }), hlc: '1790726400000-0000-test' },
      { table: 'brain_source_versions', id: source.versionId, tenantId: tenantA, workspaceId: workspaceA, op: 'append', fields: fields({ source_id: source.sourceId, content_hash: source.contentDigest }), hlc: '1790726400000-0000-test' },
      { table: 'brain_sources', id: secondSource.sourceId, tenantId: tenantA, workspaceId: workspaceA, op: 'upsert', fields: fields({ cloud_object_ref_ids: [] }), hlc: '1790726400000-0000-test' },
      { table: 'brain_source_versions', id: secondSource.versionId, tenantId: tenantA, workspaceId: workspaceA, op: 'append', fields: fields({ source_id: secondSource.sourceId, content_hash: secondSource.contentDigest }), hlc: '1790726400000-0000-test' },
    ];
    const request: PushRequest = { protocolVersion: SYNC_PROTOCOL_VERSION, schemaVersion: SYNC_SCHEMA_VERSION, nodeId: 'brain-test', idempotencyKey: 'brain-ack-idempotency-01', changes };
    const response: PushResponse = { accepted: 0, conflicts: 0, serverSeq: '31', rejected: [], conflictHistory: [], replayed: false,
      changeOutcomes: changes.map((change, index) => ({ index, changeId: change.id, table: change.table, rowId: change.id, outcome: 'unchanged' as const,
        appliedFields: [], unchangedFields: Object.keys(change.fields).sort(), conflictedFields: [] })) };
    let cloudFinalizeCalls = 0;
    const cloud: CloudBrainIngestionClient = { async begin() { throw new Error('unused'); }, async finalize() { cloudFinalizeCalls++; throw new Error('must not finalize'); }, async status() { throw new Error('unused'); } };
    await expect(brain.finalizeCloudIngestion(scopeA, source.versionId, ingestionId, cloud)).rejects.toThrow('SOURCE_REFERENCE_SYNC_NOT_ACCEPTED');
    expect(cloudFinalizeCalls).toBe(0);
    await expect(brain.acceptCloudReferenceSync(scopeA, request, { ...response, conflicts: 1 })).rejects.toThrow('SYNC_PUSH_NOT_FULLY_ACCEPTED');
    const changedRequest = { ...request, changes: request.changes.map((change) => change.table === 'brain_sources'
      ? { ...change, fields: { ...change.fields, cloud_object_ref_ids: { ...change.fields.cloud_object_ref_ids!, value: [] } } }
      : change) };
    await expect(brain.acceptCloudReferenceSync(scopeA, changedRequest, response)).rejects.toThrow('SYNC_REFERENCE_REQUEST_CONTENT_MISMATCH');
    const acks = await brain.acceptCloudReferenceSync(scopeA, request, response);
    expect(acks).toHaveLength(2);
    expect(acks).toContainEqual(expect.objectContaining({ status: 'sync_accepted', idempotencyKey: request.idempotencyKey, serverSeq: response.serverSeq,
      sourceId: source.sourceId, sourceVersionId: source.versionId, contentDigest: source.contentDigest, objectRefIds: [objectRefId] }));
    expect(acks).toContainEqual(expect.objectContaining({ status: 'sync_accepted', idempotencyKey: request.idempotencyKey, serverSeq: response.serverSeq,
      sourceId: secondSource.sourceId, sourceVersionId: secondSource.versionId, contentDigest: secondSource.contentDigest, objectRefIds: [] }));
    expect(await brain.acceptCloudReferenceSync(scopeA, request, { ...response, replayed: true })).toHaveLength(2);
    const row = await store.query<Record<string, unknown> & { status: string; sync_idempotency_key: string; sync_server_seq: string; sync_request_digest: string; sync_outcome_evidence: unknown }>(scopeA,
      `SELECT status,sync_idempotency_key,sync_server_seq,sync_request_digest,sync_outcome_evidence FROM brain_source_blob_reference_sets WHERE source_version_id=$1`, [source.versionId]);
    expect(row.rows[0]).toMatchObject({ status: 'sync_accepted', sync_idempotency_key: request.idempotencyKey, sync_server_seq: response.serverSeq });
    expect(row.rows[0]?.sync_request_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0]?.sync_outcome_evidence).toMatchObject({ acknowledgement: { sourceId: source.sourceId, sourceVersionId: source.versionId },
      responseDigest: expect.stringMatching(/^[0-9a-f]{64}$/), outcomes: [{ outcome: 'unchanged' }, { outcome: 'unchanged' }] });
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
  it('does not infer a verified empty reference snapshot from an absent legacy field', async () => {
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Unknown ref state', trustLevel: 'user' }, content: 'Keep until Cloud finalization exists.', contentType: 'text/plain' });
    const job = await brain.requestSourceErasure(scopeA, actor, uuidv7(), { sourceId: source.sourceId });
    expect(job).toMatchObject({ status: 'waiting_cloud', lastErrorCode: 'CLOUD_INGESTION_REQUIRED' });
    expect((await store.query(scopeA, 'SELECT id FROM brain_sources WHERE id=$1', [source.sourceId])).rows).toHaveLength(1);
  });

  it('purges local source and derived data only after a bound durable Cloud claim', async () => {
    const ingestionId = uuidv7();
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Cloud claim fixture', trustLevel: 'user' }, cloudIngestionId: ingestionId, content: 'Private disposable claim evidence.', contentType: 'text/plain' });
    const receipt = await trustCloudFinalization(scopeA, source, ingestionId);
    const sourceVersion = receipt.sourceVersion;
    const approvalId = uuidv7();
    const operationId = uuidv7();
    const reservationId = uuidv7();
    const claimId = uuidv7();
    const auditReceiptId = uuidv7();
    const requestDigest = `sha256:${await sha256Hex('cloud-request')}`;
    let cloudStatus = 'eligible';
    const response = (attemptId: string, status = cloudStatus, claim: null | { claimId: string; claimGeneration: number } = null) => ({
      protocolVersion: 'cloud-erasure-v2', operationId, erasureId: erasure!.id, attemptId, attemptNo: 1, requestDigest,
      source: { kind: 'brain_source', id: source.sourceId }, sourceVersion, status,
      eligibility: { reservationId, referenceStateVersion: 'refs-4', holdStateVersion: 'holds-2', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      claim, objects: [], auditReceiptId: status === 'completed' ? auditReceiptId : null, updatedAt: new Date().toISOString(),
    });
    let erasure: { id: string; attemptId: string } | undefined;
    const cloud: CloudErasureClient = {
      async begin(input) { erasure = { id: input.erasureId, attemptId: input.attemptId }; return response(input.attemptId); },
      async get() { if (!erasure) throw new Error('OPERATION_NOT_FOUND'); return response(erasure.attemptId); },
      async claimLocalPurge(_id, input) { cloudStatus = 'purge_claimed'; return response(input.attemptId, cloudStatus, { claimId, claimGeneration: 1 }); },
      async acknowledgeLocalPurge(_id, input) { expect(input.localPurgeReceiptDigest).toMatch(/^sha256:/); cloudStatus = 'completed'; return response(input.attemptId, cloudStatus, { claimId, claimGeneration: 1 }); },
      async abortLocalPurge(_id, input) { return response(input.attemptId, 'aborted', { claimId: input.claimId, claimGeneration: input.claimGeneration }); },
    };
    const erasing = new BrainService(store, cloud);
    const job = await erasing.requestSourceErasure(scopeA, actor, approvalId, { sourceId: source.sourceId });
    erasure = { id: job.id, attemptId: (await store.query<Record<string, unknown> & { attempt_id: string }>(scopeA,
      'SELECT attempt_id FROM brain_source_erasures WHERE id=$1', [job.id])).rows[0]!.attempt_id };
    expect(job).toMatchObject({ status: 'complete', sourceId: source.sourceId, cloudOperationId: operationId, cloudAuditReceiptId: auditReceiptId });
    expect((await store.query(scopeA, 'SELECT id FROM brain_sources WHERE id=$1', [source.sourceId])).rows).toHaveLength(0);
    expect((await store.query(scopeA, 'SELECT id FROM brain_chunks WHERE source_id=$1', [source.sourceId])).rows).toHaveLength(0);
    expect((await store.query(scopeA, `SELECT receipt_kind,evidence_digest FROM brain_source_erasure_receipts WHERE erasure_id=$1`, [job.id])).rows)
      .toEqual([expect.objectContaining({ receipt_kind: 'local_purge', evidence_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })]);
    await expect(store.query(scopeA, 'DELETE FROM brain_source_erasure_receipts WHERE erasure_id=$1', [job.id])).rejects.toThrow();
  });

  it('records a no-purge abort when the source changes after eligibility and before local purge', async () => {
    const ingestionId = uuidv7();
    const source = await brain.ingest(scopeA, actor, { source: { sourceType: 'document', title: 'Stale eligibility fixture', trustLevel: 'user' }, cloudIngestionId: ingestionId, content: 'Keep this source because its version changed.', contentType: 'text/plain' });
    const receipt = await trustCloudFinalization(scopeA, source, ingestionId);
    const sourceVersion = receipt.sourceVersion;
    const operationId = uuidv7();
    const reservationId = uuidv7();
    const claimId = uuidv7();
    const auditReceiptId = uuidv7();
    const requestDigest = `sha256:${await sha256Hex('stale-cloud-request')}`;
    let erasureId = '';
    let attemptId = '';
    let cloudStatus = 'eligible';
    const response = (status = cloudStatus) => ({
      protocolVersion: 'cloud-erasure-v2', operationId, erasureId, attemptId, attemptNo: 1, requestDigest,
      source: { kind: 'brain_source', id: source.sourceId }, sourceVersion, status,
      eligibility: { reservationId, referenceStateVersion: 'refs-5', holdStateVersion: 'holds-2', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      claim: status === 'purge_claimed' ? { claimId, claimGeneration: 3 } : null,
      objects: [], auditReceiptId: status === 'aborted' ? auditReceiptId : null, updatedAt: new Date().toISOString(),
    });
    const cloud: CloudErasureClient = {
      async begin(input) { erasureId = input.erasureId; attemptId = input.attemptId; return response(); },
      async get() { return response(); },
      async claimLocalPurge() {
        await store.query(scopeA, `INSERT INTO brain_source_versions(id,tenant_id,workspace_id,source_id,version,content_hash,content_type,content_text,captured_at,created_by)
          VALUES ($1,$2,$3,$4,2,$5,'text/plain','new version arrived after eligibility',now(),$6)`,
        [uuidv7(), scopeA.tenantId, scopeA.workspaceId, source.sourceId, await sha256Hex('new version arrived'), actor]);
        cloudStatus = 'purge_claimed';
        return response();
      },
      async acknowledgeLocalPurge() { throw new Error('MUST_NOT_ACK_PURGE'); },
      async abortLocalPurge(_id, input) { expect(input.claimGeneration).toBe(3); return response('aborted'); },
    };
    const erasing = new BrainService(store, cloud);
    const job = await erasing.requestSourceErasure(scopeA, actor, uuidv7(), { sourceId: source.sourceId });
    expect(job).toMatchObject({ status: 'aborted', sourceId: source.sourceId });
    expect((await store.query(scopeA, 'SELECT id FROM brain_sources WHERE id=$1', [source.sourceId])).rows).toHaveLength(1);
    expect((await store.query(scopeA, `SELECT id FROM brain_source_erasure_receipts WHERE erasure_id=$1 AND receipt_kind='local_purge'`, [job.id])).rows).toHaveLength(0);
    expect((await store.query(scopeA, `SELECT id,evidence_digest FROM brain_source_erasure_receipts WHERE erasure_id=$1 AND receipt_kind='no_purge_abort'`, [job.id])).rows)
      .toEqual([expect.objectContaining({ evidence_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })]);
    expect(erasureId).toBe(job.id);
    expect(attemptId).toMatch(/[0-9a-f-]{36}/);
  });

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
    expect(job).toMatchObject({ status: 'unavailable', attempts: 0, retentionPolicy: 'seven_years', externalBlobRefs: [blobRef], lastErrorCode: 'SOURCE_REFERENCES_UNAVAILABLE' });
    expect(await brain.requestSourceErasure(scopeA, actor, requestId, { sourceId: source.sourceId })).toMatchObject({ id: job.id, attempts: 0, status: 'unavailable' });
    expect((await brain.search(scopeA, { query: 'coordinated erase approval' })).length).toBeGreaterThan(0);
    const retryInput = { erasureId: job.id };
    const retryApprovalId = '019a0000-0000-7000-8000-000000000094';
    await expect(brain.retrySourceErasure(scopeA, actor, undefined, retryInput)).rejects.toThrow('ERASURE_APPROVAL_REQUIRED');
    const retried = await brain.retrySourceErasure(scopeA, actor, retryApprovalId, retryInput);
    expect(retried).toMatchObject({ status: 'unavailable', attempts: 1, lastErrorCode: 'SOURCE_REFERENCES_UNAVAILABLE' });
    const attempts = await store.query<Record<string, unknown>>(scopeA, 'SELECT outcome,retention_policy,error_code,deleted_blob_refs FROM brain_source_erasure_attempts WHERE erasure_id=$1 ORDER BY occurred_at,id', [job.id]);
    expect(attempts.rows).toHaveLength(4);
    expect(attempts.rows.every(row => ['unavailable','waiting_cloud','cloud_request_pending'].includes(String(row.outcome)))).toBe(true);
    expect(attempts.rows.every(row => row.retention_policy === 'seven_years' && JSON.stringify(row.deleted_blob_refs) === '[]')).toBe(true);
    expect(await brain.sourceErasureStatus(scopeA, { erasureId: job.id })).toMatchObject({ status: 'unavailable', attempts: 1, audit: { items: expect.any(Array) } });
    await expect(store.query(scopeA, "UPDATE brain_source_erasures SET status='complete' WHERE id=$1", [job.id])).rejects.toThrow();
    await expect(brain.retrySourceErasure(scopeB, actor, retryApprovalId, retryInput)).rejects.toThrow('ERASURE_NOT_FOUND');
  });
});
