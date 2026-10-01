import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashApprovalInput, hashApprovalScope, type Principal } from '@xyra/contracts';
import { uuidv7 } from '@xyra/core';
import { AgentRunner, ModelRouter, ProviderRegistry, type PreparedAgentRunResult, type PreparedReviewBinding } from '@xyra/agent-core';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { GUARDED_PROFILE_FIELDS } from '../contracts';
import { SwarmProfileService } from './profile-service';
import { SwarmKillSwitchService, SwarmRunQueueService, type SwarmTrustedCallContext } from './runtime-service';
import { makeSwarmServer, type SwarmCapabilityExecutionContext } from './index';

type Db = Awaited<ReturnType<typeof openLocalStore>>;

const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actor = '019a0000-0000-7000-8000-000000000021';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };

let db: Db;
let scoped: LocalScopedStore;
let profiles: SwarmProfileService;
let queue: SwarmRunQueueService;
let killSwitch: SwarmKillSwitchService;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')));
}

const draft = {
  roleId: 'OPERATIONS',
  charter: 'Report task facts.',
  defaultProvider: 'primary',
  defaultModel: 'fast',
  fallbacks: [],
  budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxActions: 3, maxFailures: 3, maxIterations: 3 },
  memoryScope: { tenant: false, workspace: true, project: false, run: true },
  outputSchema: { type: 'object' },
};

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('swarm', '../migrations/')]);
  // Manifest-derived grants (ADR-0016): fails if any declared table is missing (SWM-R-014).
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  scoped = new LocalScopedStore(db);
  profiles = new SwarmProfileService(scoped);
  queue = new SwarmRunQueueService(scoped, { maxPendingPerWorkspace: 20, maxQueuedPayloadBytes: 100_000, maxResultPayloadBytes: 200_000, maxRunDurationMs: 120_000 });
  killSwitch = new SwarmKillSwitchService(scoped);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('swarm schema', () => {
  it('creates every table the manifest declares (SWM-R-014)', async () => {
    const found = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const names = new Set(found.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !names.has(name))).toEqual([]);
  });

  it('isolates the local Night Shift row per workspace', async () => {
    await scoped.query(scopeA, 'INSERT INTO swarm_night_shift(tenant_id,workspace_id,max_runs,max_spend_usd) VALUES ($1,$2,1,1)', [tenantA, workspaceA]);
    expect((await scoped.query(scopeB, 'SELECT workspace_id FROM swarm_night_shift')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT workspace_id FROM swarm_night_shift')).rows).toHaveLength(1);
  });

  it('rejects autonomy 5 and a null output_schema even for the owner (SWM-R-011/012)', async () => {
    const insert = (autonomy: number, outputSchema: string | null) =>
      db.query(
        `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,budgets,
           memory_scope,output_schema,autonomy_level,created_by)
         VALUES (gen_random_uuid(),$1,$2,'r','c','p','m','{}','{}',$3,$4,$5)`,
        [tenantA, workspaceA, outputSchema, autonomy, actor],
      );
    await expect(insert(5, '{}')).rejects.toThrow(/autonomy_level/);
    await expect(insert(1, null)).rejects.toThrow(/output_schema/);
  });
});

describe('guarded profile columns (SWM-R-002/003)', () => {
  it('creates profiles with fail-closed privileges and rejects every guarded field', async () => {
    const created = await profiles.create(scopeA, actor, draft);
    expect(created).toMatchObject({
      capabilityGrants: [],
      autonomyLevel: 0,
      secretScopes: [],
      networkPolicy: { mode: 'none', allowedHosts: [] },
      filesystemPolicy: { mode: 'none', allowedPaths: [] },
      approvalPolicy: 'default.consequential',
      evalHistory: [],
    });
    for (const field of GUARDED_PROFILE_FIELDS) {
      await expect(profiles.create(scopeA, actor, { ...draft, [field]: [] })).rejects.toThrow(`GUARDED_PROFILE_FIELD:${field}`);
      await expect(profiles.update(scopeA, created.id, { ...draft, [field]: 4 })).rejects.toThrow(`GUARDED_PROFILE_FIELD:${field}`);
    }
    await expect(profiles.create(scopeA, actor, { ...draft, unknownField: true })).rejects.toThrow();
    expect(await profiles.update(scopeA, created.id, { ...draft, charter: 'Updated.' })).toMatchObject({ charter: 'Updated.' });
  });

  it('derives eval history from swarm_model_evals instead of trusting a stored value', async () => {
    await scoped.query(
      scopeA,
      `INSERT INTO swarm_model_evals(id,tenant_id,workspace_id,provider,model_id,eval_id,metrics,ran_at,created_by)
       VALUES (gen_random_uuid(),$1,$2,'primary','fast','golden-1',$3,now(),$4)`,
      [tenantA, workspaceA, JSON.stringify({ taskCompletion: 0.9, toolSuccess: 1, schemaSuccess: 1, hallucinationRate: 0, fallbackRate: 0.1 }), actor],
    );
    const [profile] = await profiles.list(scopeA);
    expect(profile?.evalHistory).toEqual([expect.objectContaining({ evalId: 'golden-1', modelId: 'fast', score: 0.9, fallbackRate: 0.1 })]);
  });

  it('blocks the app role from writing guarded columns directly, bypassing the service', async () => {
    const created = await profiles.create(scopeA, actor, draft);
    const writes: Record<string, string> = {
      capability_grants: `'["core.admin"]'`,
      autonomy_level: '4',
      secret_scopes: `'["vault:*"]'`,
      network_policy: `'{"mode":"allow-list","allowedHosts":["*"]}'`,
      filesystem_policy: `'{"mode":"leased-worktree","allowedPaths":["/"]}'`,
      approval_policy: `'never'`,
      eval_history: `'[{"evalId":"forged"}]'`,
    };
    expect(Object.keys(writes)).toHaveLength(GUARDED_PROFILE_FIELDS.length);
    for (const [column, value] of Object.entries(writes)) {
      await expect(scoped.query(scopeA, `UPDATE swarm_agent_profiles SET ${column}=${value} WHERE id=$1`, [created.id])).rejects.toThrow(
        /guarded column|permission denied/,
      );
      await expect(
        scoped.query(
          scopeA,
          `INSERT INTO swarm_agent_profiles(id,tenant_id,workspace_id,role_id,charter,default_provider,default_model,budgets,
             memory_scope,output_schema,created_by,${column})
           VALUES (gen_random_uuid(),$1,$2,'r','c','p','m','{}','{}','{}',$3,${value})`,
          [tenantA, workspaceA, actor],
        ),
      ).rejects.toThrow(/guarded column/);
    }
  });
});

describe('append-only run records', () => {
  it('rejects UPDATE and DELETE of prompt versions; retirement appends (SWM-R-010)', async () => {
    const insert = (version: number, retired: boolean) =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_prompt_versions(id,tenant_id,workspace_id,prompt_id,version,purpose,template,retired_at,created_by)
         VALUES (gen_random_uuid(),$1,$2,'charter',$3,'p','t',${retired ? 'now()' : 'NULL'},$4)`,
        [tenantA, workspaceA, version, actor],
      );
    await insert(1, false);
    await expect(scoped.query(scopeA, "UPDATE swarm_prompt_versions SET retired_at=now() WHERE prompt_id='charter'")).rejects.toThrow();
    await expect(db.query("UPDATE swarm_prompt_versions SET retired_at=now() WHERE prompt_id='charter'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM swarm_prompt_versions WHERE prompt_id='charter'")).rejects.toThrow(/append-only/);
    await insert(2, true);
    await expect(insert(2, false)).rejects.toThrow();
  });

  it('journals a running run before its outcome and enforces the parent-run FK (probes e/f)', async () => {
    const profile = await profiles.create(scopeA, actor, draft);
    const start = (id: string, parent: string | null) =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,parent_run_id,budgets,started_at,created_by)
         VALUES ($1,$2,$3,$4,$5,'{}',now(),$6)`,
        [id, tenantA, workspaceA, profile.id, parent, actor],
      );
    const parent = '019a0000-0000-7000-8000-000000000301';
    const child = '019a0000-0000-7000-8000-000000000302';
    await expect(start(child, '019a0000-0000-7000-8000-000000000399')).rejects.toThrow(/swarm_runs_parent_fk/);
    await start(parent, null);
    await start(child, parent);
    await scoped.query(
      scopeA,
      `INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,occurred_at,created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,0,'run.started',now(),$4)`,
      [tenantA, workspaceA, parent, actor],
    );
    const outcome = () =>
      scoped.query(
        scopeA,
        `INSERT INTO swarm_run_outcomes(id,tenant_id,workspace_id,run_id,termination,iterations,actions,failures,cost_usd,ended_at,created_by)
         VALUES (gen_random_uuid(),$1,$2,$3,'COMPLETED',1,0,0,0,now(),$4)`,
        [tenantA, workspaceA, parent, actor],
      );
    await outcome();
    await expect(outcome()).rejects.toThrow();
    await expect(scoped.query(scopeA, "UPDATE swarm_run_outcomes SET termination='FAILED' WHERE run_id=$1", [parent])).rejects.toThrow();
  });
});

async function approvalFor(capabilityId: string, input: unknown, proofOverrides: Record<string, unknown> = {}) {
  const proof = {
    version: 1 as const,
    approvalId: uuidv7(),
    decisionId: uuidv7(),
    tenantId: tenantA,
    workspaceId: workspaceA,
    principalId: actor,
    requestedBy: actor,
    approverId: '019a0000-0000-7000-8000-000000000022',
    capabilityId,
    inputDigest: await hashApprovalInput(input),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...proofOverrides,
  };
  const { scopeHash: _ignored, ...binding } = proof as typeof proof & { scopeHash?: string };
  return { ...binding, scopeHash: await hashApprovalScope(binding) };
}

async function prepareApprovedRun(prompt: string, runId = uuidv7(), reviewBinding?: PreparedReviewBinding) {
  const [profile] = await profiles.list(scopeA);
  if (!profile) throw new Error('SWARM_TEST_PROFILE_REQUIRED');
  const approvedInput = {
    runId,
    profileId: profile.id,
    prompt,
    ...(reviewBinding ? { review: { councilId: reviewBinding.councilId, assignmentId: reviewBinding.assignmentId, role: reviewBinding.role } } : {}),
  };
  const verifiedApproval = await approvalFor('swarm.runs.enqueue', approvedInput);
  const principal: Principal = { kind: 'user', id: actor, tenantId: tenantA, workspaces: [{ id: workspaceA, role: 'owner', kind: 'standard' }], grants: [] };
  const runner = new AgentRunner({ router: new ModelRouter(new ProviderRegistry()), capabilities: [], capabilityCaller: { call: async () => null } });
  return runner.prepare({
    runId, workspaceId: workspaceA, principal, verifiedApproval, approvedInput,
    profile, prompt,
    spawn: {
      charter: profile.charter, stageProtocol: 'swarm-v1', contextManifest: {}, memoryScope: profile.memoryScope,
      capabilityGrants: [], approvals: [], budgets: profile.budgets, outputContract: profile.outputSchema,
      evidenceContract: { required: true, artifactTypes: ['review'] }, delegation: { depth: 0, maxDepth: 0 },
    },
    route: { preferred: { provider: profile.defaultProvider, model: profile.defaultModel }, fallbacks: [], requiredCapabilities: ['text'], qualityFloor: 'standard', privacyCeiling: 'local' },
    ...(reviewBinding ? { reviewBinding } : {}),
  });
}

function trustedContext(capabilityId: string, approval: Awaited<ReturnType<typeof approvalFor>> | null): SwarmTrustedCallContext {
  const principal: Principal = { kind: 'user', id: actor, tenantId: tenantA, workspaces: [{ id: workspaceA, role: 'owner', kind: 'standard' }], grants: [] };
  return { principal, actorId: actor, tenantId: tenantA, workspaceId: workspaceA, capabilityId, permission: capabilityId === 'swarm.runs.cancel' ? 'swarm:run:cancel' : 'swarm:kill-switch:manage', approval };
}

describe('durable SWARM admission and workspace kill switch', () => {
  it('registers safe capabilities with trusted execution context and exposes host services', async () => {
    const server = makeSwarmServer(scoped, { maxPendingPerWorkspace: 20, maxQueuedPayloadBytes: 100_000, maxResultPayloadBytes: 200_000, maxRunDurationMs: 120_000 });
    expect(server.queueService).toBeInstanceOf(SwarmRunQueueService);
    expect(server.killSwitchReader).toBe(server.killSwitchService);
    const handlers = new Map<string, (input: unknown, call: { principal: Principal; workspaceId: string; capabilityId: string }, context: SwarmCapabilityExecutionContext) => Promise<unknown>>();
    const bus = { register: (_manifest: unknown, descriptor: { id: string }, handler: (input: unknown, call: { principal: Principal; workspaceId: string; capabilityId: string }, context: SwarmCapabilityExecutionContext) => Promise<unknown>) => handlers.set(descriptor.id, handler) };
    server.register(bus as never, manifest);

    const principal: Principal = { kind: 'user', id: actor, tenantId: tenantA, workspaces: [{ id: workspaceA, role: 'owner', kind: 'standard' }], grants: [] };
    const input = { engaged: true, reason: 'Registrar integration check.' };
    const setContext: SwarmCapabilityExecutionContext = {
      principal, actorId: actor, tenantId: tenantA, workspaceId: workspaceA,
      capabilityId: 'swarm.kill-switch.set', permission: 'swarm:kill-switch:manage', approval: await approvalFor('swarm.kill-switch.set', input),
    };
    const call = { principal, workspaceId: workspaceA, capabilityId: 'swarm.kill-switch.set' };
    const set = handlers.get('swarm.kill-switch.set');
    expect(set).toBeDefined();
    const forgedInput = { ...input, approval: await approvalFor('swarm.kill-switch.set', input) };
    expect(() => set?.(forgedInput, call, setContext)).toThrow();
    await expect(set?.(input, call, { ...setContext, approval: null })).rejects.toThrow('SWARM_KILL_SWITCH_APPROVAL_REQUIRED');
    await expect(set?.(input, call, setContext)).resolves.toMatchObject({ engaged: true, reason: input.reason, changedBy: actor });

    const read = handlers.get('swarm.kill-switch.read');
    const readContext = { ...setContext, capabilityId: 'swarm.kill-switch.read', permission: 'swarm:kill-switch:read', approval: null };
    await expect(read?.({}, { ...call, capabilityId: readContext.capabilityId }, readContext)).resolves.toMatchObject({ engaged: true });
    const list = handlers.get('swarm.runs.queue');
    await expect(list?.({ limit: 5 }, { ...call, capabilityId: 'swarm.runs.queue' }, { ...readContext, capabilityId: 'swarm.runs.queue' })).resolves.toEqual([]);
    expect(handlers.has('swarm.runs.enqueue')).toBe(false);
    const releaseInput = { engaged: false, reason: null };
    await expect(set?.(releaseInput, call, { ...setContext, approval: await approvalFor('swarm.kill-switch.set', releaseInput) })).resolves.toMatchObject({ engaged: false });
  });

  it('commits queue row and immutable event atomically, enforces approval digest and idempotency', async () => {
    const prepared = await prepareApprovedRun('Review the exact commit and linked artifacts.');
    const admitted = await queue.enqueue(prepared, 'run-admission-1');
    expect(admitted).toMatchObject({ accepted: true, runId: prepared.input.runId, state: 'queued', reason: null });
    await expect(queue.enqueue(prepared, 'run-admission-1')).resolves.toEqual(admitted);
    const changed = await prepareApprovedRun('A different approved prompt.');
    await expect(queue.enqueue(changed, 'run-admission-1')).rejects.toThrow('SWARM_QUEUE_IDEMPOTENCY_KEY_REUSED');

    const rows = await scoped.query(scopeA, 'SELECT state,payload,approval_id FROM swarm_run_queue WHERE id=$1', [prepared.input.runId]);
    expect(rows.rows[0]).toMatchObject({ state: 'queued', approval_id: prepared.authority.verifiedApproval?.approvalId });
    expect(rows.rows[0]?.payload).toMatchObject({ prompt: 'Review the exact commit and linked artifacts.' });
    const events = await scoped.query(scopeA, 'SELECT event_type,to_state FROM swarm_run_queue_events WHERE run_id=$1', [prepared.input.runId]);
    expect(events.rows).toEqual([{ event_type: 'queued', to_state: 'queued' }]);

    const approvedInput = prepared.authority.approvedInput;
    if (!approvedInput) throw new Error('SWARM_TEST_APPROVED_INPUT_REQUIRED');
    const badProof = await approvalFor('swarm.runs.enqueue', approvedInput, { inputDigest: '0'.repeat(64) });
    const runner = new AgentRunner({ router: new ModelRouter(new ProviderRegistry()), capabilities: [], capabilityCaller: { call: async () => null } });
    const forged = runner.prepare({ ...prepared.input, verifiedApproval: badProof, approvedInput });
    await expect(queue.enqueue(forged, 'run-admission-forged')).rejects.toThrow('SWARM_APPROVAL_BINDING_INVALID');
    await expect(queue.claimNext(scopeA, 'worker')).resolves.toEqual({ claimed: false, reason: 'execution_disabled_until_c1' });
  });

  it('persists the immutable council assignment and subject binding with the admitted run', async () => {
    const binding: PreparedReviewBinding = {
      councilId: uuidv7(), assignmentId: uuidv7(), targetId: uuidv7(), repositoryId: 'institutional-agent-os/repo',
      reviewContractId: 'forge-council-review-v1', reviewContractSha256: 'e'.repeat(64),
      role: 'ADVERSARY', reviewerPrincipalId: actor, subjectCommitSha: 'c'.repeat(40),
      artifacts: [{ id: uuidv7(), sha256: 'd'.repeat(64) }],
    };
    const prepared = await prepareApprovedRun('Review only the bound immutable inputs.', uuidv7(), binding);
    await expect(queue.enqueue(prepared, 'forge-review-run-1')).resolves.toMatchObject({ accepted: true, state: 'queued' });
    const persisted = await scoped.query<{ payload: unknown } & Record<string, unknown>>(
      scopeA, 'SELECT payload FROM swarm_run_queue WHERE id=$1', [prepared.input.runId]);
    expect(persisted.rows[0]?.payload).toMatchObject({ reviewBinding: binding });
  });

  it('cancels queued runs and terminally recovers expired worker claims with fencing', async () => {
    const prepared = await prepareApprovedRun('Cancel this queued run.');
    await queue.enqueue(prepared, 'run-cancel-queued');
    await expect(queue.cancel(trustedContext('swarm.runs.cancel', null), prepared.input.runId)).resolves.toEqual({ accepted: true });
    await expect(queue.isCancellationRequested(scopeA, prepared.input.runId)).resolves.toBe(false);
    await expect(queue.list(scopeA)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ runId: prepared.input.runId, state: 'canceled', errorCode: 'CANCELED_BY_CALLER' })]));

    const stranded = await prepareApprovedRun('A worker crashed while running this.');
    await queue.enqueue(stranded, 'run-expired-claim');
    const staleToken = uuidv7();
    await db.query("UPDATE swarm_run_queue SET state='running',claim_token=$2,claimed_by='crashed-worker',claim_expires_at=now()-interval '1 second',started_at=now() WHERE id=$1", [stranded.input.runId, staleToken]);
    await db.query('INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,parent_run_id,budgets,started_at,created_by) VALUES($1,$2,$3,$4,NULL,$5::jsonb,now(),$6)',
      [stranded.input.runId, tenantA, workspaceA, stranded.input.profile.id, JSON.stringify(stranded.input.profile.budgets), actor]);
    await db.query("INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,detail,occurred_at,created_by) VALUES($1,$2,$3,$4,0,'run.started','{}',now(),$5)",
      [uuidv7(), tenantA, workspaceA, stranded.input.runId, actor]);
    await expect(queue.recoverExpiredClaims(scopeA)).resolves.toBe(1);
    const recovered = await scoped.query(scopeA, 'SELECT state,error_code,claim_token FROM swarm_run_queue WHERE id=$1', [stranded.input.runId]);
    expect(recovered.rows[0]).toEqual({ state: 'failed', error_code: 'WORKER_LEASE_EXPIRED', claim_token: null });
    await expect(db.query("UPDATE swarm_run_queue SET state='completed' WHERE id=$1 AND claim_token=$2", [stranded.input.runId, staleToken])).resolves.toMatchObject({ affectedRows: 0 });
    const outcome = await scoped.query(scopeA, 'SELECT termination FROM swarm_run_outcomes WHERE run_id=$1', [stranded.input.runId]);
    expect(outcome.rows).toEqual([{ termination: 'FAILED' }]);
  });

  it('runs only a prepared model review, journals the result, fences completion, and delivers to an idempotent sink', async () => {
    const binding: PreparedReviewBinding = {
      councilId: uuidv7(), assignmentId: uuidv7(), targetId: uuidv7(), repositoryId: 'institutional-agent-os/repo',
      reviewContractId: 'forge-council-review-v1', reviewContractSha256: 'e'.repeat(64),
      role: 'ADVERSARY', reviewerPrincipalId: actor, subjectCommitSha: 'f'.repeat(40),
      artifacts: [{ id: uuidv7(), sha256: 'a'.repeat(64) }],
    };
    const prepared = await prepareApprovedRun('Inspect the supplied immutable review context.', uuidv7(), binding);
    const registry = new ProviderRegistry();
    let providerCalls = 0;
    registry.registerProvider({ id: 'primary', complete: async (_request) => {
      providerCalls += 1;
      return providerCalls === 1
        ? { output: '', toolCalls: [{ id: 'forbidden-write', capabilityId: 'forge.findings.create', input: {} }], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, finishReason: 'tool_calls' }
        : { output: 'Review output; Forge must validate before disposition.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, finishReason: 'complete' };
    } });
    registry.registerModel({ id: 'fast', provider: 'primary', aliases: [], capabilities: ['text'], contextWindow: 1000, qualityTier: 'standard', latencyTier: 'fast', costTier: 'low', privacyTier: 'local', status: 'available' });
    let capabilityCalls = 0;
    const runner = new AgentRunner({ router: new ModelRouter(registry), capabilities: [], capabilityCaller: { call: async () => { capabilityCalls += 1; return null; } } });
    let sinkCalls = 0;
    const sink = { persist: async (result: PreparedAgentRunResult) => {
      sinkCalls += 1;
      expect(result.authority.reviewBinding).toEqual(binding);
      expect(result.outputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.artifactDigests).toEqual(expect.arrayContaining([{ id: `${result.runId}:output`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]));
      expect(result.result.events.some((event) => event.type === 'run.tool.denied')).toBe(true);
      return { evidenceIds: [uuidv7()] };
    } };

    const execution = await queue.executePreparedReview(prepared, 'forge-review-execute-1', runner, 'review-worker-1', sink);
    expect(execution).toMatchObject({ admission: { accepted: true, state: 'completed' }, result: { runId: prepared.input.runId, result: { termination: 'COMPLETED' } }, resultDelivery: { delivered: true } });
    expect(providerCalls).toBe(2);
    expect(capabilityCalls).toBe(0);
    expect(sinkCalls).toBe(1);
    const started = await scoped.query(scopeA, 'SELECT profile_id FROM swarm_runs WHERE id=$1', [prepared.input.runId]);
    expect(started.rows).toHaveLength(1);
    const journal = await scoped.query(scopeA, 'SELECT seq,event_type FROM swarm_run_journal WHERE run_id=$1 ORDER BY seq', [prepared.input.runId]);
    expect(journal.rows[0]).toEqual({ seq: 0, event_type: 'run.started' });
    expect(journal.rows.at(-1)?.event_type).toBe('run.terminated');
    const outcome = await scoped.query(scopeA, 'SELECT termination,output FROM swarm_run_outcomes WHERE run_id=$1', [prepared.input.runId]);
    expect(outcome.rows[0]).toMatchObject({ termination: 'COMPLETED', output: 'Review output; Forge must validate before disposition.' });
    await expect(queue.deliverPendingReviewResult(scopeA, prepared.input.runId, sink)).resolves.toEqual({ delivered: true, evidenceIds: expect.any(Array) });
    expect(sinkCalls).toBe(1);
  });

  it('persists kill-switch state/events, refuses pending runs, and rejects unauthorized mutation', async () => {
    const prepared = await prepareApprovedRun('Queue this before engaging the switch.');
    await expect(queue.enqueue(prepared, 'run-before-kill')).resolves.toMatchObject({ accepted: true, state: 'queued' });
    await expect(killSwitch.getKillSwitch(scopeA)).resolves.toMatchObject({ engaged: false, reason: null, changedBy: actor, changedAt: expect.any(String) });

    const input = { engaged: true, reason: 'Operator halt for review.' };
    const approval = await approvalFor('swarm.kill-switch.set', input);
    const context = trustedContext('swarm.kill-switch.set', approval);
    await expect(killSwitch.setKillSwitch({ ...context, capabilityId: 'swarm.runs.cancel' }, true, input.reason)).rejects.toThrow('SWARM_TRUSTED_CAPABILITY_CONTEXT_REQUIRED');
    await expect(killSwitch.setKillSwitch(context, true, input.reason)).resolves.toMatchObject({ engaged: true, reason: input.reason, changedBy: actor });
    await expect(queue.enqueue(await prepareApprovedRun('This must be refused.'), 'run-during-kill')).resolves.toMatchObject({ accepted: false, reason: 'kill_switch_engaged' });
    await expect(queue.list(scopeA)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ runId: prepared.input.runId, state: 'refused', errorCode: 'KILL_SWITCH_ENGAGED' })]));
    const events = await scoped.query(scopeA, 'SELECT event_type,from_state,to_state FROM swarm_run_queue_events WHERE run_id=$1 ORDER BY created_at,id', [prepared.input.runId]);
    expect(events.rows).toEqual([{ event_type: 'queued', from_state: null, to_state: 'queued' }, { event_type: 'refused', from_state: 'queued', to_state: 'refused' }]);
    const killEvents = await scoped.query(scopeA, 'SELECT engaged,reason,changed_by FROM swarm_kill_switch_events WHERE workspace_id=$1', [workspaceA]);
    expect(killEvents.rows).toContainEqual({ engaged: true, reason: input.reason, changed_by: actor });
    await expect(db.query("UPDATE swarm_kill_switch_events SET reason='tampered' WHERE workspace_id=$1", [workspaceA])).rejects.toThrow(/append-only/);
  });

  it('requires an approval proof whose digest matches the exact kill-switch request', async () => {
    const input = { engaged: false, reason: null };
    const wrongApproval = await approvalFor('swarm.kill-switch.set', { engaged: true, reason: 'different request' });
    await expect(killSwitch.setKillSwitch(trustedContext('swarm.kill-switch.set', wrongApproval), false, input.reason)).rejects.toThrow('SWARM_APPROVAL_BINDING_INVALID');
  });
});
