import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { ForgeRepository } from './repository';
import { registerForge, type ForgeCall } from './index';
import type { AnyCapability } from '@xyra/contracts';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actor = '019a0000-0000-7000-8000-000000000021';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };
let db: Db;
let scoped: LocalScopedStore;
let forge: ForgeRepository;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('forge', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  scoped = new LocalScopedStore(db);
  forge = new ForgeRepository(scoped);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('Forge schema and workspace isolation', () => {
  it('creates every declared Forge table and the RLS-protected project rows', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
    await scoped.query(scopeA, "INSERT INTO forge_projects(id,tenant_id,workspace_id,name,created_by) VALUES ('019a0000-0000-7000-8000-000000000031',$1,$2,'A Project',$3)", [tenantA, workspaceA, actor]);
    expect((await scoped.query(scopeB, 'SELECT id FROM forge_projects')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT id FROM forge_projects')).rows).toHaveLength(1);
  });

  it('anchors related rows to a matching workspace and keeps evidence immutable', async () => {
    const projectId = '019a0000-0000-7000-8000-000000000031';
    const ticketId = '019a0000-0000-7000-8000-000000000051';
    await scoped.query(scopeA, "INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,kind,title,state,created_by) VALUES ($1,$2,$3,$4,'ticket','A Ticket','ready',$5)", [ticketId, tenantA, workspaceA, projectId, actor]);
    await expect(scoped.query(scopeA, "INSERT INTO forge_evidence(id,tenant_id,workspace_id,requirement_id,kind,source,sha256,deterministic,result,verified_at,created_by) VALUES ('019a0000-0000-7000-8000-000000000061',$1,$2,'REQ','test','vitest',$3,true,'pass',now(),$4)", [tenantA, workspaceA, 'a'.repeat(64), actor])).resolves.toBeDefined();
    await expect(scoped.query(scopeA, "UPDATE forge_evidence SET result='fail' WHERE requirement_id='REQ'")).rejects.toThrow();
    await expect(scoped.query(scopeA, "DELETE FROM forge_evidence WHERE requirement_id='REQ'")).rejects.toThrow();
    await expect(scoped.query(scopeB, "INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,kind,title,state,created_by) VALUES ('019a0000-0000-7000-8000-000000000071',$1,$2,$3,'ticket','Cross scope','ready',$4)", [tenantA, workspaceB, projectId, actor])).rejects.toThrow();
  });

  it('persists hierarchy, approval decisions and source provenance only inside the caller workspace', async () => {
    const actorA = { id: actor, tenantId: tenantA, workspaceId: workspaceA };
    const project = await forge.createProject(actorA, { name: 'Forge persistence', description: 'test', requirements: [] });
    const epic = await forge.createNode(actorA, project.id, { parentId: null, kind: 'epic', title: 'Bounded epic', description: '', state: 'draft', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    expect((await forge.nodes(actorA, project.id)).map((node) => node.id)).toContain(epic.id);
    expect((await forge.updateNode(actorA, { nodeId: epic.id, title: 'Updated epic' })).title).toBe('Updated epic');
    await expect(forge.requestApproval(actorA, { epicId: epic.id })).rejects.toThrow('FORGE_EPIC_MUST_BE_PROPOSED');
    await forge.updateNode(actorA, { nodeId: epic.id, state: 'proposed' });
    const request = await forge.requestApproval(actorA, { epicId: epic.id });
    expect(request.status).toBe('pending');
    expect((await forge.decideApproval(actorA, { approvalId: request.id, decision: 'approved', reason: 'Scope reviewed' })).status).toBe('approved');
    expect((await forge.approvals(actorA)).find((item) => item.id === request.id)?.status).toBe('approved');
    expect((await forge.approvedPlanData(actorA, request.id)).tickets.map((node) => node.id)).toContain(epic.id);
    await expect(forge.approvedPlanData(actorA, '019a0000-0000-7000-8000-000000000099')).rejects.toThrow('FORGE_APPROVED_DURABLE_APPROVAL_REQUIRED');
    const source = await forge.createSource(actorA, { label: 'Requirements', locator: 'project/requirements.md', sha256: 'b'.repeat(64) });
    expect(source).toMatchObject({ authority: 'user', status: 'draft' });
    expect((await forge.sources(actorA)).map((item) => item.id)).toContain(source.id);
    expect(await forge.projects({ id: actor, tenantId: tenantB, workspaceId: workspaceB })).toEqual([]);
    await expect(scoped.query(scopeA, "UPDATE forge_sources SET status='rejected' WHERE id=$1", [source.id])).rejects.toThrow();
  });

  it('derives tenant and workspace from trusted capability call context', async () => {
    const handlers = new Map<string, (input: unknown, call?: ForgeCall) => Promise<unknown>>();
    registerForge({ register: (_manifest, descriptor: AnyCapability, handler) => { handlers.set(descriptor.id, handler); } }, manifest, forge);
    const callA: ForgeCall = { principal: { id: actor, tenantId: tenantA }, workspaceId: workspaceA };
    expect(() => handlers.get('forge.projects.list')?.({})).toThrow('FORGE_TRUSTED_CALL_CONTEXT_REQUIRED');
    const created = await handlers.get('forge.projects.create')?.({ name: 'Capability scoped', description: '', requirements: [] }, callA) as { workspaceId: string };
    expect(created.workspaceId).toBe(workspaceA);
    const callB: ForgeCall = { principal: { id: '019a0000-0000-7000-8000-000000000022', tenantId: tenantB }, workspaceId: workspaceB };
    const visible = await handlers.get('forge.projects.list')?.({}, callB);
    expect(visible).toEqual([]);
  });
});
