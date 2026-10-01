/**
 * FLOW ships no privileged step handlers. A step handler is a pure function the HOST registers;
 * FLOW's engine only ever calls whatever the host explicitly wired in. The one handler defined
 * here is intentionally inert (echoes its input) so a workflow is runnable and testable without
 * FLOW ever touching a real process, provider, or network call itself (no fabricated execution).
 *
 * Every field on StepContext is derived server-side by FlowRepository from the run's locked
 * current-event row and its workflow definition — never from the step's own `input` (workflow
 * JSON) and never from a caller-supplied value. A handler that needs to make a trusted downstream
 * call (e.g. a server-only method on another module) can rely on this context instead of trusting
 * anything the workflow author configured.
 */
export interface StepContext {
  readonly tenantId: string;
  readonly workspaceId: string;
  /** The principal that advanced/claimed this step (the trusted caller, e.g. a service identity). */
  readonly principalId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly trigger: 'manual' | 'schedule';
  readonly stepId: string;
  readonly stepIndex: number;
  readonly attempt: number;
  /**
   * The run's scheduled firing time, verbatim from what the host scheduler supplied to
   * triggerRun — never invented from createdAt. Required and validated at trigger time for
   * `trigger: 'schedule'` runs; always `null` for `trigger: 'manual'` runs.
   */
  readonly scheduledFor: string | null;
  /**
   * Stable per-(run, step, attempt) idempotency key — `${runId}:${stepIndex}:${attempt}` — the
   * same tuple flow_checkpoints enforces uniqueness on. It does not change across a lease recovery
   * for the same tuple, so a downstream trusted call keyed on it stays idempotent even if the step
   * is claimed and executed more than once due to a crashed claimant's lease expiring.
   */
  readonly dispatchId: string;
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
