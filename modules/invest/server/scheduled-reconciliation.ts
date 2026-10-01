import type { Scope } from '@xyra/db';
import type { StepContext } from '@xyra/mod-flow/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Statement data has already been persisted by the trusted custody/source adapter. */
export type PersistedCustodyStatement = {
  readonly id: string;
  readonly ownerId: string;
  readonly portfolioId: string;
  readonly sourceName: string;
  readonly sourceRef: string;
  readonly statementDate: string;
  readonly statementHash: string;
  readonly cashUnits: string;
  readonly positions: readonly { readonly symbol: string; readonly units: string }[];
};

/** Host adapter over a durable, already-authenticated custody inbox. It performs no provider calls. */
export interface PersistedCustodyStatementInbox {
  listEligible(scope: Scope, scheduledFor: string): Promise<readonly PersistedCustodyStatement[]>;
  acknowledgeProcessed(scope: Scope, statementIds: readonly string[], dispatchId: string): Promise<void>;
}

/** FLOW's server-generated context; never construct it from renderer or workflow input. */
export type TrustedFlowStepContext = StepContext;

export interface PrivateFlowStepRegistry {
  register(name: string, handler: (input: Record<string, unknown>, context: TrustedFlowStepContext) => Promise<Record<string, unknown>>): void;
}

export interface ScheduledCustodyService {
  dispatchScheduledCustody(context: TrustedFlowStepContext): Promise<Record<string, unknown>>;
}

export const INVEST_DAILY_CUSTODY_HANDLER = 'invest.daily-custody-reconciliation';

/** Installs the private FLOW handler; it ignores no caller input because none is accepted. */
export function registerInvestDailyCustodyHandler(registry: PrivateFlowStepRegistry, service: ScheduledCustodyService): void {
  registry.register(INVEST_DAILY_CUSTODY_HANDLER, async (input, context) => {
    if (Object.keys(input).length !== 0) throw new Error('INVEST_CUSTODY_FLOW_INPUT_MUST_BE_EMPTY');
    return { ...await service.dispatchScheduledCustody(context) };
  });
}

export type ScheduledCustodyDispatch = {
  readonly scope: Scope;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly dispatchId: string;
  readonly scheduledFor: string;
  readonly utcDay: string;
  readonly idempotencyKey: string;
};

/**
 * FLOW owns every field in this context, including scheduledFor copied from
 * persisted run detail. No value comes from workflow input or renderer data.
 */
export function validateScheduledCustodyContext(
  context: TrustedFlowStepContext,
  nowMs = Date.now(),
): ScheduledCustodyDispatch {
  if (context.trigger !== 'schedule') throw new Error('INVEST_CUSTODY_SCHEDULE_TRIGGER_REQUIRED');
  if (![context.tenantId, context.workspaceId, context.workflowId, context.runId].every((value) => UUID.test(value)) ||
      !context.stepId || context.stepId.length > 120 ||
      !Number.isSafeInteger(context.stepIndex) || context.stepIndex < 0 ||
      !Number.isSafeInteger(context.attempt) || context.attempt < 0 ||
      context.dispatchId !== `${context.runId}:${context.stepIndex}:${context.attempt}`) {
    throw new Error('INVEST_CUSTODY_FLOW_CONTEXT_INVALID');
  }
  const scheduledFor = context.scheduledFor;
  if (!scheduledFor) throw new Error('INVEST_CUSTODY_SCHEDULED_FOR_MISSING');
  const timestamp = Date.parse(scheduledFor);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(scheduledFor) || !Number.isFinite(timestamp)) {
    throw new Error('INVEST_CUSTODY_SCHEDULED_FOR_INVALID');
  }
  if (timestamp > nowMs + 60_000 || timestamp < nowMs - 24 * 60 * 60_000) {
    throw new Error('INVEST_CUSTODY_SCHEDULE_OUTSIDE_WINDOW');
  }
  const utcDay = new Date(timestamp).toISOString().slice(0, 10);
  return {
    scope: { tenantId: context.tenantId, workspaceId: context.workspaceId },
    workflowId: context.workflowId,
    runId: context.runId,
    stepId: context.stepId,
    dispatchId: context.dispatchId,
    scheduledFor,
    utcDay,
    idempotencyKey: `invest.custody.daily:${context.tenantId}:${context.workspaceId}:${context.workflowId}:${utcDay}`,
  };
}
