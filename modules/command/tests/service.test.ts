import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { uuidv7 } from '@xyra/core';
import coreManifest from '@xyra/mod-core/manifest';
import commandManifest from '../manifest';
import { CommandService } from '../server/service';
import { loadMigrations } from './fixtures';

let db: PGlite;
let service: CommandService;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, loadMigrations());
  await prepareLocalAppRole(db, [...coreManifest.tables, ...commandManifest.tables]);
  service = new CommandService(new LocalScopedStore(db));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function makeWorkspace(name: string): Promise<{ tenantId: string; workspaceId: string; userId: string }> {
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

describe('command service', () => {
  test('dashboard summary scopes to workspace', async () => {
    const workspace = await makeWorkspace('A');
    const summary = await service.dashboardSummary(workspace);
    expect(summary.greeting).toMatch(/morning|afternoon|evening|night/i);
    expect(summary.unread_alerts).toBe(0);
    expect(summary.pending_approvals).toBe(0);
  });

  test('chats, messages and alerts stay within their workspace', async () => {
    const a = await makeWorkspace('B');
    const b = await makeWorkspace('C');

    const chat = await service.createChat(a, a.userId, 'Strategy');
    await service.sendChatMessage(a, a.userId, chat.id, 'user', 'Hello');
    await service.createAlert(a, a.userId, 'A1', 'body', 'warning');

    const aChats = await service.chats(a);
    const bChats = await service.chats(b);
    expect(aChats).toHaveLength(1);
    expect(bChats).toHaveLength(0);

    const aMessages = await service.chatMessages(a, chat.id);
    expect(aMessages).toHaveLength(1);
    expect(aMessages[0]?.content).toBe('Hello');

    const aAlerts = await service.alerts(a);
    const bAlerts = await service.alerts(b);
    expect(aAlerts).toHaveLength(1);
    expect(bAlerts).toHaveLength(0);
  });

  test('dismissal and completion mutate only the target row', async () => {
    const workspace = await makeWorkspace('D');
    const alert = await service.createAlert(workspace, workspace.userId, 'A', '', 'info');
    const action = await service.createAction(workspace, workspace.userId, 'Act', '', 'normal');

    const dismissed = await service.dismissAlert(workspace, alert.id);
    expect(dismissed?.dismissed_at).not.toBeNull();
    const openAlerts = await service.alerts(workspace);
    expect(openAlerts).toHaveLength(0);

    const completed = await service.completeAction(workspace, action.id);
    expect(completed?.done_at).not.toBeNull();
    const openActions = await service.actions(workspace);
    expect(openActions).toHaveLength(0);
  });

  test('append tables reject update and delete', async () => {
    const workspace = await makeWorkspace('E');
    const chat = await service.createChat(workspace, workspace.userId, 'Chat');
    const message = await service.sendChatMessage(workspace, workspace.userId, chat.id, 'user', 'x');

    await expect(
      db.query('UPDATE command_chat_messages SET content=$1 WHERE id=$2', ['changed', message.id]),
    ).rejects.toThrow();
    await expect(db.query('DELETE FROM command_chat_messages WHERE id=$1', [message.id])).rejects.toThrow();
  });
});
