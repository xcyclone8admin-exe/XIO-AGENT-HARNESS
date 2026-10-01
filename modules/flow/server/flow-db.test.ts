import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { WorkflowDefinition, RunStatus } from '../contracts';
import { FlowRepository } from './repository';
import { StepHandlerRegistry } from './handlers';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actorIdA = '019a0000-0000-7000-8000-000000000021';
const actorIdB = '019a0000-0000-7000-8000-000000000022';
let db: Db;
let scoped: LocalScopedStore;
let handlers: StepHandlerRegistry;
let flow: FlowRepository;
let failCount = 0;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('flow', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [actorIdA, tenantA, 'Actor A', actorIdB, tenantB, 'Actor B']);
  scoped = new LocalScopedStore(db);
  handlers = new StepHandlerRegistry();
  handlers.register('always-fails', async () => {
    failCount += 1;
    throw new Error(`boom-${failCount}`);
  });
  handlers.register('counts-calls', async (input, ctx) => ({ ...input, calls: ((input.calls as number) ?? 0) + 1, attempt: ctx.attempt }));
  flow = new FlowRepository(scoped, handlers);
}, 60_000);

afterAll(async () => { await db?.close(); });

const actorA = { id: actorIdA, tenantId: tenantA, workspaceId: workspaceA };
const actorB = { id: actorIdB, tenantId: tenantB, workspaceId: workspaceB };

describe('FLOW schema and workspace isolation', () => {
  it('creates every declared FLOW table', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
  });

  /**
   * Mirrors apps/sidecar/src/registry.test.ts's "manifest column specs match the migrated schema"
   * check, scoped to this module: `requiredOnInsert` must be true exactly when the column is
   * NOT NULL with no DB default (CLD-R-007). A column with a DEFAULT (e.g. flow_runs.step_index,
   * flow_runs.attempt) is NOT required on insert even though it is NOT NULL — the regression this
   * guards against.
   */
  it('keeps every column spec in parity with the migrated schema (type, nullable, requiredOnInsert)', async () => {
    for (const table of manifest.tables) {
      if (!table.columns) continue;
      const described = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table.name],
      );
      const byName = new Map(described.rows.map((row) => [row.column_name, row]));
      for (const [name, spec] of Object.entries(table.columns)) {
        const column = byName.get(name);
        const where = `${table.name}.${name}`;
        expect(column, where).toBeDefined();
        if (!column) continue;
        const pgType = column.data_type === 'timestamp with time zone' ? 'timestamptz' : column.data_type;
        expect(pgType, `${where} type`).toBe(spec.type);
        expect(column.is_nullable === 'YES', `${where} nullable`).toBe(spec.nullable);
        expect(column.is_nullable === 'NO' && column.column_default === null, `${where} requiredOnInsert`).toBe(spec.requiredOnInsert);
        if (spec.references) {
          const fk = await db.query(
            `SELECT 1 FROM information_schema.key_column_usage k
             JOIN information_schema.referential_constraints r
               ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema
             JOIN information_schema.table_constraints t
               ON t.constraint_name = r.unique_constraint_name AND t.constraint_schema = r.unique_constraint_schema
             WHERE k.table_name = $1 AND k.column_name = $2 AND t.table_name = $3`,
            [table.name, name, spec.references.table],
          );
          expect(fk.rows.length, `${where} references ${spec.references.table}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('rejects a checkpoint or approval row whose run_id has no flow_run_registry entry', async () => {
    const bogusRunId = '019a0000-0000-7000-8000-00000000dead';
    await expect(
      scoped.query(
        { tenantId: tenantA, workspaceId: workspaceA },
        `INSERT INTO flow_checkpoints (id, tenant_id, workspace_id, run_id, step_index, step_id, status, attempt, output, error, created_by)
         VALUES ($1, $2, $3, $4, 0, 'orphan', 'succeeded', 0, '{}'::jsonb, NULL, $5)`,
        ['019a0000-0000-7000-8000-00000000c0de', tenantA, workspaceA, bogusRunId, actorIdA],
      ),
    ).rejects.toThrow();
    await expect(
      scoped.query(
        { tenantId: tenantA, workspaceId: workspaceA },
        `INSERT INTO flow_approvals (id, tenant_id, workspace_id, run_id, step_index, attempt, decision, reason, decided_by)
         VALUES ($1, $2, $3, $4, 0, 0, 'approve', '', $5)`,
        ['019a0000-0000-7000-8000-00000000face', tenantA, workspaceA, bogusRunId, actorIdA],
      ),
    ).rejects.toThrow();
  });

  it('registers one flow_run_registry row per logical run, created before the run can advance', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'registry-backed', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const registry = await scoped.query<{ run_id: string; workflow_id: string; trigger: string }>(
      { tenantId: tenantA, workspaceId: workspaceA },
      'SELECT run_id, workflow_id, trigger FROM flow_run_registry WHERE run_id = $1',
      [started.runId],
    );
    expect(registry.rows).toHaveLength(1);
    expect(registry.rows[0]).toMatchObject({ run_id: started.runId, workflow_id: workflow.id, trigger: 'manual' });
    await flow.advanceRun(actorA, started.runId);
    // Advancing appends more flow_runs events for the same run_id; the registry row stays singular.
    const stillOne = await scoped.query({ tenantId: tenantA, workspaceId: workspaceA }, 'SELECT run_id FROM flow_run_registry WHERE run_id = $1', [started.runId]);
    expect(stillOne.rows).toHaveLength(1);
  });
});

describe('FLOW durable run execution', () => {
  it('runs a two-step workflow to completion through the noop handler, persisting a checkpoint per step', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'two-step',
      steps: [
        { id: 'first', handler: 'noop', input: { a: 1 } },
        { id: 'second', handler: 'noop', input: { b: 2 } },
      ],
      maxAttempts: 3,
      maxConcurrentRuns: 1,
    });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    expect(started.state).toBe('running');
    expect(started.stepIndex).toBe(0);

    const afterStepOne = await flow.advanceRun(actorA, started.runId);
    expect(afterStepOne.state).toBe('running');
    expect(afterStepOne.stepIndex).toBe(1);
    expect(afterStepOne.attempt).toBe(0);

    const afterStepTwo = await flow.advanceRun(actorA, started.runId);
    expect(afterStepTwo.state).toBe('succeeded');
    expect(afterStepTwo.endedAt).not.toBeNull();
  });

  it('is resumable: re-advancing after a step already checkpointed does not re-invoke the handler', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'resumable',
      steps: [{ id: 'count', handler: 'counts-calls', input: { calls: 0 } }],
      maxAttempts: 3,
      maxConcurrentRuns: 1,
    });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const done = await flow.advanceRun(actorA, started.runId);
    expect(done.state).toBe('succeeded');

    // Simulate a crashed engine re-invoked against a run that already completed its only step:
    // advanceRun must refuse rather than re-run a terminal run.
    await expect(flow.advanceRun(actorA, started.runId)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
  });

  it('bounds retries and dead-letters a run whose step keeps failing', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'always-fails-workflow',
      steps: [{ id: 'doomed', handler: 'always-fails', input: {} }],
      maxAttempts: 2,
      maxConcurrentRuns: 1,
    });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const afterFirstFailure = await flow.advanceRun(actorA, started.runId);
    expect(afterFirstFailure.state).toBe('running');
    expect(afterFirstFailure.attempt).toBe(1);

    const afterSecondFailure = await flow.advanceRun(actorA, started.runId);
    expect(afterSecondFailure.state).toBe('dead_letter');
    expect(afterSecondFailure.endedAt).not.toBeNull();

    await expect(flow.advanceRun(actorA, started.runId)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
  });

  it('enforces the workflow concurrency bound', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'bounded-concurrency',
      steps: [{ id: 'only', handler: 'noop', input: {} }],
      maxAttempts: 3,
      maxConcurrentRuns: 1,
    });
    await flow.triggerRun(actorA, workflow.id, 'manual');
    await expect(flow.triggerRun(actorA, workflow.id, 'manual')).rejects.toThrow('FLOW_CONCURRENCY_LIMIT_REACHED');
  });

  it('cancels a running run and refuses further advancement', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'cancelable',
      steps: [{ id: 'only', handler: 'noop', input: {} }],
      maxAttempts: 3,
      maxConcurrentRuns: 2,
    });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const canceled = await flow.cancelRun(actorA, started.runId);
    expect(canceled.state).toBe('canceled');
    await expect(flow.advanceRun(actorA, started.runId)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
  });

  it('isolates workflows and runs per tenant/workspace', async () => {
    expect(await flow.listWorkflows(actorB)).toEqual([]);
    const workflowB = await flow.createWorkflow(actorB, { name: 'tenant-b-only', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    expect(await flow.listWorkflows(actorB)).toHaveLength(1);
    await expect(flow.requireWorkflow(actorA, workflowB.id)).rejects.toThrow('FLOW_WORKFLOW_NOT_FOUND');
  });

  it('returns WorkflowDefinition and RunStatus that validate as the wire contract (regression: PGlite timestamptz is a Date, not a string)', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'contract-shape', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    expect(() => WorkflowDefinition.parse(workflow)).not.toThrow();
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    expect(() => RunStatus.parse(started)).not.toThrow();
    const completed = await flow.advanceRun(actorA, started.runId);
    expect(() => RunStatus.parse(completed)).not.toThrow();
    const [listedRun] = await flow.listRuns(actorA, workflow.id);
    expect(() => RunStatus.parse(listedRun)).not.toThrow();
  });

  it('resolves a declared step DAG into topological execution order regardless of declaration order', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'dag-order',
      steps: [
        { id: 'c', handler: 'noop', input: {}, dependsOn: ['b'] },
        { id: 'a', handler: 'noop', input: {}, dependsOn: [] },
        { id: 'b', handler: 'noop', input: {}, dependsOn: ['a'] },
      ],
      maxAttempts: 3,
      maxConcurrentRuns: 1,
    });
    expect(workflow.steps.map((step) => step.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a workflow whose step dependencies form a cycle', async () => {
    await expect(
      flow.createWorkflow(actorA, {
        name: 'cyclic',
        steps: [
          { id: 'a', handler: 'noop', input: {}, dependsOn: ['b'] },
          { id: 'b', handler: 'noop', input: {}, dependsOn: ['a'] },
        ],
        maxAttempts: 3,
        maxConcurrentRuns: 1,
      }),
    ).rejects.toThrow('FLOW_WORKFLOW_HAS_CYCLE');
  });

  it('gates a requiresApproval step until a decision is recorded, and rejects dead-letter the run', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'gated',
      steps: [{ id: 'sensitive', handler: 'noop', input: {}, requiresApproval: true }],
      maxAttempts: 3,
      maxConcurrentRuns: 2,
    });

    const approvedRun = await flow.triggerRun(actorA, workflow.id, 'manual');
    const awaiting = await flow.advanceRun(actorA, approvedRun.runId);
    expect(awaiting.state).toBe('awaiting_approval');
    await expect(flow.advanceRun(actorA, approvedRun.runId)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
    const resumed = await flow.decideApproval(actorA, approvedRun.runId, 'approve', 'looks fine');
    expect(resumed.state).toBe('running');
    const completed = await flow.advanceRun(actorA, approvedRun.runId);
    expect(completed.state).toBe('succeeded');

    const rejectedRun = await flow.triggerRun(actorA, workflow.id, 'manual');
    await flow.advanceRun(actorA, rejectedRun.runId);
    await flow.decideApproval(actorA, rejectedRun.runId, 'reject', 'not now');
    const dead = await flow.advanceRun(actorA, rejectedRun.runId);
    expect(dead.state).toBe('dead_letter');
  });

  it('refuses to decide an approval for a run that is not awaiting one', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'not-gated', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    await expect(flow.decideApproval(actorA, started.runId, 'approve', '')).rejects.toThrow('FLOW_RUN_NOT_AWAITING_APPROVAL');
  });

  it('persists a host-supplied scheduledFor verbatim instead of inventing one from createdAt', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'scheduled', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const scheduledFor = '2026-03-01T09:00:00.000Z';
    const started = await flow.triggerRun(actorA, workflow.id, 'schedule', { scheduledFor });
    expect(started.detail).toMatchObject({ scheduledFor });
    expect(started.detail.scheduledFor).not.toBe(started.createdAt);
  });

  it('refuses a scheduled trigger with no scheduledFor, and with a malformed one', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'scheduled-fail-closed', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    await expect(flow.triggerRun(actorA, workflow.id, 'schedule')).rejects.toThrow('FLOW_SCHEDULED_RUN_REQUIRES_SCHEDULED_FOR');
    await expect(flow.triggerRun(actorA, workflow.id, 'schedule', { scheduledFor: 'not-a-date' })).rejects.toThrow('FLOW_SCHEDULED_RUN_REQUIRES_SCHEDULED_FOR');
    await expect(flow.triggerRun(actorA, workflow.id, 'schedule', { scheduledFor: '2026-03-01' })).rejects.toThrow('FLOW_SCHEDULED_RUN_REQUIRES_SCHEDULED_FOR');
  });

  it('never requires or persists scheduledFor for a manual trigger, even if one is passed', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'manual-ignores-scheduled-for', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual', { scheduledFor: '2026-03-01T09:00:00.000Z' });
    expect(started.detail.scheduledFor).toBeUndefined();
  });
});

describe('FLOW concurrent step claims', () => {
  it('lets only one caller claim a given (run, step, attempt); the loser is rejected', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-exclusive', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const winner = await flow.claimStep(actorA, started.runId);
    expect(winner.context).toMatchObject({
      tenantId: tenantA,
      workspaceId: workspaceA,
      principalId: actorIdA,
      workflowId: workflow.id,
      runId: started.runId,
      trigger: 'manual',
      stepId: 'only',
      stepIndex: 0,
      attempt: 0,
      dispatchId: `${started.runId}:0:0`,
    });
    await expect(flow.claimStep(actorA, started.runId)).rejects.toThrow('FLOW_STEP_ALREADY_CLAIMED');
  });

  it('derives every context field server-side, never from the step\'s own input', async () => {
    const workflow = await flow.createWorkflow(actorA, {
      name: 'claim-context-integrity',
      steps: [{ id: 'handoff', handler: 'noop', input: { workflowId: 'attacker-supplied', runId: 'attacker-supplied', dispatchId: 'attacker-supplied' } }],
      maxAttempts: 3,
      maxConcurrentRuns: 1,
    });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const claim = await flow.claimStep(actorA, started.runId);
    expect(claim.context.workflowId).toBe(workflow.id);
    expect(claim.context.runId).toBe(started.runId);
    expect(claim.context.dispatchId).toBe(`${started.runId}:0:0`);
  });

  it('completes the step and releases the claim through advanceClaimedRun', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-advance', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const claim = await flow.claimStep(actorA, started.runId);
    const completed = await flow.advanceClaimedRun(actorA, started.runId, claim.claimToken);
    expect(completed.state).toBe('succeeded');
    const released = await scoped.query<{ released_at: string | null }>(
      { tenantId: tenantA, workspaceId: workspaceA },
      'SELECT released_at FROM flow_step_claims WHERE run_id = $1 AND step_index = 0 AND attempt = 0',
      [started.runId],
    );
    expect(released.rows[0]?.released_at).not.toBeNull();
  });

  it('refuses advanceClaimedRun with a wrong or already-released claim token', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-wrong-token', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const claim = await flow.claimStep(actorA, started.runId);
    await expect(flow.advanceClaimedRun(actorA, started.runId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow('FLOW_CLAIM_INVALID_OR_EXPIRED');
    await flow.advanceClaimedRun(actorA, started.runId, claim.claimToken);
    // The run is now 'succeeded' (single-step workflow), so re-using the same token fails on run state first.
    await expect(flow.advanceClaimedRun(actorA, started.runId, claim.claimToken)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
  });

  it('recovers an expired lease idempotently: a second claimant can take over, and the stale claimant cannot write', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-lease-recovery', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    const staleClaim = await flow.claimStep(actorA, started.runId, 1);
    // Force the lease into the past instead of waiting out a real 1ms window.
    await scoped.query(
      { tenantId: tenantA, workspaceId: workspaceA },
      `UPDATE flow_step_claims SET lease_expires_at = $1 WHERE run_id = $2 AND step_index = 0 AND attempt = 0`,
      [new Date(Date.now() - 1000).toISOString(), started.runId],
    );
    const recoveredClaim = await flow.claimStep(actorA, started.runId);
    expect(recoveredClaim.claimToken).not.toBe(staleClaim.claimToken);
    await expect(flow.advanceClaimedRun(actorA, started.runId, staleClaim.claimToken)).rejects.toThrow('FLOW_CLAIM_INVALID_OR_EXPIRED');
    const completed = await flow.advanceClaimedRun(actorA, started.runId, recoveredClaim.claimToken);
    expect(completed.state).toBe('succeeded');
    // Exactly one checkpoint was ever written for this (run, step, attempt) despite two claimants.
    const checkpoints = await scoped.query(
      { tenantId: tenantA, workspaceId: workspaceA },
      'SELECT id FROM flow_checkpoints WHERE run_id = $1 AND step_index = 0 AND attempt = 0',
      [started.runId],
    );
    expect(checkpoints.rows).toHaveLength(1);
  });

  it('refuses to claim a run that is not running', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-not-running', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 1 });
    const started = await flow.triggerRun(actorA, workflow.id, 'manual');
    await flow.cancelRun(actorA, started.runId);
    await expect(flow.claimStep(actorA, started.runId)).rejects.toThrow('FLOW_RUN_NOT_RUNNING');
  });

  it('carries the run\'s persisted scheduledFor into a scheduled claim\'s context, and null for a manual one', async () => {
    const workflow = await flow.createWorkflow(actorA, { name: 'claim-schedule-context', steps: [{ id: 'only', handler: 'noop', input: {} }], maxAttempts: 3, maxConcurrentRuns: 2 });
    const scheduledFor = '2026-03-01T09:00:00.000Z';
    const scheduledRun = await flow.triggerRun(actorA, workflow.id, 'schedule', { scheduledFor });
    const scheduledClaim = await flow.claimStep(actorA, scheduledRun.runId);
    expect(scheduledClaim.context.scheduledFor).toBe(scheduledFor);

    const manualRun = await flow.triggerRun(actorA, workflow.id, 'manual');
    const manualClaim = await flow.claimStep(actorA, manualRun.runId);
    expect(manualClaim.context.scheduledFor).toBeNull();
  });
});

describe('FLOW missed-job policy', () => {
  it('always skips a missed firing under the skip policy', async () => {
    const { decideMissedJobAction } = await import('./missed-job');
    const scheduledAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T01:00:00Z');
    expect(decideMissedJobAction('skip', scheduledAt, null, now)).toBe('skip');
    expect(decideMissedJobAction('skip', scheduledAt, new Date('2025-12-31T00:00:00Z'), now)).toBe('skip');
  });

  it('catches up exactly once under run-once, then skips the same window on a second check', async () => {
    const { decideMissedJobAction } = await import('./missed-job');
    const scheduledAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T01:00:00Z');
    expect(decideMissedJobAction('run-once', scheduledAt, null, now)).toBe('run');
    expect(decideMissedJobAction('run-once', scheduledAt, scheduledAt, now)).toBe('skip');
    expect(decideMissedJobAction('run-once', scheduledAt, new Date('2026-01-01T00:30:00Z'), now)).toBe('skip');
  });

  it('refuses to decide for a firing that is not yet due', async () => {
    const { decideMissedJobAction } = await import('./missed-job');
    const scheduledAt = new Date('2026-01-02T00:00:00Z');
    const now = new Date('2026-01-01T00:00:00Z');
    expect(() => decideMissedJobAction('skip', scheduledAt, null, now)).toThrow('FLOW_SCHEDULE_NOT_YET_DUE');
  });
});
