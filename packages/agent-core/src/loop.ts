import { BudgetTracker } from './budgets';
import type { AgentRunInput, AgentRunResult, RunArtifact, RunEvent, RunTermination, ToolResult } from './contracts';
import type { RunLease } from './concurrency';
import type { RunJournal } from './journal';
import type { ModelRouter } from './router';
import type { TierZeroToolExecutor } from './tier-zero';

export interface KillSwitchSource {
  engaged(): boolean;
  onEngage?(listener: () => void): () => void;
}

/** Mutable state adapter for the sidecar/core kill-switch record. */
export class LocalKillSwitch implements KillSwitchSource {
  private value = false;
  private readonly listeners = new Set<() => void>();

  engaged(): boolean {
    return this.value;
  }

  engage(): void {
    this.value = true;
    for (const listener of this.listeners) listener();
  }

  resume(): void {
    this.value = false;
  }

  onEngage(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface RunLoopOptions {
  readonly now?: () => number;
  readonly killSwitch?: KillSwitchSource;
  readonly noProgressLimit?: number;
  readonly journal?: RunJournal;
  readonly concurrency?: { tryAcquire(workspaceId: string): RunLease | undefined };
}

/**
 * A bounded state machine: each model step and capability call checks cancellation, kill state,
 * and all configured budgets. It never invokes a process, browser, computer, or external adapter.
 */
export class BoundedRunLoop {
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly killSwitch: KillSwitchSource;
  private readonly noProgressLimit: number;
  private readonly journal: RunJournal | undefined;
  private readonly concurrency: RunLoopOptions['concurrency'];

  constructor(
    private readonly router: ModelRouter,
    private readonly tools: TierZeroToolExecutor,
    options: RunLoopOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.killSwitch = options.killSwitch ?? { engaged: () => false };
    this.noProgressLimit = options.noProgressLimit ?? 3;
    this.journal = options.journal;
    this.concurrency = options.concurrency;
  }

  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.controllers.has(input.runId)) throw new Error('RUN_ALREADY_ACTIVE');
    const lease = this.concurrency?.tryAcquire(input.workspaceId);
    if (this.concurrency && !lease) return this.rejectedForConcurrency(input.runId);
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    this.controllers.set(input.runId, controller);
    const unsubscribeKill = this.killSwitch.onEngage?.(() => controller.abort());
    const budget = new BudgetTracker(input.profile.budgets, this.now());
    const events: RunEvent[] = [];
    const toolResults: ToolResult[] = [];
    const artifacts: RunArtifact[] = [];
    let noProgress = 0;
    const emit = (type: RunEvent['type'], detail: Readonly<Record<string, unknown>> = {}) => {
      const event = { type, runId: input.runId, at: new Date(this.now()).toISOString(), detail } satisfies RunEvent;
      events.push(event);
      this.journal?.record(event);
    };
    emit('run.started', { profileId: input.profile.id });

    try {
      for (;;) {
        const terminal = this.checkTerminal(budget, controller.signal);
        if (terminal) return this.finish(input.runId, terminal, null, budget, events, artifacts, emit);
        budget.recordIteration();
        emit('run.model.called', { iteration: budget.snapshot().iterations });
        let completion;
        try {
          completion = await this.router.complete(
            input.route,
            (model) => ({ runId: input.runId, model, prompt: input.prompt, toolResults, signal: controller.signal }),
            {
              onRetry: (provider, retry) => emit('run.retry', { provider, retry }),
              onFallback: (provider) => emit('run.provider.fallback', { provider }),
            },
          );
        } catch (error) {
          const canceled = this.checkTerminal(budget, controller.signal);
          if (canceled) return this.finish(input.runId, canceled, null, budget, events, artifacts, emit);
          budget.recordFailure();
          return this.finish(input.runId, 'FAILED', null, budget, events, artifacts, emit, error instanceof Error ? error.message : 'PROVIDER_FAILED');
        }
        budget.recordCost(completion.response.usage.costUsd);
        const afterModel = this.checkTerminal(budget, controller.signal);
        if (afterModel) return this.finish(input.runId, afterModel, null, budget, events, artifacts, emit);
        if (completion.response.toolCalls.length === 0) {
          artifacts.push({ id: `${input.runId}:output`, type: 'agent.output', content: completion.response.output });
          return this.finish(input.runId, 'COMPLETED', completion.response.output, budget, events, artifacts, emit);
        }

        let progressed = false;
        for (const call of completion.response.toolCalls) {
          const beforeTool = this.checkTerminal(budget, controller.signal);
          if (beforeTool) return this.finish(input.runId, beforeTool, null, budget, events, artifacts, emit);
          budget.recordAction();
          emit('run.tool.called', { capabilityId: call.capabilityId, callId: call.id });
          const result = await this.tools.call(
            {
              principal: input.principal,
              profile: input.profile,
              runId: input.runId,
              traceId: input.runId,
              signal: controller.signal,
            },
            call,
          );
          toolResults.push(result);
          artifacts.push({ id: `${input.runId}:tool:${result.callId}`, type: 'agent.tool-result', content: result });
          if (result.status === 'denied') emit('run.tool.denied', { capabilityId: result.capabilityId, reason: result.reason ?? 'DENIED' });
          if (result.status === 'failed' || result.status === 'denied') budget.recordFailure();
          if (result.status === 'ok') progressed = true;
        }
        noProgress = progressed ? 0 : noProgress + 1;
        if (noProgress >= this.noProgressLimit) return this.finish(input.runId, 'NO_PROGRESS', null, budget, events, artifacts, emit);
      }
    } finally {
      this.controllers.delete(input.runId);
      unsubscribeKill?.();
      input.signal?.removeEventListener('abort', onExternalAbort);
      lease?.release();
    }
  }

  private checkTerminal(budget: BudgetTracker, signal: AbortSignal): RunTermination | undefined {
    if (this.killSwitch.engaged()) return 'KILL_SWITCH';
    if (signal.aborted) return 'CANCELED';
    const check = budget.check(this.now());
    return check.allowed ? undefined : check.termination;
  }

  private finish(
    runId: string,
    termination: RunTermination,
    output: string | null,
    budget: BudgetTracker,
    events: RunEvent[],
    artifacts: RunArtifact[],
    emit: (type: RunEvent['type'], detail?: Readonly<Record<string, unknown>>) => void,
    reason?: string,
  ): AgentRunResult {
    if (termination === 'CANCELED' || termination === 'KILL_SWITCH') emit('run.canceled', { termination });
    emit('run.terminated', { termination, ...(reason ? { reason } : {}) });
    return { runId, termination, output, counters: budget.snapshot(), events, artifacts };
  }

  private rejectedForConcurrency(runId: string): AgentRunResult {
    const event: RunEvent = { type: 'run.terminated', runId, at: new Date(this.now()).toISOString(), detail: { termination: 'CONCURRENCY_LIMIT' } };
    this.journal?.record(event);
    return {
      runId,
      termination: 'CONCURRENCY_LIMIT',
      output: null,
      counters: { iterations: 0, actions: 0, failures: 0, costUsd: 0 },
      events: [event],
      artifacts: [],
    };
  }
}
