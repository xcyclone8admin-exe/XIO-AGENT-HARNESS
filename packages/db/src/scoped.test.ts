import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
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
  const sql = readFileSync(fileURLToPath(new URL('../migrations/0001_platform.sql', import.meta.url)), 'utf8');
  const modules = readFileSync(fileURLToPath(new URL('../migrations/0002_modules.sql', import.meta.url)), 'utf8');
  await applyPGliteMigrations(db, [migration('platform/0001_platform', sql), migration('platform/0002_modules', modules)]);
  await prepareLocalAppRole(db);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)',
    [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  scoped = new LocalScopedStore(db);
}, 60_000);

afterAll(async () => { await db?.close(); });

test('a scoped query sees only its own workspace and resets role after the transaction', async () => {
  const a = await scoped.query<{ id: string }>({ tenantId: tenantA, workspaceId: workspaceA },
    'SELECT id FROM workspaces ORDER BY id');
  expect(a.rows.map((row) => row.id)).toEqual([workspaceA]);
  const b = await scoped.query<{ id: string }>({ tenantId: tenantB, workspaceId: workspaceB },
    'SELECT id FROM workspaces ORDER BY id');
  expect(b.rows.map((row) => row.id)).toEqual([workspaceB]);
  const identity = await db.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0]?.current_user).not.toBe('xyra_app');
});

test('a scoped write cannot insert another tenant', async () => {
  await expect(scoped.query({ tenantId: tenantA, workspaceId: workspaceA },
    'INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3)',
    ['019a0000-0000-7000-8000-000000000099', tenantB, 'intruder']))
    .rejects.toThrow();
});
