import { expect, test } from 'vitest';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { bootstrapLocalIdentity } from '@xyra/mod-core/server';
import { hashApprovalInput } from '@xyra/contracts';
import { MIGRATIONS } from './generated/migrations';
import { MANIFESTS } from './generated/modules';
import { HOST_TABLES, TaskStore } from './task-store';
import { TaskService } from './tasks';
import { CapabilityBus } from './bus';

test('host schema upgrades baseline without broad grants; actor/scope, expiry and interrupted effects fail closed', async () => {
  const db = await openLocalStore();
  try {
    await applyPGliteMigrations(db, MIGRATIONS.filter((m) => m.module !== 'host'));
    const principal = await bootstrapLocalIdentity(db, 'test:host-upgrade', 'Upgrade tester');
    await applyPGliteMigrations(db, MIGRATIONS);
    await applyPGliteMigrations(db, MIGRATIONS);
    expect((await db.query("SELECT id FROM schema_migrations WHERE id='host/0001_tasks'")).rows).toHaveLength(1);
    await prepareLocalAppRole(db, [...MANIFESTS.flatMap((m) => m.tables), ...HOST_TABLES]);
    const scoped = new LocalScopedStore(db); const tasks = new TaskStore(scoped);
    const workspaceId = principal.workspaces.find((w) => w.kind === 'standard')!.id;
    const scope = { tenantId: principal.tenantId, workspaceId };
    const task = await tasks.create(principal, workspaceId, crypto.randomUUID(), await hashApprovalInput({ original: true }),
      tasks.newTask(crypto.randomUUID(), 'Original scope', 'controlled:test'));
    await expect(scoped.query(scope, 'UPDATE host_tasks SET payload=$1::jsonb WHERE id=$2', ['{}', task.taskId])).rejects.toThrow(/permission denied/i);
    await expect(scoped.withServerScope(scope, 'host_tasks', undefined,
      (tx) => tx.query('UPDATE host_task_events SET evidence=$1::jsonb WHERE task_id=$2', ['{}', task.taskId]))).rejects.toThrow(/permission denied|append-only/i);
    await expect(tasks.get({ ...principal, id: crypto.randomUUID() }, workspaceId, task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(tasks.get(principal, principal.workspaces.find((w) => w.kind === 'sample')!.id, task.taskId)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    const bus = new CapabilityBus({ append: async () => {} }, { get: async () => undefined, put: async () => {} }, { verify: async () => null }, () => false, async () => new Set());
    const service = new TaskService(tasks, bus, { list: async () => [], test: async () => { throw new Error('UNAVAILABLE'); }, plan: async () => ({ summary: '', actions: [] }) });
    const preview = { id: crypto.randomUUID(), capabilityId: 'brain.procedures.propose', title: 'Procedure', input: { title: 'Test' },
      inputDigest: await hashApprovalInput({ title: 'Test' }), revision: 1, kind: 'write' as const, risk: 'medium' as const,
      approvalRequirement: 'confirmation' as const, effects: 'Create candidate', expiresAt: new Date(Date.now() - 1000).toISOString(), state: 'proposed' as const };
    await tasks.update(principal, workspaceId, task.taskId, 1, 'preview', 'Expired consent fixture', (t) => { t.state = 'waiting_approval'; t.actions = [preview]; });
    await expect(service.approve(principal, workspaceId, { taskId: task.taskId, revision: 1, actionId: preview.id, inputDigest: preview.inputDigest })).rejects.toMatchObject({ code: 'TASK_PREVIEW_STALE' });
    const revised = await service.control(principal, workspaceId, { taskId: task.taskId, revision: 1, action: 'revise', instruction: 'Changed scope' });
    expect(revised.revision).toBe(2); expect(revised.actions).toEqual([]); expect(revised.state).toBe('paused');
    await expect(service.approve(principal, workspaceId, { taskId: task.taskId, revision: 1, actionId: preview.id, inputDigest: preview.inputDigest })).rejects.toMatchObject({ code: 'TASK_REVISION_CONFLICT' });
    await tasks.update(principal, workspaceId, task.taskId, 2, 'executing', 'Crash fixture', (t) => {
      t.state = 'running'; t.actions = [{ ...preview, revision: 2, state: 'running', expiresAt: new Date(Date.now() + 60000).toISOString() }];
    });
    await tasks.recover(principal);
    expect((await tasks.get(principal, workspaceId, task.taskId)).state).toBe('interrupted');
    await expect(service.control(principal, workspaceId, { taskId: task.taskId, revision: 2, action: 'resume' })).rejects.toMatchObject({ code: 'TASK_EFFECT_RECONCILIATION_REQUIRED' });
    await service.close();
  } finally { await db.close(); }
}, 60000);
