import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migration } from '@xyra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CandidateClaims } from './model';
import { readCurrentAuthority } from './neon';

const readSql = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const platform = migration(
  'platform/0001_platform',
  readSql('../../../packages/db/migrations/0001_platform.sql'),
);
const swarm = migration('platform/0003_swarm', readSql('../../../packages/db/migrations/0003_swarm.sql'));
const cloudAuth = migration(
  'core/0001_cloud_auth',
  readSql('../../../modules/core/migrations/0001_cloud_auth.sql'),
);

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const TENANT_B = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_B = '88888888-8888-4888-8888-888888888888';
const USER_B = '99999999-9999-4999-8999-999999999999';
let db: PGlite;

function claims(overrides: Partial<CandidateClaims> = {}): CandidateClaims {
  return {
    principalId: USER,
    tenantId: TENANT,
    workspaceIds: [WORKSPACE],
    activeWorkspaceId: WORKSPACE,
    kind: 'user',
    autonomy: 0,
    expiresAtMs: Date.now() + 900_000,
    deviceId: '66666666-6666-4666-8666-666666666666',
    deviceThumbprint: 'A'.repeat(43),
    ...overrides,
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(platform.sql);
  await db.exec(readSql('../../../packages/db/migrations/0002_modules.sql'));
  await db.exec(swarm.sql);
  await db.exec(cloudAuth.sql);
  await db.exec(`
    CREATE ROLE xyra_cloud_test NOLOGIN;
    GRANT USAGE ON SCHEMA public TO xyra_cloud_test;
    GRANT SELECT ON memberships, workspaces, swarm_agent_profiles TO xyra_cloud_test;
  `);
  await db.exec(`
    INSERT INTO tenants(id,name) VALUES ('${TENANT}','Tenant');
    INSERT INTO workspaces(id,tenant_id,name,sync_enabled) VALUES ('${WORKSPACE}','${TENANT}','Workspace',true);
    INSERT INTO users(id,tenant_id,display_name) VALUES ('${USER}','${TENANT}','User');
    INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role,active)
      VALUES ('77777777-7777-4777-8777-777777777777','${TENANT}','${WORKSPACE}','${USER}','viewer',true);
    INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,
      capability_grants,budgets,approval_policy,memory_scope,output_schema,autonomy_level,created_by)
      VALUES ('${AGENT}','${TENANT}','${WORKSPACE}','worker','test','provider','model',
        '["ops:task:write"]','{}','default.consequential','{}','{}',2,'${USER}');
    INSERT INTO tenants(id,name) VALUES ('${TENANT_B}','Tenant B');
    INSERT INTO workspaces(id,tenant_id,name,sync_enabled) VALUES ('${WORKSPACE_B}','${TENANT_B}','Workspace B',true);
    INSERT INTO users(id,tenant_id,display_name) VALUES ('${USER_B}','${TENANT_B}','Other user');
    INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role,active)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${TENANT_B}','${WORKSPACE_B}','${USER_B}','owner',true);
  `);
}, 60_000);

afterAll(async () => db?.close());

async function withScope<T>(operation: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE xyra_cloud_test');
  await db.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.workspace_id',$2,false)", [
    TENANT,
    WORKSPACE,
  ]);
  try {
    return await operation();
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('current Neon authority resolver', () => {
  it('derives user and agent grants from active membership and current SWARM profile rows', async () => {
    await withScope(async () => {
      const user = await readCurrentAuthority(db, claims());
      expect(user?.membership).toMatchObject({
        principalId: USER,
        role: 'viewer',
        workspaceKind: 'standard',
      });
      expect(user?.membership.permissions).toEqual([]);
      expect(
        await readCurrentAuthority(
          db,
          claims({
            principalId: USER_B,
            tenantId: TENANT_B,
            workspaceIds: [WORKSPACE_B],
            activeWorkspaceId: WORKSPACE_B,
          }),
        ),
      ).toBeNull();

      const agent = await readCurrentAuthority(
        db,
        claims({
          principalId: AGENT,
          kind: 'agent',
          delegatedBy: USER,
          runId: '88888888-8888-4888-8888-888888888888',
        }),
      );
      expect(agent?.membership).toMatchObject({
        principalId: AGENT,
        kind: 'agent',
        delegatedBy: USER,
        autonomy: 2,
        permissions: ['ops:task:write'],
      });
      expect(agent?.delegator?.role).toBe('viewer');
    });
  });

  it('denies revoked membership, missing delegation, and a token workspace outside its current scopes', async () => {
    await db.query(
      'UPDATE memberships SET active=false WHERE tenant_id=$1 AND workspace_id=$2 AND user_id=$3',
      [TENANT, WORKSPACE, USER],
    );
    await withScope(async () => {
      expect(await readCurrentAuthority(db, claims())).toBeNull();
      expect(
        await readCurrentAuthority(db, claims({ kind: 'agent', principalId: AGENT, delegatedBy: USER })),
      ).toBeNull();
      expect(await readCurrentAuthority(db, claims({ workspaceIds: [] }))).toBeNull();
    });
  });
});
