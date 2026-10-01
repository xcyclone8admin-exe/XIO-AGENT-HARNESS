/**
 * FLOW ships no privileged step handlers. A step handler is a pure function the HOST registers;
 * FLOW's engine only ever calls whatever the host explicitly wired in. The one handler defined
 * here is intentionally inert (echoes its input) so a workflow is runnable and testable without
 * FLOW ever touching a real process, provider, or network call itself (no fabricated execution).
 */
export interface StepContext {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
}
export type StepHandler = (input: Record<string, unknown>, context: StepContext) => Promise<Record<string, unknown>>;

export class StepHandlerRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  constructor() {
    this.register('noop', async (input) => ({ ...input }));
  }

  register(name: string, handler: StepHandler): void {
    if (this.handlers.has(name)) throw new Error(`FLOW_HANDLER_ALREADY_REGISTERED:${name}`);
    this.handlers.set(name, handler);
  }

  async run(name: string, input: Record<string, unknown>, context: StepContext): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`FLOW_HANDLER_NOT_REGISTERED:${name}`);
    return handler(input, context);
  }
}
