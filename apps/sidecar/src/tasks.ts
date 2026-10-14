import { z } from 'zod';
import { hashApprovalInput, TaskPlan } from '@xyra/contracts';
import type { Principal, TaskAdmission, TaskApproval, TaskControl, TaskModelPort, TaskSnapshot } from '@xyra/contracts';
import { BusFault, type CapabilityBus } from './bus';
import { taskScope, type TaskStore } from './task-store';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const errorCode = (error: unknown) => error instanceof BusFault ? error.code :
  error instanceof Error && /^[A-Z][A-Z0-9_]{1,99}$/.test(error.message) ? error.message : 'TASK_EXECUTION_FAILED';

/** Owns host state, not model authority. All effects still enter CapabilityBus. */
export class TaskService {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void>; principal: Principal; workspaceId: string }>();
  private readonly pending = new Map<string, { principal: Principal; workspaceId: string }>();
  private closing = false;
  constructor(private readonly store: TaskStore, private readonly bus: CapabilityBus, readonly models: TaskModelPort) {}

  async admit(principal: Principal, workspaceId: string, input: TaskAdmission): Promise<TaskSnapshot> {
    taskScope(principal, workspaceId);
    if (this.closing || this.pending.size >= 100) throw new BusFault('TASK_QUEUE_UNAVAILABLE', 503, 'Task host is stopping or its bounded queue is full');
    const chats = await this.bus.call({ principal, workspaceId, capabilityId: 'command.chats.list', input: {} }) as { id: string }[];
    if (!chats.some((c) => c.id === input.chatId)) throw new BusFault('TASK_CHAT_NOT_FOUND', 404, 'Conversation not in this workspace');
    const models = await this.models.list(taskScope(principal, workspaceId));
    if (!models.some((model) => model.id === input.connectionId && model.available))
      throw new BusFault('MODEL_CONNECTION_UNAVAILABLE', 409, 'Configure and test an available model');
    const task = await this.store.create(principal, workspaceId, input.requestId, await hashApprovalInput(input),
      this.store.newTask(input.chatId, input.instruction, input.connectionId));
    if (!terminal.has(task.state) && !['paused', 'interrupted', 'waiting_approval'].includes(task.state)) this.kick(principal, workspaceId, task.taskId);
    return task;
  }
  get(principal: Principal, workspaceId: string, taskId: string): Promise<TaskSnapshot> { return this.store.get(principal, workspaceId, taskId); }
  list(principal: Principal, workspaceId: string, chatId: string): Promise<TaskSnapshot[]> { return this.store.list(principal, workspaceId, chatId); }

  async approve(principal: Principal, workspaceId: string, input: TaskApproval): Promise<TaskSnapshot> {
    const task = await this.store.update(principal, workspaceId, input.taskId, input.revision, 'approved',
      'Exact preview confirmed by the current user.', (task) => {
        const action = task.actions.find((a) => a.id === input.actionId);
        if (task.state !== 'waiting_approval' || !action || action.state !== 'proposed' ||
          action.revision !== input.revision || action.inputDigest !== input.inputDigest || Date.parse(action.expiresAt) <= Date.now())
          throw new BusFault('TASK_PREVIEW_STALE', 409, 'Preview expired, changed, or was already decided');
        if (action.approvalRequirement === 'independent' && !input.approvalId)
          throw new BusFault('APPROVAL_REQUIRED', 409, 'This action still requires an independent approval');
        action.state = 'approved';
        if (input.approvalId) action.approvalId = input.approvalId;
        task.state = 'running';
      }, { actionId: input.actionId, inputDigest: input.inputDigest, actorId: principal.id, approvalId: input.approvalId ?? null });
    this.kick(principal, workspaceId, input.taskId);
    return task;
  }
  async control(principal: Principal, workspaceId: string, input: TaskControl): Promise<TaskSnapshot> {
    if (input.action === 'resume' && this.active.has(input.taskId))
      throw new BusFault('TASK_STOP_PENDING', 409, 'The current operation is still stopping; resume after its acknowledgement');
    const task = await this.store.update(principal, workspaceId, input.taskId, input.revision, input.action,
      input.action === 'cancel' || input.action === 'pause' ? 'Stop requested. An already started tool may finish; no following tool will start.' : 'User task control recorded.', (task) => {
        if (terminal.has(task.state) && input.action !== 'revise') throw new BusFault('TASK_ALREADY_TERMINAL', 409, 'Task is already terminal');
        if (input.action === 'pause') task.state = 'paused';
        if (input.action === 'cancel') task.state = 'cancelled';
        if (input.action === 'revise') {
          if (!input.instruction || !['paused', 'interrupted', 'waiting_approval', 'failed', 'completed'].includes(task.state) || task.actions.some((a) => a.state === 'running'))
            throw new BusFault('TASK_REVISION_UNSAFE', 409, 'Pause and wait for the current tool before revising');
          task.instruction = input.instruction; task.revision += 1; task.actions = [];
          task.summary = ''; task.result = null; task.error = null; task.state = 'paused';
        }
        if (input.action === 'resume') {
          if (!['paused', 'interrupted'].includes(task.state)) throw new BusFault('TASK_NOT_PAUSED', 409, 'Task is not paused');
          if (task.actions.some((a) => a.state === 'running' && a.kind !== 'read'))
            throw new BusFault('TASK_EFFECT_RECONCILIATION_REQUIRED', 409, 'An interrupted write needs effect reconciliation before retry');
          for (const action of task.actions) {
            if (action.state === 'running') action.state = 'proposed';
            // A previous consent never survives pause/restart. Show a fresh preview.
            if (action.state === 'approved') action.state = 'proposed';
          }
          task.state = task.actions.length ? 'running' : 'queued';
        }
      }, { instruction: input.instruction ?? null, actorId: principal.id });
    if (['pause', 'cancel', 'revise'].includes(input.action)) this.active.get(input.taskId)?.abort.abort();
    else this.kick(principal, workspaceId, input.taskId);
    return task;
  }
  private kick(principal: Principal, workspaceId: string, taskId: string): void {
    if (this.closing) return;
    this.pending.set(taskId, { principal, workspaceId });
    this.drain();
  }
  private drain(): void {
    if (this.closing) return;
    for (const [id, context] of this.pending) {
      if (this.active.size >= 2) break;
      if (this.active.has(id)) continue;
      this.pending.delete(id);
      const abort = new AbortController();
      const done = this.execute(context.principal, context.workspaceId, id, AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]))
        .catch(() => undefined).finally(() => { this.active.delete(id); this.drain(); });
      this.active.set(id, { abort, done, ...context });
    }
  }
  private async execute(principal: Principal, workspaceId: string, id: string, signal: AbortSignal): Promise<void> {
    let task = await this.get(principal, workspaceId, id);
    if (terminal.has(task.state) || ['paused', 'interrupted', 'waiting_approval'].includes(task.state)) return;
    const revision = task.revision;
    try {
      if (!task.actions.length && task.state === 'queued') {
        task = await this.store.update(principal, workspaceId, id, revision, 'context', 'Conversation and authorized tools resolved.', (t) => { t.state = 'planning'; });
        await this.bus.call({ principal, workspaceId, capabilityId: 'command.chats.send',
          input: { chatId: task.chatId, content: task.instruction }, idempotencyKey: `task:${id}:${revision}:message` });
        const catalog = (await this.bus.catalog(principal, workspaceId)).filter((cap) => cap.agentCallable);
        const plan = TaskPlan.parse(await this.models.plan({ taskId: id, revision, tenantId: principal.tenantId,
          workspaceId, actorId: principal.id, instruction: task.instruction, connectionId: task.connectionId, signal,
          capabilities: catalog.map((cap) => ({ id: cap.id, title: cap.title, description: cap.description,
            kind: cap.kind, risk: cap.risk, inputSchema: z.toJSONSchema(cap.input) })) }));
        const actions = await Promise.all(plan.actions.map(async (proposal) => {
          const cap = catalog.find((c) => c.id === proposal.capabilityId);
          if (!cap) throw new BusFault('TASK_TOOL_NOT_ALLOWED', 403, 'Model proposed a tool outside its catalog');
          const parsed = cap.input.safeParse(proposal.input);
          if (!parsed.success) throw new BusFault('TASK_TOOL_INPUT_INVALID', 400, 'Proposed tool input failed validation');
          return { id: crypto.randomUUID(), capabilityId: cap.id, title: cap.title, input: parsed.data,
            inputDigest: await hashApprovalInput(parsed.data), revision, kind: cap.kind, risk: cap.risk,
            approvalRequirement: cap.kind === 'consequential' || ['high', 'critical'].includes(cap.risk) || cap.approvalPolicy ? 'independent' as const : cap.kind === 'read' ? 'none' as const : 'confirmation' as const,
            effects: cap.description, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), state: 'proposed' as const };
        }));
        task = await this.store.update(principal, workspaceId, id, revision, 'planned', 'Bounded model proposals validated against registered tool schemas.', (t) => {
          if (t.state !== 'planning' || signal.aborted) return;
          t.summary = plan.summary; t.actions = actions; t.state = 'running';
        }, { plan });
      }
      for (;;) {
        task = await this.get(principal, workspaceId, id);
        if (terminal.has(task.state) || ['paused', 'interrupted'].includes(task.state)) return;
        if (signal.aborted) throw new Error('TASK_DEADLINE_OR_CANCELLED');
        const action = task.actions.find((a) => !['succeeded', 'invalidated'].includes(a.state));
        if (!action) {
          await this.store.update(principal, workspaceId, id, revision, 'verified', 'Registered capability output schemas checked. This is not independent review or release certification.', (t) => {
            if (['paused', 'cancelled'].includes(t.state)) return;
            t.state = 'completed'; t.result = t.actions.length
              ? `${t.actions.filter((a) => a.state === 'succeeded').length} capability action(s) completed; inspect the recorded outputs.`
              : `Model draft (no tools executed): ${t.summary}`;
          });
          return;
        }
        if (action.state === 'failed') return;
        if (action.approvalRequirement !== 'none' && action.state !== 'approved') {
          await this.store.update(principal, workspaceId, id, revision, 'preview', 'Review the exact proposed input and effects before approving.', (t) => {
            if (t.state === 'running') t.state = 'waiting_approval';
          }, { action });
          return;
        }
        if (await hashApprovalInput(action.input) !== action.inputDigest) throw new BusFault('TASK_PREVIEW_CHANGED', 409, 'Stored preview input changed');
        const latestCatalog = await this.bus.catalog(principal, workspaceId);
        if (!latestCatalog.some((c) => c.id === action.capabilityId && c.agentCallable)) throw new BusFault('TASK_TOOL_NOT_ALLOWED', 403, 'Tool no longer authorized');
        let started = false;
        await this.store.update(principal, workspaceId, id, revision, 'executing', `Starting ${action.title}.`, (t) => {
          if (t.state !== 'running' || signal.aborted) return;
          const a = t.actions.find((a) => a.id === action.id)!;
          if (a.state === 'running' || (a.kind !== 'read' && a.state !== 'approved')) throw new BusFault('TASK_ACTION_CONFLICT', 409, 'Action already claimed or unapproved');
          if (Date.parse(a.expiresAt) <= Date.now()) throw new BusFault('TASK_PREVIEW_EXPIRED', 409, 'Preview expired');
          a.state = 'running'; started = true;
        }, { actionId: action.id, capabilityId: action.capabilityId, inputDigest: action.inputDigest });
        if (!started) return;
        const output = await this.bus.call({ principal, workspaceId, capabilityId: action.capabilityId,
          input: action.input, idempotencyKey: `task:${id}:${revision}:${action.id}`,
          ...(action.approvalId ? { approvalId: action.approvalId } : {}) });
        if (JSON.stringify(output).length > 200000) throw new Error('TASK_OUTPUT_LIMIT');
        await this.store.update(principal, workspaceId, id, revision, 'tool_result', `${action.title} returned a validated output.`, (t) => {
          const a = t.actions.find((a) => a.id === action.id)!;
          a.state = 'succeeded'; a.result = output;
        }, { actionId: action.id, outputDigest: await hashApprovalInput(output) });
      }
    } catch (error) {
      await this.store.update(principal, workspaceId, id, undefined, 'stopped', errorCode(error), (t) => {
        if (['paused', 'cancelled', 'interrupted'].includes(t.state)) return;
        t.state = 'failed'; t.error = errorCode(error);
        for (const a of t.actions) if (a.state === 'running') { a.state = 'failed'; a.error = t.error; }
      });
    }
  }
  async close(): Promise<void> {
    this.closing = true; this.pending.clear();
    for (const [id, context] of this.active) await this.store.update(context.principal, context.workspaceId, id, undefined,
      'interrupted', 'Host is stopping. Resume explicitly after restart.', (t) => {
        if (['queued', 'planning', 'running', 'verifying'].includes(t.state)) t.state = 'interrupted';
      });
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
