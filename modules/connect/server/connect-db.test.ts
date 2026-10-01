import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHonestStatus } from '@xyra/contracts';
import manifest from '../manifest';
import { ConnectRepository } from './repository';
import { ConnectMcpBoundary } from './mcp-boundary';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actorIdA = '019a0000-0000-7000-8000-000000000021';
const actorIdB = '019a0000-0000-7000-8000-000000000022';
let db: Db;
let scoped: LocalScopedStore;
let connect: ConnectRepository;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('connect', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [actorIdA, tenantA, 'Actor A', actorIdB, tenantB, 'Actor B']);
  scoped = new LocalScopedStore(db);
  connect = new ConnectRepository(scoped);
}, 60_000);

afterAll(async () => { await db?.close(); });

const actorA = { id: actorIdA, tenantId: tenantA, workspaceId: workspaceA };
const actorB = { id: actorIdB, tenantId: tenantB, workspaceId: workspaceB };

describe('CONNECT catalog honesty and isolation', () => {
  it('creates every declared CONNECT table', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
  });

  it('never lists a not-yet-available connector as CONNECTED, DEGRADED or ERROR', async () => {
    await connect.registerConnector(actorA, { id: 'stripe', name: 'Stripe', family: 'payments', availability: 'not-yet-available', custody: 'none' });
    const [stripe] = await connect.listConnectors(actorA);
    if (!stripe) throw new Error('expected stripe connector to be registered');
    expect(stripe.state).toBe('NOT_CONFIGURED');
    expect(isHonestStatus(stripe, new Date())).toBe(true);
  });

  it('keeps an available-but-unconfigured connector honest with no checkedAt timestamp', async () => {
    await connect.registerConnector(actorA, { id: 'github', name: 'GitHub', family: 'dev', availability: 'available', custody: 'local-keychain' });
    const github = (await connect.listConnectors(actorA)).find((c) => c.id === 'github')!;
    expect(github.state).toBe('NOT_CONFIGURED');
    expect(github.checkedAt).toBeNull();
    expect(isHonestStatus(github, new Date())).toBe(true);
  });

  it('isolates the catalog and grant ledger per tenant/workspace', async () => {
    expect(await connect.listConnectors(actorB)).toEqual([]);
    await connect.registerConnector(actorB, { id: 'github', name: 'GitHub', family: 'dev', availability: 'available', custody: 'local-keychain' });
    expect(await connect.listConnectors(actorB)).toHaveLength(1);
    expect(await connect.listConnectors(actorA)).toHaveLength(2);
  });

  it('records grant and revoke decisions in the append-only ledger and resolves the current one', async () => {
    const granted = await connect.recordGrant(actorA, { connectorId: 'github', action: 'grant', allowedTools: ['repo.read'], reason: 'onboarding' });
    expect(granted.action).toBe('grant');
    expect(await connect.currentGrant(actorA, 'github')).toMatchObject({ action: 'grant' });
    const revoked = await connect.recordGrant(actorA, { connectorId: 'github', action: 'revoke', allowedTools: [], reason: 'offboarding' });
    expect(revoked.action).toBe('revoke');
    expect(await connect.currentGrant(actorA, 'github')).toMatchObject({ action: 'revoke' });
  });

  it('refuses a grant against a connector that was never registered', async () => {
    await expect(connect.recordGrant(actorA, { connectorId: 'does-not-exist', action: 'grant', allowedTools: [], reason: '' })).rejects.toThrow('CONNECT_CONNECTOR_NOT_REGISTERED');
  });
});

describe('CONNECT MCP boundary fails closed with no transport', () => {
  it('refuses tool calls and listings against a registered-but-unavailable server', async () => {
    const boundary = new ConnectMcpBoundary();
    boundary.registerUnavailable({ id: 'github-mcp', connectorId: 'github', allowedTools: ['repo.read'], available: false });
    const signal = new AbortController().signal;
    await expect(boundary.client.listTools('github-mcp', signal)).rejects.toThrow('CREDENTIAL_EXPIRED_OR_REVOKED');
    await expect(boundary.client.callTool('github-mcp', 'repo.read', {}, signal)).rejects.toThrow('CREDENTIAL_EXPIRED_OR_REVOKED');
  });

  it('refuses a call against a server id that was never registered', async () => {
    const boundary = new ConnectMcpBoundary();
    const signal = new AbortController().signal;
    await expect(boundary.client.listTools('unknown', signal)).rejects.toThrow('MCP_SERVER_NOT_REGISTERED');
  });
});
