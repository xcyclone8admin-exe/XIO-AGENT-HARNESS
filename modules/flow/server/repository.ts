import type { LocalScopedStore, Scope } from '@xyra/db';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { WorkflowCreate, type ApprovalDecision, type MissedJobPolicy, type RunStatus, type RunTrigger, type WorkflowDefinition, type WorkflowStep } from '../contracts';
import type { StepContext, StepHandlerRegistry } from './handlers';
import { topologicalOrder } from './dag';

/** Default lease a claim holds before it is eligible for reclaim by another caller. */
export const DEFAULT_CLAIM_LEASE_MS = 2 * 60_000;

/** Canonical `YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)` — the same shape zod's `z.iso.datetime({ offset: true })` accepts. */
const CANONICAL_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
function isCanonicalIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value));
}

export interface StepClaim {
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
  readonly context: StepContext;
}

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

interface ClaimRow extends Record<string, unknown> {
  claim_token: string;
  dispatch_id: string;
  lease_expires_at: string | Date;
  released_at: string | Date | null;
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

  /**
   * Bounded by the workflow's max_concurrent_runs: refuses to start another run once the limit of
   * currently-running runs is reached. A `trigger: 'schedule'` run REQUIRES a canonical ISO-8601
   * (offset) `scheduledFor` and fails closed (FLOW_SCHEDULED_RUN_REQUIRES_SCHEDULED_FOR) if it is
   * missing or malformed — this is the one honest source of that value (persisted verbatim in the
   * run's detail; never invented from createdAt), enforced here regardless of whether the caller
   * went through the zod-validated capability input or called this method directly. A
   * `trigger: 'manual'` run never carries one, even if a caller passes it.
   */
  async triggerRun(actor: FlowActor, workflowId: string, trigger: RunTrigger, options?: { scheduledFor?: string }): Promise<RunStatus> {
    const scheduledFor = options?.scheduledFor;
    if (trigger === 'schedule' && !isCanonicalIsoDateTime(scheduledFor)) {
      throw new Error('FLOW_SCHEDULED_RUN_REQUIRES_SCHEDULED_FOR');
    }
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
    const detail = trigger === 'schedule' ? { scheduledFor } : {};
    await this.store.query(
      scope,
      `INSERT INTO flow_runs (id, run_id, tenant_id, workspace_id, workflow_id, trigger, state, step_index, attempt, detail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', 0, 0, $7, $8)`,
      [randomUUID(), runId, actor.tenantId, actor.workspaceId, workflowId, trigger, JSON.stringify(detail), actor.id],
    );
    return this.currentRun(actor, runId);
  }

  /**
   * Single-writer step advance: no concurrency fence. Safe for a manual trigger or a single-
   * instance scheduler. A multi-instance dispatcher must use claimStep + advanceClaimedRun instead
   * — this method does not protect against two concurrent callers racing the same run.
   */
  async advanceRun(actor: FlowActor, runId: string): Promise<RunStatus> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'running') throw new Error('FLOW_RUN_NOT_RUNNING');
    const workflow = await this.requireWorkflow(actor, current.workflowId);
    const step = workflow.steps[current.stepIndex];
    if (!step) throw new Error('FLOW_RUN_STEP_OUT_OF_RANGE');
    const context = this.stepContext(actor, current, step);
    await this.executeStep(actor, current, workflow, step, context);
    return this.currentRun(actor, runId);
  }

  /**
   * Atomically claims the run's current step for exclusive execution. Fails with
   * FLOW_STEP_ALREADY_CLAIMED if another caller already holds a live (unexpired, unreleased) claim
   * on the same (run, step, attempt). The claim fence IS that tuple — the same one flow_checkpoints
   * already enforces uniqueness on — so a claim can never span two different steps or attempts.
   */
  async claimStep(actor: FlowActor, runId: string, leaseMs: number = DEFAULT_CLAIM_LEASE_MS): Promise<StepClaim> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'running') throw new Error('FLOW_RUN_NOT_RUNNING');
    const workflow = await this.requireWorkflow(actor, current.workflowId);
    const step = workflow.steps[current.stepIndex];
    if (!step) throw new Error('FLOW_RUN_STEP_OUT_OF_RANGE');
    const scope = scopeOf(actor);
    const claimToken = randomUUID();
    const context = this.stepContext(actor, current, step);
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.store.query<{ claim_token: string }>(
      scope,
      `INSERT INTO flow_step_claims (tenant_id, workspace_id, run_id, step_index, attempt, claim_token, dispatch_id, claimed_by, lease_expires_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (tenant_id, workspace_id, run_id, step_index, attempt) DO UPDATE SET
         claim_token = EXCLUDED.claim_token, dispatch_id = EXCLUDED.dispatch_id, claimed_by = EXCLUDED.claimed_by,
         claimed_at = now(), lease_expires_at = EXCLUDED.lease_expires_at, released_at = NULL
       WHERE flow_step_claims.released_at IS NOT NULL OR flow_step_claims.lease_expires_at < now()
       RETURNING claim_token`,
      [actor.tenantId, actor.workspaceId, runId, current.stepIndex, current.attempt, claimToken, context.dispatchId, actor.id, leaseExpiresAt],
    );
    if (result.rows[0]?.claim_token !== claimToken) throw new Error('FLOW_STEP_ALREADY_CLAIMED');
    return { claimToken, leaseExpiresAt, context };
  }

  /**
   * Advances a run's current step on behalf of a caller holding a live claim from claimStep. The
   * claim is re-verified (token match, unexpired, unreleased) immediately before the step executes
   * and again immediately before its outcome is persisted, then released once the outcome lands —
   * a stale claimant (one whose lease expired and was reclaimed by someone else) is rejected at
   * either check and can write nothing.
   */
  async advanceClaimedRun(actor: FlowActor, runId: string, claimToken: string): Promise<RunStatus> {
    const current = await this.currentRun(actor, runId);
    if (current.state !== 'running') throw new Error('FLOW_RUN_NOT_RUNNING');
    const workflow = await this.requireWorkflow(actor, current.workflowId);
    const step = workflow.steps[current.stepIndex];
    if (!step) throw new Error('FLOW_RUN_STEP_OUT_OF_RANGE');
    await this.requireLiveClaim(actor, runId, current.stepIndex, current.attempt, claimToken);
    const context = this.stepContext(actor, current, step);
    await this.executeStep(actor, current, workflow, step, context, async () => {
      await this.requireLiveClaim(actor, runId, current.stepIndex, current.attempt, claimToken);
    });
    await this.releaseClaim(actor, runId, current.stepIndex, current.attempt);
    return this.currentRun(actor, runId);
  }

  private stepContext(actor: FlowActor, current: RunStatus, step: WorkflowStep): StepContext {
    // Derived only from the run's own persisted detail (set once, validated, at triggerRun) —
    // never from step.input. Absent for every manual run, by construction of triggerRun.
    const scheduledFor = isCanonicalIsoDateTime(current.detail.scheduledFor) ? current.detail.scheduledFor : null;
    return {
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      principalId: actor.id,
      workflowId: current.workflowId,
      runId: current.runId,
      trigger: current.trigger,
      stepId: step.id,
      stepIndex: current.stepIndex,
      attempt: current.attempt,
      scheduledFor,
      dispatchId: `${current.runId}:${current.stepIndex}:${current.attempt}`,
    };
  }

  /**
   * Shared step-execution core for both advanceRun and advanceClaimedRun: the approval gate,
   * checkpoint-reuse-or-execute, and next-event decision are identical either way — only who may
   * call it, and whether a claim is re-verified before the outcome is persisted, differs.
   * `beforePersist` (claimed path only) re-checks claim liveness right before the checkpoint write.
   */
  private async executeStep(
    actor: FlowActor,
    current: RunStatus,
    workflow: WorkflowDefinition,
    step: WorkflowStep,
    context: StepContext,
    beforePersist?: () => Promise<void>,
  ): Promise<void> {
    const runId = current.runId;
    if (step.requiresApproval) {
      const approval = await this.findApproval(actor, runId, current.stepIndex, current.attempt);
      if (!approval) {
        await beforePersist?.();
        await this.appendRunEvent(actor, current, { state: 'awaiting_approval', stepIndex: current.stepIndex, attempt: current.attempt, ended: false });
        return;
      }
      if (approval.decision === 'reject') {
        await beforePersist?.();
        await this.appendRunEvent(actor, current, { state: 'dead_letter', stepIndex: current.stepIndex, attempt: current.attempt, ended: true, detail: { rejected: true } });
        return;
      }
    }

    let checkpoint = await this.findCheckpoint(actor, runId, current.stepIndex, current.attempt);
    if (!checkpoint) {
      try {
        const output = await this.handlers.run(step.handler, step.input, context);
        await beforePersist?.();
        checkpoint = await this.recordCheckpoint(actor, runId, current.stepIndex, step.id, current.attempt, 'succeeded', output, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await beforePersist?.();
        checkpoint = await this.recordCheckpoint(actor, runId, current.stepIndex, step.id, current.attempt, 'failed', {}, message);
      }
    } else {
      await beforePersist?.();
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
  }

  private async requireLiveClaim(actor: FlowActor, runId: string, stepIndex: number, attempt: number, claimToken: string): Promise<void> {
    const scope = scopeOf(actor);
    const result = await this.store.query<ClaimRow>(
      scope,
      'SELECT claim_token, dispatch_id, lease_expires_at, released_at FROM flow_step_claims WHERE run_id = $1 AND step_index = $2 AND attempt = $3',
      [runId, stepIndex, attempt],
    );
    const claim = result.rows[0];
    if (!claim || claim.claim_token !== claimToken || claim.released_at !== null || new Date(claim.lease_expires_at).getTime() < Date.now()) {
      throw new Error('FLOW_CLAIM_INVALID_OR_EXPIRED');
    }
  }

  private async releaseClaim(actor: FlowActor, runId: string, stepIndex: number, attempt: number): Promise<void> {
    const scope = scopeOf(actor);
    await this.store.query(
      scope,
      `UPDATE flow_step_claims SET released_at = now() WHERE run_id = $1 AND step_index = $2 AND attempt = $3 AND released_at IS NULL`,
      [runId, stepIndex, attempt],
    );
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
