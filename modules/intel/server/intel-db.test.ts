import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { IntelClaimRequiresCitationError, IntelRepository } from '../server/repository';
import { registerIntel, type IntelCall } from '../server';
import type { AnyCapability, ModuleManifest } from '@xyra/contracts';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actor = '019a0000-0000-7000-8000-000000000021';
const actorBId = '019a0000-0000-7000-8000-000000000022';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };
const actorA = { id: actor, tenantId: tenantA, workspaceId: workspaceA };
let db: Db;
let scoped: LocalScopedStore;
let intel: IntelRepository;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('intel', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [actor, tenantA, 'Actor A', actorBId, tenantB, 'Actor B']);
  scoped = new LocalScopedStore(db);
  intel = new IntelRepository(scoped);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('intel schema, RLS isolation and citation enforcement', () => {
  it('creates every declared table and keeps watchlist rows workspace-scoped under RLS', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
    const created = await intel.createWatchlist(actorA, { name: 'Tenant A watchlist', targets: [{ name: 'Acme', kind: 'company', externalRef: null }] });
    expect((await scoped.query(scopeB, 'SELECT id FROM intel_watchlists')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT id FROM intel_watchlists')).rows.map((row) => (row as { id: string }).id)).toContain(created.id);
    await expect(scoped.query(scopeB, "INSERT INTO intel_watchlists(id,tenant_id,workspace_id,name,created_by) VALUES ('019a0000-0000-7000-8000-000000000099',$1,$2,'cross',$3)", [tenantA, workspaceB, actor])).rejects.toThrow();
  });

  it('rejects a zero-citation claim in the repository before any insert, and the DB CHECK constraint independently rejects a direct dual-null insert', async () => {
    const watchlist = await intel.createWatchlist(actorA, { name: 'Citation watchlist', targets: [{ name: 'Acme', kind: 'company', externalRef: null }] });
    const brief = await intel.generateBrief(actorA, { watchlistId: watchlist.id });
    expect(brief.claims).toEqual([]);
    const privateRepo = intel as unknown as { createClaimWithCitations: (a: typeof actorA, briefId: string, text: string, score: number, citations: { sourceId: string | null; changeEventId: string | null }[]) => Promise<unknown> };
    await expect(privateRepo.createClaimWithCitations(actorA, brief.id, 'uncited claim', 0.5, [])).rejects.toThrow('INTEL_CLAIM_REQUIRES_CITATION');
    await expect(privateRepo.createClaimWithCitations(actorA, brief.id, 'uncited claim', 0.5, [{ sourceId: null, changeEventId: null }])).rejects.toThrow(IntelClaimRequiresCitationError);

    const claimRow = await scoped.query<{ id: string }>(scopeA, "INSERT INTO intel_brief_claims(id,tenant_id,workspace_id,brief_id,claim_text,relevance_score) VALUES('019a0000-0000-7000-8000-000000000071',$1,$2,$3,'direct insert',0.1) RETURNING id", [tenantA, workspaceA, brief.id]);
    expect(claimRow.rows[0]?.id).toBeTruthy();
    await expect(scoped.query(scopeA, "INSERT INTO intel_brief_citations(id,tenant_id,workspace_id,claim_id,source_id,change_event_id) VALUES('019a0000-0000-7000-8000-000000000072',$1,$2,$3,NULL,NULL)", [tenantA, workspaceA, claimRow.rows[0]!.id])).rejects.toThrow();
  });

  it('detects a change between two different fixture snapshots for the same source, and records no duplicate event for an identical snapshot observed twice', async () => {
    const watchlist = await intel.createWatchlist(actorA, { name: 'Change watchlist', targets: [{ name: 'Acme', kind: 'company', externalRef: null }] });
    const source = await intel.addSource(actorA, { identifier: 'https://example.com/feed', title: 'Acme feed', kind: 'feed' });
    const first = await intel.detectChanges(actorA, { watchlistId: watchlist.id, snapshots: [{ sourceId: source.id, content: 'Acme announces product A' }] });
    expect(first.events).toHaveLength(1);
    const repeated = await intel.detectChanges(actorA, { watchlistId: watchlist.id, snapshots: [{ sourceId: source.id, content: 'Acme announces product A' }] });
    expect(repeated.events).toHaveLength(0);
    const changed = await intel.detectChanges(actorA, { watchlistId: watchlist.id, snapshots: [{ sourceId: source.id, content: 'Acme announces product B' }] });
    expect(changed.events).toHaveLength(1);
    const allEvents = await intel.changeEvents(actorA, { watchlistId: watchlist.id });
    expect(allEvents).toHaveLength(2);
  });

  it('generates a brief whose claims each carry at least one citation, through the public capability/repository path (black-box)', async () => {
    const watchlist = await intel.createWatchlist(actorA, { name: 'Brief watchlist', targets: [{ name: 'Acme', kind: 'company', externalRef: null }] });
    const source = await intel.addSource(actorA, { identifier: 'https://example.com/acme', title: 'Acme filing', kind: 'filing' });
    await intel.detectChanges(actorA, { watchlistId: watchlist.id, snapshots: [{ sourceId: source.id, content: 'Acme filed a new patent' }] });
    const brief = await intel.brief(actorA, { briefId: (await intel.generateBrief(actorA, { watchlistId: watchlist.id })).id });
    expect(brief.claims.length).toBeGreaterThanOrEqual(1);
    for (const claim of brief.claims) {
      expect(claim.citations.length).toBeGreaterThanOrEqual(1);
      for (const citation of claim.citations) expect(citation.sourceId || citation.changeEventId).toBeTruthy();
    }
    const listed = await intel.briefs(actorA, { watchlistId: watchlist.id });
    expect(listed.map((b) => b.id)).toContain(brief.id);
  });

  it('creates a recommendation that defaults routedTo to null (unrouted); a routing-update capability is not implemented (documented gap)', async () => {
    const recommendation = await intel.createRecommendation(actorA, { text: 'Consider reaching out to Acme' });
    expect(recommendation.routedTo).toBeNull();
    const listed = await intel.recommendations(actorA);
    expect(listed.map((r) => r.id)).toContain(recommendation.id);
  });

  it('derives tenant and workspace from trusted capability call context when registered on a bus', async () => {
    const handlers = new Map<string, (input: unknown, call: IntelCall) => Promise<unknown>>();
    registerIntel({ register: (_manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call: IntelCall) => Promise<unknown>) => handlers.set(descriptor.id, handler) } as never, manifest, intel);
    const callA: IntelCall = { principal: { id: actor, tenantId: tenantA }, workspaceId: workspaceA };
    const created = await handlers.get('intel.watchlist.create')?.({ name: 'Capability scoped', targets: [{ name: 'Acme', kind: 'company', externalRef: null }] }, callA) as { workspaceId: string };
    expect(created.workspaceId).toBe(workspaceA);
    await expect(Promise.resolve().then(() => handlers.get('intel.watchlist.list')?.({}, undefined as unknown as IntelCall))).rejects.toThrow('INTEL_TRUSTED_CALL_CONTEXT_REQUIRED');
  });
});
