import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, migration } from '@xyra/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from './access';
import type { NeonQueryClient } from './neon';
import { lockWorkspaceSequence, NeonSyncStore } from './neon-sync-store';
import { SyncAuthorityEngine, hashRequest, parseSyncPush } from './sync';
import { drainSyncOutbox } from './sync-outbox';
import { hasErasureFence } from './erasures';

const sql = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const migrations = [
  migration('platform/0001_platform', sql('../../../packages/db/migrations/0001_platform.sql')),
  migration('platform/0002_modules', sql('../../../packages/db/migrations/0002_modules.sql')),
  migration('platform/0003_swarm', sql('../../../packages/db/migrations/0003_swarm.sql')),
  migration('platform/0004_receipt_time', sql('../../../packages/db/migrations/0004_receipt_time.sql')),
  migration('core/0001_cloud_auth', sql('../../../modules/core/migrations/0001_cloud_auth.sql')),
  migration('core/0002_cloud_sync', sql('../../../modules/core/migrations/0002_cloud_sync.sql')),
  migration('core/0003_cloud_erasure', sql('../../../modules/core/migrations/0003_cloud_erasure.sql')),
  migration('core/0004_cloud_blob_reference_sets', sql('../../../modules/core/migrations/0004_cloud_blob_reference_sets.sql')),
];

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const USER_A = '55555555-5555-4555-8555-555555555555';
const ROW = '66666666-6666-4666-8666-666666666666';
const TEST_APPROVAL = '77777777-7777-4777-8777-777777777777';
let db: PGlite;

function access(tenantId: string, workspaceId: string): AccessContext {
  return {
    claims: {
      principalId: USER_A,
      kind: 'user',
      tenantId,
      workspaceIds: [workspaceId],
      activeWorkspaceId: workspaceId,
      autonomy: 1,
      expiresAtMs: Date.now() + 60_000,
      deviceThumbprint: 'd'.repeat(43),
      deviceId: '77777777-7777-4777-8777-777777777777',
    },
    membership: {
      principalId: USER_A,
      tenantId,
      workspaceId,
      role: 'owner',
      permissions: [],
      kind: 'user',
      workspaceKind: 'standard',
    },
    killSwitchEngaged: false,
  };
}

function pushRequest(title: string, stamp = Date.now(), key = `key-${crypto.randomUUID()}`) {
  const hlc = `${String(stamp).padStart(13, '0')}-0001-nodea`;
  return parseSyncPush({
    protocolVersion: 1,
    schemaVersion: 'cloud-sync-v1',
    nodeId: 'nodea',
    idempotencyKey: key,
    changes: [
      {
        table: 'ops_projects',
        id: ROW,
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_A,
        op: 'upsert',
        hlc,
        fields: { name: { value: title, hlc, baseHlc: null } },
      },
    ],
  });
}

async function scoped<T>(
  tenantId: string,
  workspaceId: string,
  work: (client: NeonQueryClient) => Promise<T>,
): Promise<T> {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE xyra_cloud_runtime_app');
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await work(db as unknown as NeonQueryClient);
    await db.exec('COMMIT');
    return result;
  } catch (cause) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw cause;
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    'CREATE ROLE xyra_cloud_runtime_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  );
  await applyPGliteMigrations(db, migrations);
  await db.exec(`
    INSERT INTO tenants(id,name) VALUES ('${TENANT_A}','A'),('${TENANT_B}','B');
    INSERT INTO workspaces(id,tenant_id,name) VALUES
      ('${WORKSPACE_A}','${TENANT_A}','A'),('${WORKSPACE_B}','${TENANT_B}','B');
  `);
});

afterAll(async () => db?.close());

describe('Neon canonical sync store (PGlite role/RLS contract)', () => {
  it('keeps content-free erasure fences scoped and rejects stale row replay', async () => {
    const erasedSource = '99999999-9999-4999-8999-999999999999';
    const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const digest = `sha256:${'f'.repeat(64)}`;
    const requestDigest = 'e'.repeat(64);
    const rowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,receipt_id)
         VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'completed',$10)`,
        [TENANT_A, WORKSPACE_A, operationId, operationId, erasedSource, digest, requestDigest, USER_A, TEST_APPROVAL, operationId],
      );
      await client.query(
        `INSERT INTO cloud_erasure_source_fences(tenant_id,workspace_id,source_kind,source_id,
          table_name,row_id,operation_id,erased_source_version)
         VALUES ($1,$2,'brain_source',$3,'brain_sources',$4,$5,$6)`,
        [TENANT_A, WORKSPACE_A, erasedSource, rowId, operationId, digest],
      );
      expect(await hasErasureFence(client, TENANT_A, WORKSPACE_A, [{ table: 'brain_sources', id: rowId }])).toBe(true);
      expect(await hasErasureFence(client, TENANT_A, WORKSPACE_A, [{ table: 'brain_sources', id: ROW }])).toBe(false);
    });
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      expect(await hasErasureFence(client, TENANT_B, WORKSPACE_B, [{ table: 'brain_sources', id: rowId }])).toBe(false);
    });
  });

  it('creates only a restricted NOLOGIN runtime placeholder when no credential is provisioned', async () => {
    const isolated = new PGlite();
    try {
      await applyPGliteMigrations(isolated, migrations);
      const role = await isolated.query<{
        login: boolean;
        superuser: boolean;
        createdb: boolean;
        createrole: boolean;
        bypassrls: boolean;
        membership_count: number;
        inherit_option: boolean;
        set_option: boolean;
        admin_option: boolean;
      }>(`
        SELECT r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolcreatedb AS createdb,
          r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,
          (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) AS membership_count,
          m.inherit_option,m.set_option,m.admin_option
        FROM pg_roles r JOIN pg_roles bundle ON bundle.rolname='xyra_app_login'
        LEFT JOIN pg_auth_members m ON m.member=r.oid AND m.roleid=bundle.oid
        WHERE r.rolname='xyra_cloud_runtime_app'
      `);
      expect(role.rows[0]).toEqual({
        login: false,
        superuser: false,
        createdb: false,
        createrole: false,
        bypassrls: false,
        membership_count: 1,
        inherit_option: true,
        set_option: false,
        admin_option: false,
      });
    } finally {
      await isolated.close();
    }
  });

  it('uses the least-privilege Worker role and ordered sync migration', async () => {
    const role = await db.query<{
      app_login: boolean;
      bundle_login: boolean;
      bundle_super: boolean;
      bundle_createdb: boolean;
      bundle_createrole: boolean;
      bundle_bypassrls: boolean;
      bundle_owned_objects: number;
      runtime_super: boolean;
      runtime_createdb: boolean;
      runtime_createrole: boolean;
      runtime_bypassrls: boolean;
      runtime_memberships: number;
      inherit_option: boolean;
      set_option: boolean;
      admin_option: boolean;
      can_change_sequence: boolean;
      can_change_owner: boolean;
      can_delete_conflict: boolean;
      can_delete_sync_row: boolean;
      can_update_sync_fields: boolean;
      can_update_sync_tenant: boolean;
      can_insert_webhook: boolean;
      can_delete_webhook: boolean;
      can_update_cron_result: boolean;
      can_update_cron_started: boolean;
      can_delete_expired_replay: boolean;
      default_acls: number;
    }>(`
      SELECT
        runtime.rolsuper AS runtime_super,runtime.rolcreatedb AS runtime_createdb,
        runtime.rolcreaterole AS runtime_createrole,runtime.rolbypassrls AS runtime_bypassrls,
        bundle.rolcanlogin AS bundle_login,bundle.rolsuper AS bundle_super,
        bundle.rolcreatedb AS bundle_createdb,bundle.rolcreaterole AS bundle_createrole,
        bundle.rolbypassrls AS bundle_bypassrls,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname='xyra_app_login' AND rolcanlogin) AS app_login,
        (SELECT count(*)::int FROM pg_auth_members WHERE member=runtime.oid) AS runtime_memberships,
        membership.inherit_option,membership.set_option,membership.admin_option,
        (SELECT count(*)::int FROM pg_class WHERE relowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_proc WHERE proowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_namespace WHERE nspowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_type WHERE typowner=bundle.oid) AS bundle_owned_objects,
        has_column_privilege(runtime.rolname,'cloud_sync_sequences','last_seq','UPDATE') AS can_change_sequence,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','tenant_id','UPDATE') AS can_change_owner,
        has_table_privilege(runtime.rolname,'cloud_sync_conflicts','DELETE') AS can_delete_conflict,
        has_table_privilege(runtime.rolname,'cloud_sync_rows','DELETE') AS can_delete_sync_row,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','fields','UPDATE') AS can_update_sync_fields,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','tenant_id','UPDATE') AS can_update_sync_tenant,
        has_table_privilege(runtime.rolname,'cloud_webhook_receipts','INSERT') AS can_insert_webhook,
        has_table_privilege(runtime.rolname,'cloud_webhook_receipts','DELETE') AS can_delete_webhook,
        has_column_privilege(runtime.rolname,'cloud_cron_runs','outcome','UPDATE') AS can_update_cron_result,
        has_column_privilege(runtime.rolname,'cloud_cron_runs','started_at','UPDATE') AS can_update_cron_started,
        has_table_privilege(runtime.rolname,'cloud_dpop_replays','DELETE') AS can_delete_expired_replay,
        (SELECT count(*)::int FROM pg_default_acl WHERE defaclrole IN (runtime.oid,bundle.oid)) AS default_acls
      FROM pg_roles runtime
      JOIN pg_roles bundle ON bundle.rolname='xyra_app_login'
      LEFT JOIN pg_auth_members membership ON membership.member=runtime.oid AND membership.roleid=bundle.oid
      WHERE runtime.rolname='xyra_cloud_runtime_app'
    `);
    expect(role.rows[0]).toEqual({
      app_login: false,
      bundle_login: false,
      bundle_super: false,
      bundle_createdb: false,
      bundle_createrole: false,
      bundle_bypassrls: false,
      bundle_owned_objects: 0,
      runtime_super: false,
      runtime_createdb: false,
      runtime_createrole: false,
      runtime_bypassrls: false,
      runtime_memberships: 1,
      inherit_option: true,
      set_option: false,
      admin_option: false,
      can_change_sequence: true,
      can_change_owner: false,
      can_delete_conflict: false,
      can_delete_sync_row: false,
      can_update_sync_fields: true,
      can_update_sync_tenant: false,
      can_insert_webhook: true,
      can_delete_webhook: false,
      can_update_cron_result: true,
      can_update_cron_started: false,
      can_delete_expired_replay: true,
      default_acls: 0,
    });
    const rls = await db.query<{ total: number; forced: number }>(`
      SELECT count(*)::int AS total,count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'cloud_sync_%'
    `);
    expect(rls.rows[0]).toEqual({ total: 8, forced: 8 });
    const order = await db.query<{ version: string }>(
      `SELECT id AS version FROM schema_migrations WHERE id IN ('core/0001_cloud_auth','core/0002_cloud_sync','core/0003_cloud_erasure','core/0004_cloud_blob_reference_sets') ORDER BY id`,
    );
    expect(order.rows.map((row) => row.version)).toEqual([
      'core/0001_cloud_auth',
      'core/0002_cloud_sync',
      'core/0003_cloud_erasure',
      'core/0004_cloud_blob_reference_sets',
    ]);
  });

  it('atomically commits row state, per-field sequence, compacted pull log, conflict and cache outbox', async () => {
    const first = pushRequest('first', Date.now() - 10, 'first-key-sync-0001');
    const second = pushRequest('second', Date.now(), 'second-key-sync-0002');
    expect(first && second).toBeTruthy();
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      const engine = new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A));
      await engine.push(access(TENANT_A, WORKSPACE_A), first!, Date.now(), await hashRequest(first!));
      const committed = await engine.push(
        access(TENANT_A, WORKSPACE_A),
        second!,
        Date.now(),
        await hashRequest(second!),
      );
      const replayed = await engine.push(
        access(TENANT_A, WORKSPACE_A),
        second!,
        Date.now(),
        await hashRequest(second!),
      );
      expect(committed.serverSeq).toBe('2');
      expect(replayed.replayed).toBe(true);
      const pull = await engine.pull(access(TENANT_A, WORKSPACE_A), undefined);
      expect(
        pull.ok && pull.response.changes.some((entry) => entry.change.fields['name']?.value === 'second'),
      ).toBe(true);
      return undefined;
    });
    const row = await db.query<{ fields: { name: { value: string } } }>(
      `SELECT fields FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$3`,
      [TENANT_A, WORKSPACE_A, ROW],
    );
    expect(row.rows[0]?.fields['name']?.value).toBe('second');
    const conflict = await db.query<{ record: { losingValue: string } }>(
      `SELECT record FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(conflict.rows.map((item) => item.record.losingValue)).toContain('first');
    const durable = await db.query<{ last_seq: number; changes: number; pending: number }>(
      `SELECT s.last_seq,
        (SELECT count(*)::int FROM cloud_sync_changes c WHERE c.tenant_id=s.tenant_id AND c.workspace_id=s.workspace_id) AS changes,
        (SELECT count(*)::int FROM cloud_sync_outbox o WHERE o.tenant_id=s.tenant_id AND o.workspace_id=s.workspace_id AND o.delivered_at IS NULL) AS pending
       FROM cloud_sync_sequences s WHERE s.tenant_id=$1 AND s.workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(durable.rows[0]).toMatchObject({ last_seq: 2, changes: 2, pending: 2 });
    const log = await db.query<{ server_seq: number; change: { fields: Record<string, unknown> } }>(
      `SELECT server_seq,change FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY server_seq`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(log.rows[0]?.change.fields).not.toHaveProperty('name');
    expect(log.rows[1]?.change.fields).toHaveProperty('name');

    const runScoped = <T>(
      _url: string,
      scope: { tenantId?: string; workspaceId?: string },
      operation: (client: NeonQueryClient) => Promise<T>,
    ) => scoped(scope.tenantId ?? '', scope.workspaceId ?? '', operation);
    let delivery = 0;
    const deliver = async (workspaceId: string, seq: string) => {
      expect(workspaceId).toBe(WORKSPACE_A);
      expect(seq).toBe('2');
      delivery += 1;
      return delivery === 2;
    };
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({ delivered: 0, failed: 1, pruned: 0 });
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({ delivered: 1, failed: 0, pruned: 0 });
    const outbox = await db.query<{ pending: number; attempts: number }>(
      `SELECT count(*) FILTER (WHERE delivered_at IS NULL)::int AS pending,sum(attempts)::int AS attempts
         FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(outbox.rows[0]).toEqual({ pending: 0, attempts: 4 });

    // Old acknowledged invalidations are pruned, while canonical conflict and pull history remains.
    await db.query(
      `UPDATE cloud_sync_outbox SET delivered_at=now()-interval '31 days'
        WHERE tenant_id=$1 AND workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({
      delivered: 0,
      failed: 0,
      pruned: 2,
    });
    const retained = await db.query<{ outbox: number; changes: number; conflicts: number }>(
      `SELECT
        (SELECT count(*)::int FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2) AS outbox,
        (SELECT count(*)::int FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2) AS changes,
        (SELECT count(*)::int FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2) AS conflicts`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(retained.rows[0]).toEqual({ outbox: 0, changes: 2, conflicts: 1 });
  });

  it('prunes idempotency records older than the seven-day replay window only', async () => {
    const oldRequest = pushRequest('retention-old', Date.now(), 'retention-key-sync-0005')!;
    const recentRequest = pushRequest('retention-recent', Date.now() + 1, 'retention-key-sync-0006')!;
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const engine = new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A));
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      await engine.push(access(TENANT_A, WORKSPACE_A), oldRequest, Date.now(), await hashRequest(oldRequest));
      await engine.push(access(TENANT_A, WORKSPACE_A), recentRequest, Date.now(), await hashRequest(recentRequest));
    });
    // Age the record as fixture setup with the migration owner, then exercise pruning as the
    // restricted runtime role in a tenant/workspace-scoped transaction.
    await db.query(
      `UPDATE cloud_sync_idempotency SET created_at=now()-interval '8 days'
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [TENANT_A, WORKSPACE_A, `${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${oldRequest.idempotencyKey}`],
    );
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await new NeonSyncStore(client, TENANT_A, WORKSPACE_A).pruneIdempotency(Date.now() - 7 * 24 * 3_600_000);
    });
    const remaining = await db.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM cloud_sync_idempotency
        WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY idempotency_key`,
      [TENANT_A, WORKSPACE_A],
    );
    const keys = remaining.rows.map((row) => row.idempotency_key);
    expect(keys).not.toContain(`${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${oldRequest.idempotencyKey}`);
    expect(keys).toContain(`${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${recentRequest.idempotencyKey}`);
  });

  it('rolls back every canonical write if the transaction fails before commit', async () => {
    const request = pushRequest('rollback', Date.now(), 'rollback-key-sync-0003')!;
    const before = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    await expect(
      scoped(TENANT_A, WORKSPACE_A, async (client) => {
        await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
        await new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A)).push(
          access(TENANT_A, WORKSPACE_A),
          request,
          Date.now(),
          await hashRequest(request),
        );
        throw new Error('simulate post-write failure');
      }),
    ).rejects.toThrow('simulate post-write failure');
    const rows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    expect(rows.rows[0]?.count).toBe(1); // only the previous committed row remains
    const seq = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    expect(seq.rows[0]?.last_seq).toBe(before.rows[0]?.last_seq);
  });

  it('filters canonical reads by RLS and refuses a cross-tenant write attempt', async () => {
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      await lockWorkspaceSequence(client, TENANT_B, WORKSPACE_B);
      const request = parseSyncPush({
        protocolVersion: 1,
        schemaVersion: 'cloud-sync-v1',
        nodeId: 'nodea',
        idempotencyKey: 'tenant-b-key-sync-0004',
        changes: [
          {
            table: 'ops_projects',
            id: ROW,
            tenantId: TENANT_B,
            workspaceId: WORKSPACE_B,
            op: 'upsert',
            hlc: `${String(Date.now()).padStart(13, '0')}-0001-nodea`,
            fields: {
              name: {
                value: 'tenant b',
                hlc: `${String(Date.now()).padStart(13, '0')}-0001-nodea`,
                baseHlc: null,
              },
            },
          },
        ],
      })!;
      return new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_B, WORKSPACE_B)).push(
        access(TENANT_B, WORKSPACE_B),
        request,
        Date.now(),
        await hashRequest(request),
      );
    });
    await db.exec('SET ROLE xyra_cloud_runtime_app');
    try {
      await db.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
      await db.query("SELECT set_config('app.workspace_id',$1,false)", [WORKSPACE_A]);
      const hidden = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
        [TENANT_B, WORKSPACE_B],
      );
      expect(hidden.rows[0]?.count).toBe(0);
      const dispatchVisible = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND delivered_at IS NULL',
        [TENANT_B, WORKSPACE_B],
      );
      expect(dispatchVisible.rows[0]?.count).toBe(1); // only invalidation metadata is globally readable
      const changed = await db.query(
        `UPDATE cloud_sync_outbox SET delivered_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND delivered_at IS NULL`,
        [TENANT_B, WORKSPACE_B],
      );
      expect(changed.rows).toHaveLength(0); // the cross-tenant dispatch policy is SELECT-only
      await expect(
        db.query(
          `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
         VALUES ($1,$2,'ops_projects',$3,'{}'::jsonb)`,
          [TENANT_B, WORKSPACE_B, '88888888-8888-4888-8888-888888888888'],
        ),
      ).rejects.toThrow();
    } finally {
      await db.exec('RESET ROLE');
    }
    const tenantB = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_B, WORKSPACE_B],
    );
    expect(tenantB.rows[0]?.count).toBe(1);
  });

  it('runtime login can only use the explicitly granted auth, webhook, Cron and expiry operations', async () => {
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const identity = await client.query('SELECT current_user');
      expect(identity.rows[0]?.current_user).toBe('xyra_cloud_runtime_app');
      await client.query(
        `INSERT INTO cloud_webhook_receipts(provider,event_id,payload_hash)
         VALUES ('probe','role-grant-probe-001',decode(repeat('ab',32),'hex'))`,
      );
      const receipt = await client.query(
        `SELECT 1 FROM cloud_webhook_receipts WHERE provider='probe' AND event_id='role-grant-probe-001'`,
      );
      expect(receipt.rows).toHaveLength(1);
      await client.query(
        `INSERT INTO cloud_cron_runs(job_name,window_start) VALUES ('role-grant-probe',now())`,
      );
      const updated = await client.query(
        `UPDATE cloud_cron_runs SET finished_at=now(),outcome='succeeded'
          WHERE job_name='role-grant-probe' RETURNING outcome`,
      );
      expect(updated.rows[0]?.outcome).toBe('succeeded');
      await client.query(
        `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
         VALUES ($1,$2,decode('aabb','hex'),now()-interval '1 second')`,
        [TENANT_A, '77777777-7777-4777-8777-777777777777'],
      );
      const expired = await client.query(
        `DELETE FROM cloud_dpop_replays WHERE tenant_id=$1 AND jti_hash=decode('aabb','hex') RETURNING 1`,
        [TENANT_A],
      );
      expect(expired.rows).toHaveLength(1);
      await expect(client.query(`DELETE FROM cloud_webhook_receipts WHERE provider='probe'`)).rejects.toThrow();
    });
  });
});
