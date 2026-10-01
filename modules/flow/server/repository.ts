import type { LocalScopedStore, Scope } from '@xyra/db';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { WorkflowCreate, type ApprovalDecision, type MissedJobPolicy, type RunStatus, type RunTrigger, type WorkflowDefinition, type WorkflowStep } from '../contracts';
import type { StepHandlerRegistry } from './handlers';
import { topologicalOrder } from './dag';

export interface FlowActor {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

interface WorkflowRow extends Record<string, unknown> {
  id: string;
  name: string;
  steps: unknown;
  max_attempts: number;
  max_concurrent_runs: number;
  missed_job_policy: string;
  enabled: boolean;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ApprovalRow extends Record<string, unknown> {
  run_id: string;
  step_index: number;
  attempt: number;
  decision: string;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  workflow_id: string;
  trigger: string;
  state: string;
  step_index: number;
  attempt: number;
  detail: unknown;
  created_by: string;
  created_at: string | Date;
  ended_at: string | Date | null;
}

interface CheckpointRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  step_index: number;
  step_id: string;
  status: string;
  attempt: number;
  output: unknown;
  error: string | null;
  created_at: string | Date;
}

/**
 * PGlite (like node-postgres) returns `timestamptz` columns as JS Date objects, not strings, even
 * though every row type here is declared as `string` for query-site convenience. Every date field
 * leaving this module for a zod-validated boundary (a capability output, a test assertion against
 * WorkflowDefinition/RunStatus) MUST go through this so it is never handed out as a raw Date.
 */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
function toIsoNullable(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function toWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    steps: row.steps as WorkflowStep[],
    maxAttempts: row.max_attempts,
    maxConcurrentRuns: row.max_concurrent_runs,
    missedJobPolicy: row.missed_job_policy as MissedJobPolicy,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toRunStatus(row: RunRow): RunStatus {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    trigger: row.trigger as RunTrigger,
    state: row.state as RunStatus['state'],
    stepIndex: row.step_index,
    attempt: row.attempt,
    detail: (row.detail as Record<string, unknown>) ?? {},
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    endedAt: toIsoNullable(row.ended_at),
  };
}

/**
 * FLOW persistence and engine. Every run transition is an appended event (flow_runs is
 * append-only); the current status of a run is always its latest event. A step's outcome is
 * recorded once as an idempotent checkpoint (unique on run/step/attempt) before the next event is
 * appended, so re-invoking advanceRun after a crash resumes from exactly where it left off instead
 * of re-running a step that already completed.
 */
export class FlowRepository {
  constructor(
    private readonly store: LocalScopedStore,
    private readonly handlers: StepHandlerRegistry,
  ) {}

  async listWorkflows(actor: FlowActor): Promise<WorkflowDefinition[]> {
    const scope = scopeOf(actor);
    const result = await this.store.query<WorkflowRow>(
      scope,
      'SELECT id, name, steps, max_attempts, max_concurrent_runs, missed_job_policy, enabled, created_by, created_at, updated_at FROM flow_workflows ORDER BY name',
    );
    return result.rows.map(toWorkflow);
  }

  /** Validates the step DAG as acyclic and persists steps in their resolved topological order. */
  async createWorkflow(actor: FlowActor, input: z.input<typeof WorkflowCreate>): Promise<WorkflowDefinition> {
    const request = WorkflowCreate.parse(input);
    const scope = scopeOf(actor);
    const id = randomUUID();
    const orderedSteps = topologicalOrder(request.steps);
    await this.store.query(
      scope,
      `INSERT INTO flow_workflows (id, tenant_id, workspace_id, name, steps, max_attempts, max_concurrent_runs, missed_job_policy, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, actor.tenantId, actor.workspaceId, request.name, JSON.stringify(orderedSteps), request.maxAttempts, request.maxConcurrentRuns, request.missedJobPolicy, actor.id],
    );
    return this.requireWorkflow(actor, id);
  }

  async requireWorkflow(actor: FlowActor, workflowId: string): Promise<WorkflowDefinition> {
    const scope = scopeOf(actor);
    const result = await this.store.query<WorkflowRow>(
      scope,
      'SELECT id, name, steps, max_attempts, max_concurrent_runs, missed_job_policy, enabled, created_by, created_at, updated_at FROM flow_workflows WHERE id = $1',
      [workflowId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('FLOW_WORKFLOW_NOT_FOUND');
    return toWorkflow(row);
  }

  async listRuns(actor: FlowActor, workflowId: string): Promise<RunStatus[]> {
    const scope = scopeOf(actor);
    const result = await this.store.query<RunRow>(
      scope,
      `SELECT DISTINCT ON (run_id) id, run_id, workflow_id, trigger, state, step_index, attempt, detail, created_by, created_at, ended_at
       FROM flow_runs WHERE workflow_id = $1 ORDER BY run_id, created_at DESC`,
      [workflowId],
    );
    return result.rows.map(toRunStatus).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async currentRun(actor: FlowActor, runId: string): Promise<RunStatus> {
    const scope = scopeOf(actor);
    const result = await this.store.query<RunRow>(
      scope,
      'SELECT id, run_id, workflow_id, trigger, state, step_index, attempt, detail, created_by, created_at, ended_at FROM flow_runs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1',
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('FLOW_RUN_NOT_FOUND');
    return toRunStatus(row);
  }

  /** Bounded by the workflow's max_concurrent_runs: refuses to start another run once the limit of currently-running runs is reached. */
  async triggerRun(actor: FlowActor, workflowId: string, trigger: RunTrigger): Promise<RunStatus> {
    const scope = scopeOf(actor);
    const workflow = await this.requireWorkflow(actor, workflowId);
    if (!workflow.enabled) throw new Error('FLOW_WORKFLOW_DISABLED');
    const running = await this.store.query<{ count: string }>(
      scope,
      `SELECT count(*) AS count FROM (
         SELECT DISTINCT ON (run_id) run_id, state FROM flow_runs WHERE workflow_id = $1 ORDER BY run_id, created_at DESC
       ) current_runs WHERE state = 'running'`,
      [workflowId],
    );
    if (Number(running.rows[0]?.count ?? '0') >= workflow.maxConcurrentRuns) {
      throw new Error('FLOW_CONCURRENCY_LIMIT_REACHED');
    }
    const runId = randomUUID();
    // The registry row must exist before the first flow_runs event: flow_runs.run_id carries a
    // real FK into flow_run_registry as of migration 0003.
    await this.store.query(
      scope,
      `INSERT INTO flow_run_registry (tenant_id, workspace_id, run_id, workflow_id, trigger, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor.tenantId, actor.workspaceId, runId, workflowId, trigger, actor.id],
    );
    await this.store.query(
      scope,
      `INSERT INTO flow_runs (id, run_id, tenant_id, workspace_id, workflow_id, trigger, state, step_index, attempt, detail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', 0, 0, '{}'::jsonb, $7)`,
      [randomUUID(), runId, actor.tenantId, actor.workspaceId, workflowId, trigger, actor.id],
    );
    return this.currentRun(actor, runId);
  }

  /**
   * Executes the step at the run's current checkpoint, or — if that step already has a recorded
   * checkpoint (a prior attempt crashed after checkpointing but before advancing the run event) —
   * reuses that checkpoint's outcome without re-invoking the handler.
   */
  async advanceRun(actor: FlowActor, runId: string): Promise<RunStatus> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'running') throw new Error('FLOW_RUN_NOT_RUNNING');
    const workflow = await this.requireWorkflow(actor, current.workflowId);
    const step = workflow.steps[current.stepIndex];
    if (!step) throw new Error('FLOW_RUN_STEP_OUT_OF_RANGE');

    if (step.requiresApproval) {
      const approval = await this.findApproval(actor, runId, current.stepIndex, current.attempt);
      if (!approval) {
        await this.appendRunEvent(actor, current, { state: 'awaiting_approval', stepIndex: current.stepIndex, attempt: current.attempt, ended: false });
        return this.currentRun(actor, runId);
      }
      if (approval.decision === 'reject') {
        await this.appendRunEvent(actor, current, { state: 'dead_letter', stepIndex: current.stepIndex, attempt: current.attempt, ended: true, detail: { rejected: true } });
        return this.currentRun(actor, runId);
      }
    }

    let checkpoint = await this.findCheckpoint(actor, runId, current.stepIndex, current.attempt);
    if (!checkpoint) {
      try {
        const output = await this.handlers.run(step.handler, step.input, { runId, stepId: step.id, attempt: current.attempt });
        checkpoint = await this.recordCheckpoint(actor, runId, current.stepIndex, step.id, current.attempt, 'succeeded', output, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        checkpoint = await this.recordCheckpoint(actor, runId, current.stepIndex, step.id, current.attempt, 'failed', {}, message);
      }
    }

    if (checkpoint.status === 'succeeded') {
      const nextIndex = current.stepIndex + 1;
      if (nextIndex >= workflow.steps.length) {
        await this.appendRunEvent(actor, current, { state: 'succeeded', stepIndex: current.stepIndex, attempt: current.attempt, ended: true });
      } else {
        await this.appendRunEvent(actor, current, { state: 'running', stepIndex: nextIndex, attempt: 0, ended: false });
      }
    } else {
      const nextAttempt = current.attempt + 1;
      if (nextAttempt >= workflow.maxAttempts) {
        await this.appendRunEvent(actor, current, { state: 'dead_letter', stepIndex: current.stepIndex, attempt: current.attempt, ended: true, detail: { error: checkpoint.error } });
      } else {
        await this.appendRunEvent(actor, current, { state: 'running', stepIndex: current.stepIndex, attempt: nextAttempt, ended: false });
      }
    }
    return this.currentRun(actor, runId);
  }

  async cancelRun(actor: FlowActor, runId: string): Promise<RunStatus> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'running' && current.state !== 'awaiting_approval') throw new Error('FLOW_RUN_NOT_RUNNING');
    await this.appendRunEvent(actor, current, { state: 'canceled', stepIndex: current.stepIndex, attempt: current.attempt, ended: true });
    return this.currentRun(actor, runId);
  }

  /**
   * Records a decision on the step a run is currently awaiting approval for, then returns the run
   * to 'running' so the next advanceRun call re-evaluates the gate: an 'approve' decision lets it
   * proceed to execute the step's handler; 'reject' is resolved as dead_letter on that next call.
   */
  async decideApproval(actor: FlowActor, runId: string, decision: ApprovalDecision, reason: string): Promise<RunStatus> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'awaiting_approval') throw new Error('FLOW_RUN_NOT_AWAITING_APPROVAL');
    const scope = scopeOf(actor);
    await this.store.query(
      scope,
      `INSERT INTO flow_approvals (id, tenant_id, workspace_id, run_id, step_index, attempt, decision, reason, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), actor.tenantId, actor.workspaceId, runId, current.stepIndex, current.attempt, decision, reason, actor.id],
    );
    await this.appendRunEvent(actor, current, { state: 'running', stepIndex: current.stepIndex, attempt: current.attempt, ended: false });
    return this.currentRun(actor, runId);
  }

  private async findApproval(actor: FlowActor, runId: string, stepIndex: number, attempt: number): Promise<ApprovalRow | undefined> {
    const scope = scopeOf(actor);
    const result = await this.store.query<ApprovalRow>(
      scope,
      'SELECT run_id, step_index, attempt, decision FROM flow_approvals WHERE run_id = $1 AND step_index = $2 AND attempt = $3',
      [runId, stepIndex, attempt],
    );
    return result.rows[0];
  }

  private async findCheckpoint(actor: FlowActor, runId: string, stepIndex: number, attempt: number) {
    const scope = scopeOf(actor);
    const result = await this.store.query<CheckpointRow>(
      scope,
      'SELECT id, run_id, step_index, step_id, status, attempt, output, error, created_at FROM flow_checkpoints WHERE run_id = $1 AND step_index = $2 AND attempt = $3',
      [runId, stepIndex, attempt],
    );
    return result.rows[0];
  }

  private async recordCheckpoint(
    actor: FlowActor,
    runId: string,
    stepIndex: number,
    stepId: string,
    attempt: number,
    status: 'succeeded' | 'failed',
    output: Record<string, unknown>,
    error: string | null,
  ): Promise<CheckpointRow> {
    const scope = scopeOf(actor);
    await this.store.query(
      scope,
      `INSERT INTO flow_checkpoints (id, tenant_id, workspace_id, run_id, step_index, step_id, status, attempt, output, error, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [randomUUID(), actor.tenantId, actor.workspaceId, runId, stepIndex, stepId, status, attempt, JSON.stringify(output), error, actor.id],
    );
    const checkpoint = await this.findCheckpoint(actor, runId, stepIndex, attempt);
    if (!checkpoint) throw new Error('FLOW_CHECKPOINT_WRITE_FAILED');
    return checkpoint;
  }

  private async appendRunEvent(
    actor: FlowActor,
    current: RunStatus,
    next: { state: RunStatus['state']; stepIndex: number; attempt: number; ended: boolean; detail?: Record<string, unknown> },
  ): Promise<void> {
    const scope = scopeOf(actor);
    await this.store.query(
      scope,
      `INSERT INTO flow_runs (id, run_id, tenant_id, workspace_id, workflow_id, trigger, state, step_index, attempt, detail, created_by, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${next.ended ? 'now()' : 'NULL'})`,
      [
        randomUUID(),
        current.runId,
        actor.tenantId,
        actor.workspaceId,
        current.workflowId,
        current.trigger,
        next.state,
        next.stepIndex,
        next.attempt,
        JSON.stringify(next.detail ?? {}),
        actor.id,
      ],
    );
  }
}

function scopeOf(actor: FlowActor): Scope {
  return { tenantId: actor.tenantId, workspaceId: actor.workspaceId };
}
