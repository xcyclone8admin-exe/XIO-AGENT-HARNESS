import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { GUARDED_PROFILE_FIELDS } from '../contracts';
import { SwarmProfileService } from './profile-service';

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
let profiles: SwarmProfileService;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')));
}

const draft = {
  roleId: 'OPERATIONS',
  charter: 'Report task facts.',
  defaultProvider: 'primary',
  defaultModel: 'fast',
  fallbacks: [],
  budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxActions: 3, maxFailures: 3, maxIterations: 3 },
  memoryScope: { tenant: false, workspace: true, project: false, run: true },
  outputSchema: { type: 'object' },
};

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('swarm', '../migrations/')]);
  // Manifest-derived grants (ADR-0016): fails if any declared table is missing (SWM-R-014).
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  scoped = new LocalScopedStore(db);
  profiles = new SwarmProfileService(scoped);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('swarm schema', () => {
  it('creates every table the manifest declares (SWM-R-014)', async () => {
    const found = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const names = new Set(found.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !names.has(name))).toEqual([]);
  });

  it('isolates the local Night Shift row per workspace', async () => {
    await scoped.query(scopeA, 'INSERT INTO swarm_night_shift(tenant_id,workspace_id,max_runs,max_spend_usd) VALUES ($1,$2,1,1)', [tenantA, workspaceA]);
    expect((await scoped.query(scopeB, 'SELECT workspace_id FROM swarm_night_shift')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT workspace_id FROM swarm_night_shift')).rows).toHaveLength(1);
  });

  it('rejects autonomy 5 and a null output_schema even for the owner (SWM-R-011/012)', async () => {
    const insert = (autonomy: number, outputSchema: string | null) =>
      db.query(
        `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,budgets,
           memory_scope,output_schema,autonomy_level,created_by)
         VALUES (gen_random_uuid(),$1,$2,'r','c','p','m','{}','{}',$3,$4,$5)`,
        [tenantA, workspaceA, outputSchema, autonomy, actor],
      );
    await expect(insert(5, '{}')).rejects.toThrow(/autonomy_level/);
    await expect(insert(1, null)).rejects.toThrow(/output_schema/);
  });
});

describe('guarded profile columns (SWM-R-002/003)', () => {
  it('creates profiles with fail-closed privileges and rejects every guarded field', async () => {
    const created = await profiles.create(scopeA, actor, draft);
    expect(created).toMatchObject({
      capabilityGrants: [],
      autonomyLevel: 0,
      secretScopes: [],
      networkPolicy: { mode: 'none', allowedHosts: [] },
      filesystemPolicy: { mode: 'none', allowedPaths: [] },
      approvalPolicy: 'default.consequential',
      evalHistory: [],
    });
    for (const field of GUARDED_PROFILE_FIELDS) {
      await expect(profiles.create(scopeA, actor, { ...draft, [field]: [] })).rejects.toThrow(`GUARDED_PROFILE_FIELD:${field}`);
      await expect(profiles.update(scopeA, created.id, { ...draft, [field]: 4 })).rejects.toThrow(`GUARDED_PROFILE_FIELD:${field}`);
    }
    await expect(profiles.create(scopeA, actor, { ...draft, unknownField: true })).rejects.toThrow();
    expect(await profiles.update(scopeA, created.id, { ...draft, charter: 'Updated.' })).toMatchObject({ charter: 'Updated.' });
  });

  it('derives eval history from swarm_model_evals instead of trusting a stored value', async () => {
    await scoped.query(
      scopeA,
      `INSERT INTO swarm_model_evals(id,tenant_id,workspace_id,provider,model_id,eval_id,metrics,ran_at,created_by)
       VALUES (gen_random_uuid(),$1,$2,'primary','fast','golden-1',$3,now(),$4)`,
      [tenantA, workspaceA, JSON.stringify({ taskCompletion: 0.9, toolSuccess: 1, schemaSuccess: 1, hallucinationRate: 0, fallbackRate: 0.1 }), actor],
    );
    const [profile] = await profiles.list(scopeA);
    expect(profile?.evalHistory).toEqual([expect.objectContaining({ evalId: 'golden-1', modelId: 'fast', score: 0.9, fallbackRate: 0.1 })]);
  });

  it('blocks the app role from writing guarded columns directly, bypassing the service', async () => {
    const created = await profiles.create(scopeA, actor, draft);
    const writes: Record<string, string> = {
      capability_grants: `'["core.admin"]'`,
      autonomy_level: '4',
      secret_scopes: `'["vault:*"]'`,
      network_policy: `'{"mode":"allow-list","allowedHosts":["*"]}'`,
      filesystem_policy: `'{"mode":"leased-worktree","allowedPaths":["/"]}'`,
      approval_policy: `'never'`,
      eval_history: `'[{"evalId":"forged"}]'`,
    };
    expect(Object.keys(writes)).toHaveLength(GUARDED_PROFILE_FIELDS.length);
    for (const [column, value] of Object.entries(writes)) {
      await expect(scoped.query(scopeA, `UPDATE swarm_agent_profiles SET ${column}=${value} WHERE id=$1`, [created.id])).rejects.toThrow(
        /guarded column|permission denied/,
      );
      await expect(
        scoped.query(
          scopeA,
          `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,budgets,
             memory_scope,output_schema,created_by,${column})
           VALUES (gen_random_uuid(),$1,$2,'r','c','p','m','{}','{}','{}',$3,${value})`,
          [tenantA, workspaceA, actor],
        ),
      ).rejects.toThrow(/guarded column/);
    }
  });
});

describe('append-only run records', () => {
  it('rejects UPDATE and DELETE of prompt versions; retirement appends (SWM-R-010)', async () => {
    const insert = (version: number, retired: boolean) =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_prompt_versions(id,tenant_id,workspace_id,prompt_id,version,purpose,template,retired_at,created_by)
         VALUES (gen_random_uuid(),$1,$2,'charter',$3,'p','t',${retired ? 'now()' : 'NULL'},$4)`,
        [tenantA, workspaceA, version, actor],
      );
    await insert(1, false);
    await expect(scoped.query(scopeA, "UPDATE swarm_prompt_versions SET retired_at=now() WHERE prompt_id='charter'")).rejects.toThrow();
    await expect(db.query("UPDATE swarm_prompt_versions SET retired_at=now() WHERE prompt_id='charter'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM swarm_prompt_versions WHERE prompt_id='charter'")).rejects.toThrow(/append-only/);
    await insert(2, true);
    await expect(insert(2, false)).rejects.toThrow();
  });

  it('journals a running run before its outcome and enforces the parent-run FK (probes e/f)', async () => {
    const profile = await profiles.create(scopeA, actor, draft);
    const start = (id: string, parent: string | null) =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,parent_run_id,budgets,started_at,created_by)
         VALUES ($1,$2,$3,$4,$5,'{}',now(),$6)`,
        [id, tenantA, workspaceA, profile.id, parent, actor],
      );
    const parent = '019a0000-0000-7000-8000-000000000301';
    const child = '019a0000-0000-7000-8000-000000000302';
    await expect(start(child, '019a0000-0000-7000-8000-000000000399')).rejects.toThrow(/swarm_runs_parent_fk/);
    await start(parent, null);
    await start(child, parent);
    await scoped.query(
      scopeA,
      `INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,occurred_at,created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,0,'run.started',now(),$4)`,
      [tenantA, workspaceA, parent, actor],
    );
    const outcome = () =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_run_outcomes(id,tenant_id,workspace_id,run_id,termination,iterations,actions,failures,cost_usd,ended_at,created_by)
         VALUES (gen_random_uuid(),$1,$2,$3,'COMPLETED',1,0,0,0,now(),$4)`,
        [tenantA, workspaceA, parent, actor],
      );
    await outcome();
    await expect(outcome()).rejects.toThrow();
    await expect(scoped.query(scopeA, "UPDATE swarm_run_outcomes SET termination='FAILED' WHERE run_id=$1", [parent])).rejects.toThrow();
  });
});
