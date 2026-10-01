import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { uuidv7 } from '@xyra/core';
import commsManifest from '../manifest';
import { CommsService } from '../server/service';
import { loadMigrations } from './fixtures';

let db: PGlite;
let service: CommsService;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, loadMigrations());
  await prepareLocalAppRole(db, commsManifest.tables);
  service = new CommsService(new LocalScopedStore(db));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function makeWorkspace(name: string) {
  const tenantId = uuidv7();
  const workspaceId = uuidv7();
  const userId = uuidv7();
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantId, `${name} tenant`]);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3)', [userId, tenantId, name]);
  await db.query(
    'INSERT INTO workspaces(id,tenant_id,name,kind,sync_enabled) VALUES ($1,$2,$3,$4,$5)',
    [workspaceId, tenantId, name, 'standard', false],
  );
  await db.query(
    'INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4,$5)',
    [uuidv7(), tenantId, workspaceId, userId, 'owner'],
  );
  return { tenantId, workspaceId, userId };
}

describe('comms service', () => {
  test('threads are scoped to workspace', async () => {
    const a = await makeWorkspace('C-A');
    const b = await makeWorkspace('C-B');

    await service.createThread(a, a.userId, 'Hello from A', 'email');

    const aThreads = await service.threads(a);
    const bThreads = await service.threads(b);
    expect(aThreads).toHaveLength(1);
    expect(bThreads).toHaveLength(0);
    expect(aThreads[0]?.subject).toBe('Hello from A');
  });

  test('done and snooze update thread status', async () => {
    const ws = await makeWorkspace('C-C');
    const thread = await service.createThread(ws, ws.userId, 'Status test', 'slack');

    const snoozed = await service.snoozeThread(ws, thread.id, new Date(Date.now() + 3600_000).toISOString());
    expect(snoozed?.status).toBe('snoozed');

    const done = await service.doneThread(ws, thread.id);
    expect(done?.status).toBe('done');

    const open = await service.threads(ws, 'open');
    expect(open).toHaveLength(0);
  });

  test('messages are append-only and scoped to thread', async () => {
    const ws = await makeWorkspace('C-D');
    const thread = await service.createThread(ws, ws.userId, 'Msg test', 'in_app');

    await service.appendOutboundMessage(ws, ws.userId, thread.id, 'First message');
    const msgs = await service.messages(ws, thread.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.direction).toBe('outbound');

    await expect(
      db.query('UPDATE comms_messages SET body=$1 WHERE id=$2', ['changed', msgs[0]?.id]),
    ).rejects.toThrow();
  });

  test('bus-verified approvalId is persisted in the message record', async () => {
    const ws = await makeWorkspace('C-G');
    const thread = await service.createThread(ws, ws.userId, 'Approval binding test', 'email');
    const approvalId = uuidv7();

    const msg = await service.appendOutboundMessage(ws, ws.userId, thread.id, 'Approved body', approvalId);
    expect(msg.send_approval_id).toBe(approvalId);

    const msgs = await service.messages(ws, thread.id);
    expect(msgs[0]?.send_approval_id).toBe(approvalId);
  });

  test('events are scoped to workspace', async () => {
    const a = await makeWorkspace('C-E');
    const b = await makeWorkspace('C-F');

    const now = new Date();
    const later = new Date(now.getTime() + 3600_000);
    await service.createEvent(a, a.userId, 'Team sync', now.toISOString(), later.toISOString());

    const aEvents = await service.events(a);
    const bEvents = await service.events(b);
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(0);
  });
});
