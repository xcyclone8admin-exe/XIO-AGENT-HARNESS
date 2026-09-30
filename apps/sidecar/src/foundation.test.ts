import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { bootstrapLocalIdentity, CoreService } from '@xyra/mod-core/server';
import { OpsService } from '@xyra/mod-ops/server';
import { CapabilityBus } from './bus';
import { DurableBusAudit, DurableBusIdempotency } from './durable';
import { registerFoundationCapabilities } from './foundation';

let db: PGlite;
let bus: CapabilityBus;

beforeAll(async () => {
  db = await openLocalStore();
  const root = new URL('../../../packages/db/migrations/', import.meta.url);
  const migrations = ['0001_platform', '0002_modules'].map((name) => migration(
    `platform/${name}`, readFileSync(fileURLToPath(new URL(`${name}.sql`, root)), 'utf8')));
  await applyPGliteMigrations(db, migrations);
  await prepareLocalAppRole(db);
  const scoped = new LocalScopedStore(db);
  bus = new CapabilityBus(
    new DurableBusAudit(scoped),
    new DurableBusIdempotency(scoped),
    { verify: async () => false },
    () => false,
    async () => new Set(),
  );
  registerFoundationCapabilities(bus, new CoreService(scoped), new OpsService(scoped));
}, 60_000);
afterAll(async () => { await db?.close(); });

test('native bootstrap is idempotent and sample data stays in its own workspace', async () => {
  const alice = await bootstrapLocalIdentity(db, 'os:alice', 'Alice');
  const repeat = await bootstrapLocalIdentity(db, 'os:alice', 'Alice');
  expect(repeat.id).toBe(alice.id);
  expect(alice.workspaces).toHaveLength(2);
  const standard = alice.workspaces.find((w) => w.kind === 'standard')!;
  const sample = alice.workspaces.find((w) => w.kind === 'sample')!;
  const standardProjects = await bus.call({ principal: alice, workspaceId: standard.id,
    capabilityId: 'ops.projects.list', input: {} });
  expect(standardProjects).toEqual([]);
  const sampleProjects = await bus.call({ principal: alice, workspaceId: sample.id,
    capabilityId: 'ops.projects.list', input: {} });
  expect(sampleProjects).toMatchObject([{ name: 'Launch checklist' }]);
});

test('capability policy and RLS keep another local tenant out', async () => {
  const alice = await bootstrapLocalIdentity(db, 'os:alice', 'Alice');
  const bob = await bootstrapLocalIdentity(db, 'os:bob', 'Bob');
  const a = alice.workspaces.find((w) => w.kind === 'standard')!;
  const b = bob.workspaces.find((w) => w.kind === 'standard')!;
  const created = await bus.call({ principal: alice, workspaceId: a.id,
    capabilityId: 'ops.projects.create', input: { name: 'Private project' },
    idempotencyKey: 'first-project' });
  const again = await bus.call({ principal: alice, workspaceId: a.id,
    capabilityId: 'ops.projects.create', input: { name: 'Private project' },
    idempotencyKey: 'first-project' });
  expect(again).toEqual(created);
  await expect(bus.call({ principal: alice, workspaceId: a.id,
    capabilityId: 'ops.projects.create', input: { name: 'Changed input' },
    idempotencyKey: 'first-project' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const bobProjects = await bus.call({ principal: bob, workspaceId: b.id,
    capabilityId: 'ops.projects.list', input: {} });
  expect(bobProjects).toEqual([]);
  await expect(bus.call({ principal: bob, workspaceId: a.id,
    capabilityId: 'ops.projects.list', input: {} })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_GRANTED' });
});
