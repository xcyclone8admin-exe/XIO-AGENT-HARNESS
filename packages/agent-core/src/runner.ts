import type { AgentRunInput, AgentRunResult } from './contracts';
import type { CapabilityCaller } from './contracts';
import { BoundedRunLoop } from './loop';
import type { ModelRouter } from './router';
import { TierZeroToolExecutor } from './tier-zero';

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
    this.loop = new BoundedRunLoop(options.router, new TierZeroToolExecutor(options.capabilities, options.capabilityCaller), options.loopOptions);
  }

  get activeRunIds(): readonly string[] { return [...this.active]; }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.active.has(input.runId)) throw new Error('RUN_ALREADY_ACTIVE');
    this.active.add(input.runId);
    try { return await this.loop.run(input); }
    finally { this.active.delete(input.runId); }
  }

  cancel(runId: string): boolean { return this.loop.cancel(runId); }
}
