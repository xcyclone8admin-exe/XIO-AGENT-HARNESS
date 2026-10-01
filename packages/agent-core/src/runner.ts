import type { AgentRunInput, AgentRunResult } from './contracts';
import type { CapabilityCaller } from './contracts';
import { BoundedRunLoop } from './loop';
import type { ModelRouter } from './router';
import { TierZeroToolExecutor } from './tier-zero';
import { PreparedAgentRun, type TrustedAgentRunPreparation } from './prepared-run';

export interface AgentRunnerOptions {
  readonly router: ModelRouter;
  readonly capabilities: ConstructorParameters<typeof TierZeroToolExecutor>[0];
  readonly capabilityCaller: CapabilityCaller;
  readonly loopOptions?: ConstructorParameters<typeof BoundedRunLoop>[2];
}

/**
 * In-process bounded invocation seam for a host that already owns durable scheduling and auth.
 * It deliberately does not queue, persist jobs, or claim a run before the returned promise starts.
 */
export class AgentRunner {
  private readonly loop: BoundedRunLoop;
  private readonly active = new Set<string>();

  constructor(options: AgentRunnerOptions) {
    if (!options.router || !options.capabilityCaller || typeof options.capabilityCaller.call !== 'function') throw new Error('AGENT_RUNNER_HOST_DEPENDENCIES_REQUIRED');
    this.loop = new BoundedRunLoop(options.router, new TierZeroToolExecutor(options.capabilities, options.capabilityCaller), options.loopOptions);
  }

  prepare(input: TrustedAgentRunPreparation): PreparedAgentRun {
    return PreparedAgentRun.fromTrustedHost(input);
  }

  get activeRunIds(): readonly string[] { return [...this.active]; }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.active.has(input.runId)) throw new Error('RUN_ALREADY_ACTIVE');
    this.active.add(input.runId);
    try { return await this.loop.run(input); }
    finally { this.active.delete(input.runId); }
  }

  runPrepared(prepared: PreparedAgentRun): Promise<AgentRunResult> {
    if (!(prepared instanceof PreparedAgentRun)) throw new Error('TRUSTED_PREPARED_RUN_REQUIRED');
    return this.run(prepared.input);
  }

  cancel(runId: string): boolean { return this.loop.cancel(runId); }
}
