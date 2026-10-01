import { defineCapability, type Principal } from '@xyra/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_PROFILE_REQUIRED_FIELDS,
  BUILT_IN_AGENT_ROLES,
  AgentProfile,
  AgentRunner,
  BoundedRunLoop,
  InMemoryRunJournal,
  LocalKillSwitch,
  LocalOnlyLeasePort,
  McpClientBoundary,
  ModelRouter,
  NightShiftController,
  PromptRegistry,
  ProviderError,
  ProviderRegistry,
  RunConcurrencyGate,
  TierZeroToolExecutor,
  compileSpawnContract,
  createReviewerAssignment,
  decideRunAccess,
  decideDelegation,
  regressionReasons,
  resolveRuntimeConfiguration,
  type AgentProfile as AgentProfileType,
  type AgentRunInput,
  type AiProvider,
  type ModelDescriptor,
  type ProviderResponse,
  type RouteRequest,
} from './index';

const IDS = {
  tenant: '019a0000-0000-7000-8000-000000000001',
  workspace: '019a0000-0000-7000-8000-000000000002',
  user: '019a0000-0000-7000-8000-000000000003',
  agent: '019a0000-0000-7000-8000-000000000004',
  profile: '019a0000-0000-7000-8000-000000000005',
  run: '019a0000-0000-7000-8000-000000000006',
} as const;

const principal: Principal = {
  kind: 'agent',
  id: IDS.agent,
  tenantId: IDS.tenant,
  workspaces: [{ id: IDS.workspace, role: 'owner', kind: 'standard' }],
  grants: ['ops:task:read'],
  delegatedBy: IDS.user,
  runId: IDS.run,
  autonomy: 2,
};

function profile(overrides: Partial<AgentProfileType> = {}): AgentProfileType {
  return AgentProfile.parse({
    id: IDS.profile,
    roleId: 'OPERATIONS',
    charter: 'Read the current task state and report facts.',
    defaultProvider: 'primary',
    defaultModel: 'fast',
    fallbacks: [{ provider: 'fallback', model: 'reliable' }],
    capabilityGrants: ['ops.tasks.list'],
    secretScopes: [],
    networkPolicy: { mode: 'none', allowedHosts: [] },
    filesystemPolicy: { mode: 'none', allowedPaths: [] },
    budgets: { maxDurationMs: 60_000, maxCostUsd: 10, maxActions: 3, maxFailures: 3, maxIterations: 3 },
    approvalPolicy: 'swarm.default',
    memoryScope: { tenant: false, workspace: true, project: false, run: true },
    outputSchema: { type: 'object' },
    autonomyLevel: 2,
    evalHistory: [],
    ...overrides,
  });
}

const model = (provider: string, id: string): ModelDescriptor => ({
  id,
  provider,
  aliases: [],
  capabilities: ['text', 'tools'],
  contextWindow: 10_000,
  qualityTier: 'standard',
  latencyTier: 'fast',
  costTier: 'low',
  privacyTier: 'local',
  status: 'available',
});

function response(toolCalls: ProviderResponse['toolCalls'] = []): ProviderResponse {
  return { output: 'done', toolCalls, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, finishReason: toolCalls.length ? 'tool_calls' : 'complete' };
}

function provider(id: string, complete: AiProvider['complete']): AiProvider {
  return { id, complete };
}

function routerWith(providers: readonly AiProvider[]): ModelRouter {
  const registry = new ProviderRegistry();
  for (const item of providers) registry.registerProvider(item);
  registry.registerModel(model('primary', 'fast'));
  registry.registerModel(model('fallback', 'reliable'));
  return new ModelRouter(registry);
}

const listTasks = defineCapability({
  id: 'ops.tasks.list',
  title: 'List tasks',
  description: 'List current tasks',
  kind: 'read',
  permission: 'ops:task:read',
  input: z.object({}),
  output: z.array(z.string()),
});

function tools(caller: { call: (input: unknown) => Promise<unknown> } = { call: async () => ['task'] }): TierZeroToolExecutor {
  return new TierZeroToolExecutor([listTasks], { call: caller.call });
}

function runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  const activeProfile = profile();
  const route: RouteRequest = {
    preferred: { provider: 'primary', model: 'fast' },
    fallbacks: [{ provider: 'fallback', model: 'reliable' }],
    requiredCapabilities: ['text'],
    qualityFloor: 'standard',
    privacyCeiling: 'local',
  };
  const base: AgentRunInput = {
    runId: IDS.run,
    workspaceId: IDS.workspace,
    principal,
    profile: activeProfile,
    prompt: 'Summarize tasks',
    spawn: compileSpawnContract(
      {
        stageProtocol: 'implement',
        contextManifest: {},
        approvals: [],
        budgets: activeProfile.budgets,
        outputContract: { type: 'text' },
        evidenceContract: { required: true, artifactTypes: ['report'] },
        delegation: { depth: 0, maxDepth: 2 },
      },
      activeProfile,
    ),
    route,
  };
  return { ...base, ...overrides };
}

describe('AgentProfile and delegation contracts', () => {
  it('requires all sixteen fields and exposes all seventeen built-in roles', () => {
    expect(AGENT_PROFILE_REQUIRED_FIELDS).toHaveLength(16);
    expect(Object.keys(AgentProfile.shape).sort()).toEqual([...AGENT_PROFILE_REQUIRED_FIELDS].sort());
    expect(BUILT_IN_AGENT_ROLES).toHaveLength(17);
    expect(BUILT_IN_AGENT_ROLES).toEqual(expect.arrayContaining(['OPERATIONS', 'FINANCE', 'GROWTH']));
  });

  it('compiles all ten spawn-contract items and rejects delegated escalation', () => {
    const parent = profile();
    const spawn = compileSpawnContract(
      {
        stageProtocol: 'review',
        contextManifest: { ticket: 'T-1' },
        approvals: ['approved:1'],
        budgets: parent.budgets,
        outputContract: { type: 'object' },
        evidenceContract: { required: true, artifactTypes: ['test'] },
        delegation: { depth: 1, maxDepth: 2 },
      },
      parent,
    );
    expect(Object.keys(spawn).sort()).toEqual([
      'approvals', 'budgets', 'capabilityGrants', 'charter', 'contextManifest', 'delegation', 'evidenceContract', 'memoryScope', 'outputContract', 'stageProtocol',
    ].sort());
    expect(
      decideDelegation({
        parentProfile: parent,
        childProfile: profile({ autonomyLevel: 3 }),
        parentDepth: 0,
        maximumDepth: 2,
        parentBudget: parent.budgets,
        parentConsumed: { counters: { iterations: 0, actions: 0, failures: 0, costUsd: 0 }, elapsedMs: 0 },
      }),
    ).toEqual({ allowed: false, reason: 'DELEGATION_AUTONOMY_EXCEEDED' });
  });

  it('resolves provider/model/fallback/instruction overrides at every configured precedence level', () => {
    const activeProfile = profile();
    const system = { provider: 'system', model: 'system-model', fallbacks: [], instructions: 'system instruction' };
    const layers = ['workspace', 'project', 'ticket', 'run'] as const;
    for (const layer of layers) {
      const resolved = resolveRuntimeConfiguration({
        system,
        role: activeProfile,
        [layer]: { provider: `${layer}-provider`, model: `${layer}-model`, instructions: `${layer} instruction` },
      });
      expect(resolved.provider).toBe(`${layer}-provider`);
      expect(resolved.model).toBe(`${layer}-model`);
      expect(resolved.instructions).toBe(`${layer} instruction`);
    }
    const resolved = resolveRuntimeConfiguration({
      system,
      role: activeProfile,
      workspace: { provider: 'workspace' },
      project: { provider: 'project' },
      ticket: { provider: 'ticket' },
      run: { provider: 'run' },
    });
    expect(resolved.provider).toBe('run');
  });

  it('fails closed in every per-run permission dimension and isolates reviewers', () => {
    const locked = profile({ capabilityGrants: [], secretScopes: [], networkPolicy: { mode: 'none', allowedHosts: [] }, filesystemPolicy: { mode: 'none', allowedPaths: [] } });
    expect(decideRunAccess(locked, { dimension: 'capability', id: 'ops.tasks.list' })).toMatchObject({ allowed: false });
    expect(decideRunAccess(locked, { dimension: 'secret', id: 'model-api-key' })).toMatchObject({ allowed: false });
    expect(decideRunAccess(locked, { dimension: 'network', host: 'example.test' })).toMatchObject({ allowed: false });
    expect(decideRunAccess(locked, { dimension: 'filesystem', path: 'C:/anywhere' })).toMatchObject({ allowed: false });
    expect(decideRunAccess(locked, { dimension: 'budget', estimatedCostUsd: 2, remainingCostUsd: 1 })).toMatchObject({ allowed: false });
    expect(() => createReviewerAssignment({ authorRunId: IDS.run, authorInstanceId: 'same', reviewerInstanceId: 'same', artifacts: [] })).toThrow(
      'REVIEWER_MUST_DIFFER_FROM_AUTHOR',
    );
  });
});

describe('provider routing and bounded loop', () => {
  it('retries a transient failure twice before selecting a compatible fallback', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const router = routerWith([
      provider('primary', async () => {
        primaryCalls += 1;
        throw new ProviderError('UNAVAILABLE', 'outage', true);
      }),
      provider('fallback', async () => {
        fallbackCalls += 1;
        return response();
      }),
    ]);
    const result = await router.complete(runInput().route, (selected) => ({ runId: IDS.run, model: selected, prompt: 'x', toolResults: [], signal: new AbortController().signal }));
    expect(result.routed.provider.id).toBe('fallback');
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
  });

  it('stops at an action budget rather than starting an unbounded next step', async () => {
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => response([{ id: 'tool-1', capabilityId: 'ops.tasks.list', input: {} }])), provider('fallback', async () => response())]),
      tools(),
    );
    const result = await loop.run(runInput({ profile: profile({ budgets: { maxDurationMs: 60_000, maxCostUsd: 10, maxActions: 1, maxFailures: 3, maxIterations: 5 } }) }));
    expect(result.termination).toBe('BUDGET_EXCEEDED');
    expect(result.counters.actions).toBe(1);
  });

  it('denies an out-of-grant capability and journals the denial', async () => {
    let busCalls = 0;
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => response([{ id: 'tool-1', capabilityId: 'ops.tasks.list', input: {} }])), provider('fallback', async () => response())]),
      tools({ call: async () => { busCalls += 1; return []; } }),
      { noProgressLimit: 1 },
    );
    const result = await loop.run(runInput({ profile: profile({ capabilityGrants: [] }) }));
    expect(busCalls).toBe(0);
    expect(result.termination).toBe('NO_PROGRESS');
    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.tool.denied' })]));
  });

  it('calls the capability bus directly as the agent principal when a Tier-0 grant is present', async () => {
    let observedPrincipal: Principal | undefined;
    const executor = new TierZeroToolExecutor([listTasks], {
      call: async (request) => {
        observedPrincipal = request.principal;
        return ['task'];
      },
    });
    const result = await executor.call(
      { principal, profile: profile(), runId: IDS.run, traceId: 'trace', signal: new AbortController().signal },
      { id: 'call-1', capabilityId: 'ops.tasks.list', input: {} },
    );
    expect(result.status).toBe('ok');
    expect(observedPrincipal).toMatchObject({ kind: 'agent', id: IDS.agent, runId: IDS.run });
  });

  it('propagates cancellation into the provider call and terminates canceled', async () => {
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async (request) => new Promise<ProviderResponse>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new ProviderError('TIMEOUT', 'aborted', false)), { once: true });
        })),
        provider('fallback', async () => response()),
      ]),
      tools(),
    );
    const pending = loop.run(runInput());
    await Promise.resolve();
    expect(loop.cancel(IDS.run)).toBe(true);
    await expect(pending).resolves.toMatchObject({ termination: 'CANCELED' });
  });

  it('enforces workspace concurrency and records typed events in the journal', async () => {
    const gate = new RunConcurrencyGate(1, 1);
    const held = gate.tryAcquire(IDS.workspace);
    const journal = new InMemoryRunJournal();
    const loop = new BoundedRunLoop(routerWith([provider('primary', async () => response()), provider('fallback', async () => response())]), tools(), {
      concurrency: gate,
      journal,
    });
    const rejected = await loop.run(runInput());
    expect(rejected.termination).toBe('CONCURRENCY_LIMIT');
    expect(journal.events(IDS.run)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.terminated' })]));
    held?.release();
  });

  it('aborts an active provider call when the global kill switch engages', async () => {
    const killSwitch = new LocalKillSwitch();
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async (request) => new Promise<ProviderResponse>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new ProviderError('TIMEOUT', 'killed', false)), { once: true });
        })),
        provider('fallback', async () => response()),
      ]),
      tools(),
      { killSwitch },
    );
    const pending = loop.run(runInput());
    await Promise.resolve();
    killSwitch.engage();
    await expect(pending).resolves.toMatchObject({ termination: 'KILL_SWITCH' });
  });
});

describe('workspace lease and per-step kill checks', () => {
  const toolCallResponse = (): ProviderResponse => ({
    ...response(),
    toolCalls: [{ id: 'c1', capabilityId: 'ops.tasks.list', input: {} }],
  });

  it('stops when the lease cannot be acquired', async () => {
    const loop = new BoundedRunLoop(routerWith([provider('primary', async () => response()), provider('fallback', async () => response())]), tools(), {
      workspaceLease: { port: { acquire: async () => undefined }, ttlMs: 1000 },
    });
    const result = await loop.run({ ...runInput(), leaseScope: { jobId: 'j', window: 'w' } });
    expect(result.termination).toBe('LEASE_LOST');
  });

  it('stops before the next step when a heartbeat reports the lease lost', async () => {
    let beats = 0;
    let released = false;
    const port = {
      acquire: async () => ({
        token: 1,
        heartbeat: async () => ++beats < 2,
        release: async () => {
          released = true;
        },
      }),
    };
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => toolCallResponse()), provider('fallback', async () => response())]),
      tools(),
      { workspaceLease: { port, ttlMs: 1000 } },
    );
    const result = await loop.run({ ...runInput(), leaseScope: { jobId: 'j', window: 'w' } });
    expect(result.termination).toBe('LEASE_LOST');
    expect(released).toBe(true);
  });

  it('LocalOnlyLeasePort is exclusive per (workspace, job, window) and expires by TTL', async () => {
    let t = 0;
    const port = new LocalOnlyLeasePort(() => t);
    const key = { workspaceId: IDS.workspace, jobId: 'j', window: 'w' };
    const first = await port.acquire(key, 100);
    expect(await port.acquire(key, 100)).toBeUndefined();
    expect(await port.acquire({ ...key, window: 'w2' }, 100)).toBeDefined();
    t = 200;
    expect(await first?.heartbeat()).toBe(false);
    expect(await port.acquire(key, 100)).toBeDefined();
  });

  it('checks the kill switch before each tool step, not only at start', async () => {
    const killSwitch = new LocalKillSwitch();
    let calls = 0;
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async () => {
          calls += 1;
          killSwitch.engage();
          return toolCallResponse();
        }),
        provider('fallback', async () => response()),
      ]),
      tools(),
      { killSwitch },
    );
    const result = await loop.run(runInput());
    expect(result.termination).toBe('KILL_SWITCH');
    expect(calls).toBe(1);
    expect(result.counters.actions).toBe(0);
  });
});

describe('Night Shift and MCP boundaries', () => {
  it('waits for WP-CLOUD lease coordination instead of acquiring a multi-device lease itself', () => {
    const nightShift = new NightShiftController();
    nightShift.configure({ maxRuns: 1, maxSpendUsd: 1, allowedCapabilityIds: ['ops.tasks.list'], autonomyCeiling: 2 });
    expect(nightShift.begin({ desktopRunning: true, leaseAvailable: false, killSwitchEngaged: false })).toBe('WAITING_FOR_LEASE');
  });

  it('denies unregistered MCP use before it can reach a transport', async () => {
    const mcp = new McpClientBoundary();
    await expect(mcp.callTool('unknown', 'anything', {}, new AbortController().signal)).rejects.toThrow('MCP_SERVER_NOT_REGISTERED');
  });

  it('rejects expired MCP credential references and detects prompt-eval regressions', async () => {
    const mcp = new McpClientBoundary();
    mcp.register({
      id: 'test',
      allowedTools: ['read'],
      credential: { id: 'ref', scope: 'mcp:test', expiresAt: '2026-01-01T00:00:00.000Z', revokedAt: null },
      transport: { listTools: async () => [], callTool: async () => ({}) },
      externalCallsEnabled: true,
    });
    await expect(mcp.listTools('test', new AbortController().signal, new Date('2026-02-01T00:00:00.000Z'))).rejects.toThrow(
      'CREDENTIAL_EXPIRED_OR_REVOKED',
    );
    const prompts = new PromptRegistry();
    prompts.register({ id: 'charter', version: 1, purpose: 'test', template: 'first', requiredCapabilities: ['text'], outputContract: {}, retiredAt: null });
    prompts.register({ id: 'charter', version: 2, purpose: 'test', template: 'second', requiredCapabilities: ['text'], outputContract: {}, retiredAt: null });
    expect(prompts.rollback('charter', 1).version).toBe(3);
    expect(prompts.current('charter').template).toBe('first');
    expect(prompts.retire('charter', '2026-01-01T00:00:00.000Z').version).toBe(4);
    expect(() => prompts.current('charter')).toThrow('PROMPT_RETIRED');
    expect(prompts.rollback('charter', 2).version).toBe(5);
    expect(prompts.current('charter').template).toBe('second');
    expect(
      regressionReasons(
        { taskCompletion: 1, toolSuccess: 1, schemaSuccess: 1, hallucinationRate: 0, fallbackRate: 0 },
        { taskCompletion: 0.5, toolSuccess: 0.5, schemaSuccess: 0.5, hallucinationRate: 0.5, fallbackRate: 0.5 },
      ),
    ).toEqual(expect.arrayContaining(['TASK_COMPLETION_REGRESSION', 'HALLUCINATION_REGRESSION']));
  });
});

describe('review cycle 2 regressions', () => {
  const hang = (request: { signal: AbortSignal }, error = new ProviderError('UNAVAILABLE', 'aborted', true)) =>
    new Promise<ProviderResponse>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(error), { once: true });
    });
  const toolCall = () => response([{ id: 'c1', capabilityId: 'ops.tasks.list', input: {} }]);

  it('SWM-R-001: delegation is bounded by the parent REMAINING budget, not its original caps', () => {
    const parent = profile();
    const consumed = { counters: { iterations: 1, actions: 1, failures: 0, costUsd: 6 }, elapsedMs: 1_000 };
    const denied = decideDelegation({
      parentProfile: parent,
      childProfile: profile(),
      parentDepth: 0,
      maximumDepth: 2,
      parentBudget: parent.budgets,
      parentConsumed: consumed,
    });
    expect(denied).toEqual({ allowed: false, reason: 'DELEGATION_BUDGET_EXCEEDED' });
    const childBudget = { maxDurationMs: 30_000, maxCostUsd: 4, maxActions: 2, maxFailures: 3, maxIterations: 2 };
    const allowed = decideDelegation({
      parentProfile: parent,
      childProfile: profile({ budgets: childBudget }),
      parentDepth: 0,
      maximumDepth: 2,
      parentBudget: parent.budgets,
      parentConsumed: consumed,
    });
    expect(allowed).toEqual({ allowed: true, depth: 1, budget: childBudget });
  });

  it('probe (a): no fallback provider call after cancellation', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async (request) => {
          primaryCalls += 1;
          return hang(request);
        }),
        provider('fallback', async () => {
          fallbackCalls += 1;
          return response();
        }),
      ]),
      tools(),
    );
    const pending = loop.run(runInput());
    await Promise.resolve();
    loop.cancel(IDS.run);
    await expect(pending).resolves.toMatchObject({ termination: 'CANCELED' });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  it('probe (a): no fallback provider call after the kill switch engages', async () => {
    const killSwitch = new LocalKillSwitch();
    let fallbackCalls = 0;
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async (request) => hang(request)),
        provider('fallback', async () => {
          fallbackCalls += 1;
          return response();
        }),
      ]),
      tools(),
      { killSwitch },
    );
    const pending = loop.run(runInput());
    await Promise.resolve();
    killSwitch.engage();
    await expect(pending).resolves.toMatchObject({ termination: 'KILL_SWITCH' });
    expect(fallbackCalls).toBe(0);
  });

  it('probe (b): the run deadline aborts an in-flight provider call', async () => {
    let aborted = false;
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async (request) => {
          request.signal.addEventListener('abort', () => (aborted = true), { once: true });
          return hang(request, new ProviderError('TIMEOUT', 'deadline', false));
        }),
        provider('fallback', async () => response()),
      ]),
      tools(),
    );
    const budgets = { maxDurationMs: 25, maxCostUsd: 10, maxActions: 3, maxFailures: 3, maxIterations: 3 };
    const result = await loop.run(runInput({ profile: profile({ budgets }) }));
    expect(result.termination).toBe('TIMEOUT');
    expect(aborted).toBe(true);
  }, 2_000);

  it('probe (c): an expired lease holder can neither renew nor release its replacement', async () => {
    let now = 0;
    const port = new LocalOnlyLeasePort(() => now);
    const key = { workspaceId: IDS.workspace, jobId: 'j', window: 'w' };
    const stale = await port.acquire(key, 100);
    now = 200;
    const replacement = await port.acquire(key, 100);
    expect(replacement?.token).toBeGreaterThan(stale?.token ?? Infinity);
    expect(await stale?.heartbeat()).toBe(false);
    await stale?.release();
    expect(await port.acquire(key, 100)).toBeUndefined();
    expect(await replacement?.heartbeat()).toBe(true);
  });

  it('probe (c): tool calls carry the lease fencing token', async () => {
    const tokens: unknown[] = [];
    const port = new LocalOnlyLeasePort();
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => toolCall()), provider('fallback', async () => response())]),
      new TierZeroToolExecutor([listTasks], {
        call: async (request) => {
          tokens.push(request.fencingToken);
          return ['task'];
        },
      }),
      { workspaceLease: { port, ttlMs: 60_000 } },
    );
    await loop.run({ ...runInput({ profile: profile({ budgets: { maxDurationMs: 60_000, maxCostUsd: 10, maxActions: 1, maxFailures: 3, maxIterations: 3 } }) }), leaseScope: { jobId: 'j', window: 'w' } });
    expect(tokens).toEqual([expect.any(Number)]);
  });

  it('probe (d) / SWM-R-009: Night Shift rejects negative or NaN costs and records nothing after a kill', () => {
    const nightShift = new NightShiftController();
    nightShift.configure({ maxRuns: 5, maxSpendUsd: 1, allowedCapabilityIds: ['ops.tasks.list'], autonomyCeiling: 2 });
    nightShift.begin({ desktopRunning: true, leaseAvailable: true, killSwitchEngaged: false });
    const request = (estimatedCostUsd: number) => ({ estimatedCostUsd, capabilityIds: ['ops.tasks.list'], autonomyLevel: 1 });
    expect(nightShift.canStart(request(-5))).toEqual({ allowed: false, reason: 'NIGHT_SHIFT_INVALID_COST' });
    expect(nightShift.canStart(request(Number.NaN))).toEqual({ allowed: false, reason: 'NIGHT_SHIFT_INVALID_COST' });
    expect(() => nightShift.recordRun(request(-5))).toThrow('NIGHT_SHIFT_INVALID_COST');
    expect(() => nightShift.recordRun({ ...request(0.1), capabilityIds: ['core.admin'] })).toThrow('NIGHT_SHIFT_CAPABILITY_DENIED');
    nightShift.recordRun(request(0.9));
    expect(nightShift.canStart(request(0.2))).toEqual({ allowed: false, reason: 'NIGHT_SHIFT_SPEND_CAP' });
    nightShift.kill();
    expect(() => nightShift.recordRun(request(0))).toThrow('NIGHT_SHIFT_KILLED');
  });

  it('SWM-R-004: releases the workspace lease exactly once on every termination path', async () => {
    const cases: { termination: string; build: (port: ReturnType<typeof countingPort>) => Promise<{ termination: string }> }[] = [
      { termination: 'COMPLETED', build: (port) => leasedRun(port, async () => response()) },
      { termination: 'BUDGET_EXCEEDED', build: (port) => leasedRun(port, async () => toolCall(), { maxIterations: 1 }) },
      { termination: 'FAILED', build: (port) => leasedRun(port, async () => { throw new ProviderError('INVALID_RESPONSE', 'bad', false); }) },
      { termination: 'LEASE_LOST', build: (port) => { port.beats = 0; return leasedRun(port, async () => toolCall()); } },
      {
        termination: 'CANCELED',
        build: (port) => {
          const controller = new AbortController();
          controller.abort();
          return leasedRun(port, async () => response(), {}, { signal: controller.signal });
        },
      },
      {
        termination: 'KILL_SWITCH',
        build: (port) => {
          const killSwitch = new LocalKillSwitch();
          killSwitch.engage();
          return leasedRun(port, async () => response(), {}, {}, killSwitch);
        },
      },
    ];
    for (const item of cases) {
      const port = countingPort();
      await expect(item.build(port)).resolves.toMatchObject({ termination: item.termination });
      expect({ termination: item.termination, releases: port.releases }).toEqual({ termination: item.termination, releases: 1 });
    }
  });

  it('SWM-R-005: the kill switch aborts an in-flight tool call', async () => {
    const killSwitch = new LocalKillSwitch();
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => (started = resolve));
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => toolCall()), provider('fallback', async () => response())]),
      new TierZeroToolExecutor([listTasks], {
        call: async (request) =>
          new Promise((_, reject) => {
            started();
            request.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
          }),
      }),
      { killSwitch },
    );
    const pending = loop.run(runInput());
    await toolStarted;
    killSwitch.engage();
    const result = await pending;
    expect(result.termination).toBe('KILL_SWITCH');
    expect(result.artifacts.filter((artifact) => (artifact.content as { status?: string }).status === 'ok')).toEqual([]);
  });

  it('SWM-R-006: a negative provider cost fails the run closed instead of throwing', async () => {
    const loop = new BoundedRunLoop(
      routerWith([provider('primary', async () => ({ ...response(), usage: { inputTokens: 1, outputTokens: 1, costUsd: -1 } })), provider('fallback', async () => response())]),
      tools(),
    );
    await expect(loop.run(runInput())).resolves.toMatchObject({ termination: 'FAILED', counters: { costUsd: 0 } });
  });

  it('SWM-R-006: the kill switch wins when it races budget exhaustion', async () => {
    const killSwitch = new LocalKillSwitch();
    const loop = new BoundedRunLoop(
      routerWith([
        provider('primary', async () => {
          killSwitch.engage();
          return { ...response(), usage: { inputTokens: 1, outputTokens: 1, costUsd: 50 } };
        }),
        provider('fallback', async () => response()),
      ]),
      tools(),
      { killSwitch },
    );
    await expect(loop.run(runInput())).resolves.toMatchObject({ termination: 'KILL_SWITCH' });
  });

  it('SWM-R-006/008: MCP rejects revoked credentials and aborted signals before the transport', async () => {
    let transportCalls = 0;
    const transport = { listTools: async () => [], callTool: async () => { transportCalls += 1; return {}; } };
    const mcp = new McpClientBoundary();
    mcp.register({ id: 'revoked', allowedTools: ['read'], credential: { id: 'r', scope: 'mcp:r', expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: '2026-01-01T00:00:00.000Z' }, transport, externalCallsEnabled: true });
    mcp.register({ id: 'live', allowedTools: ['read'], credential: { id: 'l', scope: 'mcp:l', expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null }, transport, externalCallsEnabled: true });
    const now = new Date('2026-06-01T00:00:00.000Z');
    await expect(mcp.callTool('revoked', 'read', {}, new AbortController().signal, now)).rejects.toThrow('CREDENTIAL_EXPIRED_OR_REVOKED');
    const aborted = new AbortController();
    aborted.abort();
    await expect(mcp.callTool('live', 'read', {}, aborted.signal, now)).rejects.toThrow('CANCELED');
    await expect(mcp.listTools('live', aborted.signal, now)).rejects.toThrow('CANCELED');
    expect(transportCalls).toBe(0);
  });
});

function countingPort() {
  const port = {
    releases: 0,
    beats: Number.POSITIVE_INFINITY,
    acquire: async () => ({
      token: 1,
      heartbeat: async () => port.beats-- > 0,
      release: async () => {
        port.releases += 1;
      },
    }),
  };
  return port;
}

function leasedRun(
  port: ReturnType<typeof countingPort>,
  complete: AiProvider['complete'],
  budgets: Partial<AgentProfileType['budgets']> = {},
  extra: Partial<AgentRunInput> = {},
  killSwitch?: LocalKillSwitch,
) {
  const loop = new BoundedRunLoop(routerWith([provider('primary', complete), provider('fallback', complete)]), tools(), {
    workspaceLease: { port, ttlMs: 60_000 },
    ...(killSwitch ? { killSwitch } : {}),
  });
  const base = runInput({ profile: profile({ budgets: { ...profile().budgets, ...budgets } }), ...extra });
  return loop.run({ ...base, leaseScope: { jobId: 'j', window: 'w' } });
}

describe('in-process agent runner seam', () => {
  it('executes only through the bounded loop and reports active invocation state without queue semantics', async () => {
    const runner = new AgentRunner({
      router: routerWith([provider('primary', async () => response())]),
      capabilities: [],
      capabilityCaller: { call: async () => { throw new Error('no capabilities configured'); } },
    });
    expect(runner.activeRunIds).toEqual([]);
    const result = await runner.run(runInput());
    expect(result.termination).toBe('COMPLETED');
    expect(runner.activeRunIds).toEqual([]);
    expect(runner.cancel(IDS.run)).toBe(false);
  });
});
