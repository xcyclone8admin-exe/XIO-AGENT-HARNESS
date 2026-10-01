import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
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
});
