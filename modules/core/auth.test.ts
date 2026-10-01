import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, migration } from '@xyra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sql = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const platform = migration('platform/0001_platform', sql('../../packages/db/migrations/0001_platform.sql'));
const modules = migration('platform/0002_modules', sql('../../packages/db/migrations/0002_modules.sql'));
const swarm = migration('platform/0003_swarm', sql('../../packages/db/migrations/0003_swarm.sql'));
const receiptTime = migration(
  'platform/0004_receipt_time',
  sql('../../packages/db/migrations/0004_receipt_time.sql'),
);
const cloudAuth = migration('core/0001_cloud_auth', sql('./migrations/0001_cloud_auth.sql'));

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_A = '55555555-5555-4555-8555-555555555555';
const WORKSPACE_B = '66666666-6666-4666-8666-666666666666';
const AUTH_TX = '77777777-7777-4777-8777-777777777777';
const AUTH_TX_LOOKUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFRESH_FAMILY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REFRESH_HASH = 'ab'.repeat(32);
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyPGliteMigrations(db, [platform, modules, swarm, receiptTime, cloudAuth]);
  await db.exec(`
    INSERT INTO tenants(id,name) VALUES ('${TENANT_A}','Tenant A'),('${TENANT_B}','Tenant B');
    INSERT INTO workspaces(id,tenant_id,name) VALUES
      ('${WORKSPACE_A}','${TENANT_A}','Workspace A'),('${WORKSPACE_B}','${TENANT_B}','Workspace B');
    INSERT INTO users(id,tenant_id,display_name) VALUES
      ('${USER_A}','${TENANT_A}','A'),('${USER_B}','${TENANT_B}','B');
    INSERT INTO cloud_passkeys(id,tenant_id,user_id,credential_id,public_key,device_type) VALUES
      ('88888888-8888-4888-8888-888888888888','${TENANT_A}','${USER_A}','credential-a',decode('01','hex'),'singleDevice'),
      ('99999999-9999-4999-8999-999999999999','${TENANT_B}','${USER_B}','credential-b',decode('02','hex'),'singleDevice');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('cloud auth migration', () => {
  it('creates a non-owner Neon Worker role with only scoped auth DML grants', async () => {
    const role = await db.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      can_read_memberships: boolean;
      can_update_memberships: boolean;
      can_consume_auth_tx: boolean;
      can_rewrite_auth_state: boolean;
      can_delete_dpop: boolean;
    }>(`
      SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,
        has_table_privilege(r.rolname,'memberships','SELECT') AS can_read_memberships,
        has_table_privilege(r.rolname,'memberships','UPDATE') AS can_update_memberships,
        has_column_privilege(r.rolname,'cloud_auth_transactions','consumed_at','UPDATE') AS can_consume_auth_tx,
        has_column_privilege(r.rolname,'cloud_auth_transactions','state_hash','UPDATE') AS can_rewrite_auth_state,
        has_table_privilege(r.rolname,'cloud_dpop_replays','DELETE') AS can_delete_dpop
      FROM pg_roles r WHERE r.rolname='xyra_app_login'
    `);
    expect(role.rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      can_read_memberships: true,
      can_update_memberships: false,
      can_consume_auth_tx: true,
      can_rewrite_auth_state: false,
      can_delete_dpop: true,
    });
  });

  it('applies as an ordered Core-owned migration and fails closed without tenant scope', async () => {
    await db.exec('SET ROLE xyra_app_login');
    try {
      const noScope = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM cloud_passkeys');
      expect(noScope.rows[0]?.count).toBe(0);

      await db.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_A]);
      const scoped = await db.query<{ credential_id: string }>(
        'SELECT credential_id FROM cloud_passkeys ORDER BY credential_id',
      );
      expect(scoped.rows.map((row) => row.credential_id)).toEqual(['credential-a']);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('allows a pre-auth transaction only when the trusted transaction id matches', async () => {
    await db.exec('SET ROLE xyra_app_login');
    try {
      const hidden = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_auth_transactions',
      );
      expect(hidden.rows[0]?.count).toBe(0);

      await db.query("SELECT set_config('app.auth_transaction_id', $1, false)", [AUTH_TX]);
      await db.query(
        `INSERT INTO cloud_auth_transactions
          (id,state_hash,pkce_challenge,target_workspace_id,device_id,device_public_jwk,device_thumbprint,redirect_uri,nonce,expires_at)
         VALUES ($1,decode('01','hex'),$2,$3,$4,'{"kty":"OKP"}'::jsonb,$5,$6,$7,now()+interval '5 minutes')`,
        [
          AUTH_TX,
          'A'.repeat(43),
          WORKSPACE_A,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'B'.repeat(43),
          'http://127.0.0.1:45678/callback',
          'n'.repeat(32),
        ],
      );
      const own = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_auth_transactions',
      );
      expect(own.rows[0]?.count).toBe(1);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('limits anonymous passkey, authorization-code, and refresh lookup to their exact credential context', async () => {
    await db.query(
      `INSERT INTO cloud_auth_transactions
        (id,state_hash,pkce_challenge,target_workspace_id,device_id,device_public_jwk,device_thumbprint,redirect_uri,nonce,expires_at)
       VALUES ($1,decode('03','hex'),$2,$3,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"kty":"OKP"}'::jsonb,$4,
         'http://127.0.0.1:45678/callback',$5,now()+interval '5 minutes')`,
      [AUTH_TX_LOOKUP, 'C'.repeat(43), WORKSPACE_A, 'D'.repeat(43), 'z'.repeat(32)],
    );
    await db.query(
      `INSERT INTO cloud_auth_codes
        (code_hash,transaction_id,tenant_id,user_id,workspace_id,device_id,device_public_jwk,device_thumbprint,expires_at)
       VALUES (decode('04','hex'),$1,$2,$3,$4,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"kty":"OKP"}'::jsonb,$5,now()+interval '1 minute')`,
      [AUTH_TX_LOOKUP, TENANT_A, USER_A, WORKSPACE_A, 'D'.repeat(43)],
    );
    await db.query(
      `INSERT INTO cloud_refresh_families
        (id,tenant_id,user_id,workspace_id,device_id,device_public_jwk,device_thumbprint,expires_at)
       VALUES ($1,$2,$3,$4,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"kty":"OKP"}'::jsonb,$5,now()+interval '30 days')`,
      [REFRESH_FAMILY, TENANT_A, USER_A, WORKSPACE_A, 'D'.repeat(43)],
    );
    await db.query(
      `INSERT INTO cloud_refresh_tokens(token_hash,tenant_id,family_id,generation,expires_at)
       VALUES (decode($1,'hex'),$2,$3,0,now()+interval '30 days')`,
      [REFRESH_HASH, TENANT_A, REFRESH_FAMILY],
    );

    await db.query(
      `SELECT set_config('app.tenant_id','',false),set_config('app.workspace_id','',false),
        set_config('app.auth_transaction_id','',false),set_config('app.auth_credential_id','',false),
        set_config('app.refresh_token_hash','',false)`,
    );
    await db.exec('SET ROLE xyra_app_login');
    try {
      const hidden = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM cloud_passkeys');
      expect(hidden.rows[0]?.count).toBe(0);

      await db.query(
        "SELECT set_config('app.auth_transaction_id',$1,false),set_config('app.auth_credential_id',$2,false)",
        [AUTH_TX_LOOKUP, 'credential-a'],
      );
      const passkey = await db.query<{ credential_id: string; user_id: string }>(
        'SELECT credential_id,user_id FROM cloud_passkeys',
      );
      expect(passkey.rows.map((row) => row.credential_id)).toEqual(['credential-a']);

      const code = await db.query<{ code_hash: string }>(
        "SELECT encode(code_hash,'hex') AS code_hash FROM cloud_auth_codes",
      );
      expect(code.rows.map((row) => row.code_hash)).toEqual(['04']);
      const codeHidden = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM cloud_auth_codes WHERE code_hash=decode('05','hex')",
      );
      expect(codeHidden.rows[0]?.count).toBe(0);

      await db.query("SELECT set_config('app.refresh_token_hash',$1,false)", [REFRESH_HASH]);
      const refresh = await db.query<{ family_id: string }>(
        "SELECT family_id FROM cloud_refresh_tokens WHERE encode(token_hash,'hex')=$1",
        [REFRESH_HASH],
      );
      expect(refresh.rows).toHaveLength(1);
      const family = await db.query<{ id: string }>('SELECT id FROM cloud_refresh_families');
      expect(family.rows.map((row) => row.id)).toEqual([REFRESH_FAMILY]);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('uses the production login role for idempotent webhook outbox and overlap-safe Cron cleanup', async () => {
    await db.query(
      `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
       VALUES ($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',decode('01','hex'),now()-interval '1 minute'),
              ($2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',decode('02','hex'),now()+interval '1 hour')`,
      [TENANT_A, TENANT_B],
    );
    await db.exec('SET ROLE xyra_app_login');
    try {
      await db.query(
        "SELECT set_config('app.tenant_id',$1,false),set_config('app.workspace_id',$2,false)",
        [TENANT_A, WORKSPACE_A],
      );
      const counts = await db.query<{ deleted: number }>(`
        WITH deleted AS (
          DELETE FROM cloud_dpop_replays WHERE expires_at < now() RETURNING 1
        )
        SELECT (SELECT count(*)::int FROM deleted) AS deleted
      `);
      expect(counts.rows[0]).toEqual({ deleted: 1 });

      await db.query(
        `INSERT INTO cloud_cron_runs(job_name,window_start)
         VALUES ('dpop-replay-cleanup','2026-09-30T21:45:00Z') ON CONFLICT DO NOTHING`,
      );
      const secondRun = await db.query(
        `INSERT INTO cloud_cron_runs(job_name,window_start)
         VALUES ('dpop-replay-cleanup','2026-09-30T21:45:00Z') ON CONFLICT DO NOTHING RETURNING 1`,
      );
      expect(secondRun.rows).toHaveLength(0);

      await db.query(
        `INSERT INTO cloud_webhook_receipts(provider,event_id,payload_hash)
         VALUES ('xyra-membership','evt-1',decode('aa','hex')) ON CONFLICT DO NOTHING`,
      );
      await db.query(
        `INSERT INTO cloud_webhook_receipts(provider,event_id,payload_hash)
         VALUES ('xyra-membership','evt-1',decode('bb','hex')) ON CONFLICT DO NOTHING`,
      );
      const receipt = await db.query<{ payload_hash: string }>(
        `SELECT encode(payload_hash,'hex') AS payload_hash FROM cloud_webhook_receipts
          WHERE provider='xyra-membership' AND event_id='evt-1'`,
      );
      expect(receipt.rows[0]?.payload_hash).toBe('aa');
      await db.query(
        `INSERT INTO cloud_queue_jobs
          (id,tenant_id,workspace_id,job_type,idempotency_key,payload,status)
         VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,'membership.revoked','evt-1','{"principalId":"${USER_A}"}'::jsonb,'pending')
         ON CONFLICT (tenant_id,workspace_id,job_type,idempotency_key) DO NOTHING`,
        [TENANT_A, WORKSPACE_A],
      );
      await db.query(
        `INSERT INTO cloud_queue_jobs
          (id,tenant_id,workspace_id,job_type,idempotency_key,payload,status)
         VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,$2,'membership.revoked','evt-1','{"principalId":"${USER_A}"}'::jsonb,'pending')
         ON CONFLICT (tenant_id,workspace_id,job_type,idempotency_key) DO NOTHING`,
        [TENANT_A, WORKSPACE_A],
      );
      const jobs = await db.query<{ id: string }>(
        `SELECT id::text FROM cloud_queue_jobs WHERE tenant_id=$1 AND workspace_id=$2`,
        [TENANT_A, WORKSPACE_A],
      );
      expect(jobs.rows).toHaveLength(1);
    } finally {
      await db.exec('RESET ROLE');
    }
    const future = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_dpop_replays WHERE expires_at > now()',
    );
    expect(future.rows[0]?.count).toBe(1);
  });

  it('rejects malformed PKCE challenges and credentials with negative counters', async () => {
    await expect(
      db.query(
        `INSERT INTO cloud_auth_transactions
          (id,state_hash,pkce_challenge,target_workspace_id,device_id,device_public_jwk,device_thumbprint,redirect_uri,nonce,expires_at)
         VALUES ($1,decode('02','hex'),'bad','${WORKSPACE_A}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"kty":"OKP"}'::jsonb,'${'B'.repeat(43)}','http://127.0.0.1:45678/callback','${'n'.repeat(32)}',now()+interval '5 minutes')`,
        [AUTH_TX],
      ),
    ).rejects.toThrow();
  });
});
