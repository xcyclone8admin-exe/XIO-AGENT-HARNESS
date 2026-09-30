import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, migration } from './migrations';
import { openLocalStore } from './pglite';
import { LocalScopedStore, prepareLocalAppRole } from './scoped';

const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
let db: PGlite;
let scoped: LocalScopedStore;

beforeAll(async () => {
  db = await openLocalStore();
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  await applyPGliteMigrations(
    db,
    files.map((name) => migration(`platform/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8'))),
  );
  // Mirrors core, ops, and SWARM manifest declarations (the sidecar passes MANIFESTS).
  await prepareLocalAppRole(db, [
    ...[
      'tenants',
      'workspaces',
      'users',
      'memberships',
      'workspace_settings',
      'ops_projects',
      'ops_tasks',
    ].map((name) => ({ name, class: 'lww' as const, ...(name === 'ops_projects' ? { serverWriteCapabilities: ['test_ops'] } : {}) })),
    ...['approval_requests', 'approval_decisions', 'audit_events', 'domain_events'].map((name) => ({
      name,
      class: 'append' as const,
    })),
    {
      name: 'swarm_agent_profiles',
      class: 'lww' as const,
      privilegedColumns: [
        'capability_grants',
        'autonomy_level',
        'secret_scopes',
        'network_policy',
        'filesystem_policy',
        'approval_policy',
        'eval_history',
      ],
    },
    ...['swarm_runs', 'swarm_run_journal', 'swarm_model_evals', 'swarm_prompt_versions'].map((name) => ({
      name,
      class: 'append' as const,
    })),
  ]);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [
    workspaceA,
    tenantA,
    'A',
    workspaceB,
    tenantB,
    'B',
  ]);
  scoped = new LocalScopedStore(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('a scoped query sees only its own workspace and resets role after the transaction', async () => {
  const a = await scoped.query<{ id: string }>(
    { tenantId: tenantA, workspaceId: workspaceA },
    'SELECT id FROM workspaces ORDER BY id',
  );
  expect(a.rows.map((row) => row.id)).toEqual([workspaceA]);
  const b = await scoped.query<{ id: string }>(
    { tenantId: tenantB, workspaceId: workspaceB },
    'SELECT id FROM workspaces ORDER BY id',
  );
  expect(b.rows.map((row) => row.id)).toEqual([workspaceB]);
  const identity = await db.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0]?.current_user).not.toBe('xyra_app');
});

test('a scoped write cannot insert another tenant', async () => {
  await expect(
    scoped.query(
      { tenantId: tenantA, workspaceId: workspaceA },
      'INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3)',
      ['019a0000-0000-7000-8000-000000000099', tenantB, 'intruder'],
    ),
  ).rejects.toThrow();
});

test('swarm tables isolate tenants and keep run records append-only', async () => {
  const profileA = '019a0000-0000-7000-8000-000000000201';
  const runA = '019a0000-0000-7000-8000-000000000202';
  const actorA = '019a0000-0000-7000-8000-000000000203';
  const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
  await scoped.query(
    scopeA,
    `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,
       default_model,budgets,approval_policy,memory_scope,created_by)
     VALUES ($1,$2,$3,'builder','Build things','anthropic','claude','{}','ask','{}',$4)`,
    [profileA, tenantA, workspaceA, actorA],
  );
  await scoped.query(
    scopeA,
    `INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,termination,iterations,actions,
       failures,cost_usd,budgets,started_at,ended_at,created_by)
     VALUES ($1,$2,$3,$4,'LEASE_LOST',1,0,0,0,'{}',now(),now(),$5)`,
    [runA, tenantA, workspaceA, profileA, actorA],
  );

  const seenByB = await scoped.query(
    { tenantId: tenantB, workspaceId: workspaceB },
    'SELECT id FROM swarm_agent_profiles UNION ALL SELECT id FROM swarm_runs',
  );
  expect(seenByB.rows).toEqual([]);
  // A run cannot point at another tenant's profile, even with a guessed id.
  await expect(
    scoped.query(
      { tenantId: tenantB, workspaceId: workspaceB },
      `INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,termination,iterations,actions,
       failures,cost_usd,budgets,started_at,ended_at,created_by)
     VALUES ('019a0000-0000-7000-8000-000000000204',$1,$2,$3,'COMPLETED',0,0,0,0,'{}',now(),now(),$4)`,
      [tenantB, workspaceB, profileA, actorA],
    ),
  ).rejects.toThrow();
  // The app role has no UPDATE grant on append tables, and the trigger holds even for the owner.
  await expect(
    scoped.query(scopeA, "UPDATE swarm_runs SET output = 'x' WHERE id = $1", [runA]),
  ).rejects.toThrow();
  await expect(db.query('DELETE FROM swarm_runs WHERE id = $1', [runA])).rejects.toThrow(/append-only/);
});

test('the scoped guard refuses role, session and non-DML statements (ADR-0005 A1 §C)', async () => {
  const scope = { tenantId: tenantA, workspaceId: workspaceA };
  for (const sql of [
    'SET ROLE postgres',
    'RESET ROLE',
    'SELECT set_config($1, $2, false)',
    'SET SESSION AUTHORIZATION postgres',
    'DO $$ BEGIN PERFORM 1; END $$',
    'COPY tenants TO STDOUT',
    'CREATE TABLE intruder (id int)',
    'ALTER TABLE tenants DISABLE ROW LEVEL SECURITY',
    'DROP TABLE tenants',
    'GRANT ALL ON tenants TO xyra_app',
  ]) {
    await expect(scoped.query(scope, sql), sql).rejects.toThrow(/Scoped query/);
  }
  await expect(
    scoped.query(
      scope,
      'INSERT INTO ops_projects(id) SELECT id FROM ops_projects WHERE false ON CONFLICT DO NOTHING',
    ),
  ).resolves.toBeDefined();
});

test('privileged columns get a column-listed UPDATE grant without them (SWM-R-003)', async () => {
  const fresh = await openLocalStore();
  try {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    await applyPGliteMigrations(
      fresh,
      files.map((name) => migration(`platform/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8'))),
    );
    // Simulate an earlier setup that gave server tables and guarded records broad write grants.
    // Re-running setup must remove stale privileges before applying current manifest authority.
    await prepareLocalAppRole(fresh, [
      { name: 'tenants', class: 'lww' },
      { name: 'workspaces', class: 'lww', serverWriteCapabilities: ['test_ops'] },
      { name: 'memberships', class: 'lww' },
      { name: 'ops_projects', class: 'lww' },
    ]);
    await prepareLocalAppRole(fresh, [
      { name: 'tenants', class: 'lww', authority: 'server' },
      { name: 'workspaces', class: 'lww', authority: 'server', serverWriteCapabilities: ['test_ops'] },
      { name: 'memberships', class: 'lww', authority: 'server' },
      { name: 'ops_projects', class: 'lww', authority: 'synced', guardedColumns: ['status'], serverWriteCapabilities: ['test_ops'] },
      { name: 'ops_tasks', class: 'lww', authority: 'synced' },
    ]);
    const schemaAccess = await fresh.query<{ usage: boolean }>(
      "SELECT has_schema_privilege('xyra_cap_test_ops', 'public', 'USAGE') AS usage",
    );
    expect(schemaAccess.rows[0]?.usage).toBe(true);
    await fresh.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantA, 'A']);
    await fresh.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3)', [
      workspaceA,
      tenantA,
      'A',
    ]);
    const store = new LocalScopedStore(fresh);
    const scope = { tenantId: tenantA, workspaceId: workspaceA };
    await expect(
      store.withServerScope(scope, 'test_ops', `${Date.now() + 61_000}-0001-testnode`, async () => 'unreachable'),
    ).rejects.toThrow(/too far in the future/);
    const project = '019a0000-0000-7000-8000-000000000301';
    await store.query(
      scope,
      'INSERT INTO ops_projects(id,tenant_id,workspace_id,name,created_by) VALUES ($1,$2,$3,$4,$5)',
      [project, tenantA, workspaceA, 'P', tenantA],
    );
    await expect(
      store.query(scope, "UPDATE ops_projects SET name = 'Q' WHERE id = $1", [project]),
    ).resolves.toBeDefined();
    await expect(
      store.query(scope, "UPDATE ops_projects SET status = 'paused' WHERE id = $1", [project]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      store.query(scope, "UPDATE workspaces SET name = 'Changed' WHERE id = $1", [workspaceA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      store.query(
        scope,
        `INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role)
         VALUES ('019a0000-0000-7000-8000-000000000302',$1,$2,$3,'owner')`,
        [tenantA, workspaceA, tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      store.withServerScope(scope, 'test_ops', undefined, (tx) =>
        tx.query("UPDATE workspaces SET name = 'Capability update' WHERE id = $1", [workspaceA]),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      store.withServerScope(scope, 'test_ops', undefined, (tx) =>
        tx.query(
          `INSERT INTO workspaces(id,tenant_id,name)
           VALUES ('019a0000-0000-7000-8000-000000000303',$1,'Cross-tenant')`,
          [tenantB],
        ),
      ),
    ).rejects.toThrow();
    // Server scope reads are RLS-bounded too: another tenant's workspace is invisible.
    await fresh.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantB, 'B']);
    await fresh.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3)', [
      workspaceB,
      tenantB,
      'B',
    ]);
    await expect(
      store.withServerScope(scope, 'test_ops', undefined, (tx) =>
        tx.query('SELECT id FROM workspaces WHERE id = $1', [workspaceB]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    // Device-owned synced rows are read-only to the server role; only guarded tables differ.
    await expect(
      store.withServerScope(scope, 'test_ops', undefined, (tx) =>
        tx.query("UPDATE ops_tasks SET title = 'x' WHERE tenant_id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      store.withServerScope(scope, 'test_ops', undefined, (tx) =>
        tx.query("UPDATE ops_tasks SET title = 'capability escape' WHERE tenant_id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
  } finally {
    await fresh.close();
  }
}, 60_000);
