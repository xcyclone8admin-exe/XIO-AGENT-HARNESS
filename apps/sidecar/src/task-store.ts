import { uuidv7 } from '@xyra/core';
import { TaskSnapshot, type Principal } from '@xyra/contracts';
import type { GrantedTable, LocalScopedStore, Scope, ScopedTransaction } from '@xyra/db';
import { BusFault } from './bus';

export const HOST_TABLES: readonly GrantedTable[] = [
  { name: 'host_tasks', class: 'local', authority: 'server', serverWriteCapabilities: ['host_tasks'] },
  { name: 'host_task_events', class: 'append', authority: 'server', serverInsertCapabilities: ['host_tasks'] },
];
export function taskScope(principal: Principal, workspaceId: string): Scope {
  if (principal.kind !== 'user' || !principal.workspaces.some((w) => w.id === workspaceId))
    throw new BusFault('TASK_SCOPE_DENIED', 403, 'Current user workspace membership required');
  return { tenantId: principal.tenantId, workspaceId };
}
interface TaskRow extends Record<string, unknown> { payload: unknown; actor_id: string; request_digest: string }
export class TaskStore {
  constructor(private readonly store: LocalScopedStore) {}

  async recover(principal: Principal): Promise<void> {
    for (const workspace of principal.workspaces) {
      const rows = await this.store.withServerScope(taskScope(principal, workspace.id), 'host_tasks', undefined,
        (tx) => tx.query<{ id: string } & Record<string, unknown>>(`SELECT id FROM host_tasks WHERE actor_id=$1
          AND payload->>'state' IN ('queued','planning','running','verifying')`, [principal.id]));
      for (const row of rows.rows) await this.update(principal, workspace.id, row.id, undefined, 'interrupted',
        'Host restarted. Explicit resume is required; uncertain write effects need reconciliation.', (t) => { t.state = 'interrupted'; });
    }
  }

  async get(principal: Principal, workspaceId: string, taskId: string): Promise<TaskSnapshot> {
    return this.store.withServerScope(taskScope(principal, workspaceId), 'host_tasks', undefined, async (tx) => {
      const found = await tx.query<TaskRow>('SELECT payload,actor_id,request_digest FROM host_tasks WHERE id=$1 AND actor_id=$2', [taskId, principal.id]);
      const row = found.rows[0];
      if (!row) throw new BusFault('TASK_NOT_FOUND', 404, 'Task not found');
      return this.withEvents(tx, TaskSnapshot.parse(row.payload));
    });
  }
  async list(principal: Principal, workspaceId: string, chatId: string): Promise<TaskSnapshot[]> {
    return this.store.withServerScope(taskScope(principal, workspaceId), 'host_tasks', undefined, async (tx) => {
      const found = await tx.query<TaskRow>(`SELECT payload,actor_id,request_digest FROM host_tasks
        WHERE actor_id=$1 AND payload->>'chatId'=$2 ORDER BY payload->>'createdAt' DESC LIMIT 50`, [principal.id, chatId]);
      const tasks: TaskSnapshot[] = [];
      for (const row of found.rows) tasks.push(await this.withEvents(tx, TaskSnapshot.parse(row.payload)));
      return tasks;
    });
  }
  async create(principal: Principal, workspaceId: string, requestId: string, requestDigest: string, task: TaskSnapshot): Promise<TaskSnapshot> {
    return this.store.withServerScope(taskScope(principal, workspaceId), 'host_tasks', undefined, async (tx) => {
      const inserted = await tx.query(`INSERT INTO host_tasks(id,tenant_id,workspace_id,actor_id,request_id,request_digest,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (tenant_id,workspace_id,actor_id,request_id) DO NOTHING RETURNING id`,
      [task.taskId, principal.tenantId, workspaceId, principal.id, requestId, requestDigest, JSON.stringify(task)]);
      if (inserted.rows.length) {
        await this.append(tx, taskScope(principal, workspaceId), task, 'queued', 'Task admitted durably; no tool has executed.');
        return task;
      }
      const previous = await tx.query<TaskRow>('SELECT payload,actor_id,request_digest FROM host_tasks WHERE actor_id=$1 AND request_id=$2', [principal.id, requestId]);
      const row = previous.rows[0];
      if (!row || row.request_digest !== requestDigest) throw new BusFault('TASK_REQUEST_CONFLICT', 409, 'Request key reused with changed content');
      return this.withEvents(tx, TaskSnapshot.parse(row.payload));
    });
  }
  async update(principal: Principal, workspaceId: string, taskId: string, revision: number | undefined,
    stage: string, detail: string, change: (task: TaskSnapshot) => void, evidence: unknown = {}): Promise<TaskSnapshot> {
    return this.store.withServerScope(taskScope(principal, workspaceId), 'host_tasks', undefined, async (tx) => {
      const found = await tx.query<TaskRow>('SELECT payload,actor_id,request_digest FROM host_tasks WHERE id=$1 AND actor_id=$2 FOR UPDATE', [taskId, principal.id]);
      const row = found.rows[0];
      if (!row) throw new BusFault('TASK_NOT_FOUND', 404, 'Task not found');
      const task = await this.withEvents(tx, TaskSnapshot.parse(row.payload));
      if (revision !== undefined && task.revision !== revision) throw new BusFault('TASK_REVISION_CONFLICT', 409, 'Task revision changed; reload its preview');
      change(task);
      task.updatedAt = new Date().toISOString();
      await this.append(tx, taskScope(principal, workspaceId), task, stage, detail, evidence);
      await tx.query('UPDATE host_tasks SET payload=$1::jsonb WHERE id=$2 AND actor_id=$3', [JSON.stringify({ ...task, events: [] }), taskId, principal.id]);
      return task;
    });
  }
  private async withEvents(tx: ScopedTransaction, task: TaskSnapshot): Promise<TaskSnapshot> {
    const events = await tx.query<{ event: unknown } & Record<string, unknown>>('SELECT event FROM host_task_events WHERE task_id=$1 ORDER BY sequence', [task.taskId]);
    return TaskSnapshot.parse({ ...task, events: events.rows.map((r) => r.event) });
  }
  private async append(tx: ScopedTransaction, scope: Scope, task: TaskSnapshot, stage: string, detail: string, evidence: unknown = {}): Promise<void> {
    const event = { sequence: task.events.length + 1, revision: task.revision, stage, detail, occurredAt: new Date().toISOString() };
    task.events.push(event);
    await tx.query('INSERT INTO host_task_events(tenant_id,workspace_id,task_id,sequence,event,evidence) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [scope.tenantId, scope.workspaceId, task.taskId, event.sequence, JSON.stringify(event), JSON.stringify(evidence)]);
  }
  newTask(chatId: string, instruction: string, connectionId: string): TaskSnapshot {
    const now = new Date().toISOString();
    return { taskId: uuidv7(), chatId, instruction, connectionId, revision: 1, state: 'queued', summary: '',
      actions: [], events: [], result: null, error: null, createdAt: now, updatedAt: now };
  }
}
