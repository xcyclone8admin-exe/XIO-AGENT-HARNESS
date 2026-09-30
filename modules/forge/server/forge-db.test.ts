import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';

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
});
