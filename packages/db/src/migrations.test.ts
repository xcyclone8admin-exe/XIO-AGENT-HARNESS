import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, assertOrdered, migration } from './migrations';
import { openLocalStore } from './pglite';

const SQL = readFileSync(
  fileURLToPath(new URL('../migrations/0001_platform.sql', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');
const M = migration('platform/0001_platform', SQL);
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const WA = '019a0000-0000-7000-8000-000000000011';
const WB = '019a0000-0000-7000-8000-000000000012';
let db: PGlite;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [M]);
  await db.exec(`CREATE ROLE xyra_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO xyra_app;
    GRANT SELECT ON tenants, workspaces, users, memberships, approval_requests,
      approval_decisions, audit_events, domain_events, sync_outbox,
      sync_conflicts, sync_cursors TO xyra_app`);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [A, 'A', B, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [
    WA,
    A,
    'A workspace',
    WB,
    B,
    'B workspace',
  ]);
  await db.exec(`
    INSERT INTO users(id,tenant_id,display_name) VALUES ('019a0000-0000-7000-8000-000000000022','${B}','B user');
    INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role) VALUES ('019a0000-0000-7000-8000-000000000023','${B}','${WB}','019a0000-0000-7000-8000-000000000022','owner');
    INSERT INTO approval_requests(id,tenant_id,workspace_id,capability_id,input_hash,requested_by,reason,expires_at)
      VALUES ('019a0000-0000-7000-8000-000000000024','${B}','${WB}','test.capability.call','hash','019a0000-0000-7000-8000-000000000022','test',now()+interval '1 hour');
    INSERT INTO approval_decisions(id,tenant_id,workspace_id,request_id,decided_by,decision,reason)
      VALUES ('019a0000-0000-7000-8000-000000000025','${B}','${WB}','019a0000-0000-7000-8000-000000000024','019a0000-0000-7000-8000-000000000022','approved','test');
    INSERT INTO audit_events(id,tenant_id,workspace_id,actor_id,action,target_type)
      VALUES ('019a0000-0000-7000-8000-000000000026','${B}','${WB}','019a0000-0000-7000-8000-000000000022','test','test');
    INSERT INTO domain_events(id,tenant_id,workspace_id,event_type,aggregate_id,actor_id,payload)
      VALUES ('019a0000-0000-7000-8000-000000000027','${B}','${WB}','test.event','test','019a0000-0000-7000-8000-000000000022','{}');
    INSERT INTO sync_outbox(id,tenant_id,workspace_id,table_name,row_id,change)
      VALUES ('019a0000-0000-7000-8000-000000000028','${B}','${WB}','test','019a0000-0000-7000-8000-000000000027','{}');
    INSERT INTO sync_conflicts(id,tenant_id,workspace_id,table_name,row_id,field_name,winning_hlc,losing_hlc)
      VALUES ('019a0000-0000-7000-8000-000000000029','${B}','${WB}','test','019a0000-0000-7000-8000-000000000027','name','1-0-a','1-0-b');
    INSERT INTO sync_cursors(tenant_id,workspace_id,device_id)
      VALUES ('${B}','${WB}','019a0000-0000-7000-8000-000000000030');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('migrations are idempotent and reject an altered checksum', async () => {
  await applyPGliteMigrations(db, [M]);
  await expect(
    applyPGliteMigrations(db, [migration(M.id, `${M.sql}\n-- altered after application`)]),
  ).rejects.toThrow('Applied migration changed');
});

test('every app-readable relation excludes tenant B under tenant A context', async () => {
  const readable = await db.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','v','m')
      AND has_table_privilege('xyra_app', c.oid, 'SELECT') ORDER BY c.relname`);
  expect(readable.rows).toHaveLength(11);
  for (const { relname } of readable.rows) {
    const column = relname === 'tenants' ? 'id' : 'tenant_id';
    const owner = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${relname}" WHERE ${column}=$1`,
      [B],
    );
    expect(owner.rows[0]?.n, `${relname} fixture`).toBeGreaterThan(0);
  }
  await db.exec('SET ROLE xyra_app');
  try {
    const noScope = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants');
    expect(noScope.rows[0]?.n).toBe(0);
    await db.query("SELECT set_config('app.tenant_id', $1, false)", [A]);
    await db.query("SELECT set_config('app.workspace_id', $1, false)", [WA]);
    for (const { relname } of readable.rows) {
      const rows = await db.query<Record<string, unknown>>(`SELECT * FROM "${relname}"`);
      const column = relname === 'tenants' ? 'id' : 'tenant_id';
      expect(
        rows.rows.every((row) => row[column] !== B),
        relname,
      ).toBe(true);
    }
    const workspaces = await db.query<{ id: string }>('SELECT id FROM workspaces');
    expect(workspaces.rows.map((r) => r.id)).toEqual([WA]);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('module blocks follow dependency order, not lexical order (ADR-0016)', () => {
  const m = (id: string) => migration(id, `-- ${id}`);
  expect(() =>
    assertOrdered([m('platform/0001_a'), m('platform/0002_b'), m('money/0001_a'), m('invest/0001_a')]),
  ).not.toThrow();
  expect(() => assertOrdered([m('money/0001_a'), m('platform/0001_a')])).toThrow(/Platform/);
  expect(() => assertOrdered([m('platform/0001_a'), m('platform/0003_c')])).toThrow(/sequence/);
  expect(() =>
    assertOrdered([m('platform/0001_a'), m('money/0001_a'), m('invest/0001_a'), m('money/0002_b')]),
  ).toThrow(/contiguous/);
});
