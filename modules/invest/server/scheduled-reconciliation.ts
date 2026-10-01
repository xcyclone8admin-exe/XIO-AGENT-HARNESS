const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Host-authenticated context only. This type is intentionally absent from the capability catalog. */
export type DailyReconciliationDispatch = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly runId: string;
  /** Canonical UTC instant for the scheduled day, supplied by the trusted host scheduler. */
  readonly scheduledFor: string;
  readonly dispatchId: string;
  readonly idempotencyKey: string;
};

export type TrustedScheduledDispatchContext = DailyReconciliationDispatch;
export type ValidatedDailyReconciliationDispatch = TrustedScheduledDispatchContext & {
  readonly utcDay: string;
};

export type IdempotentDispatchResult<T> = {
  readonly value: T;
  readonly idempotent: boolean;
};

export type VerifiedFlowRunScope = Pick<TrustedScheduledDispatchContext,'tenantId'|'workspaceId'|'workflowId'|'runId'>;

/** Implemented by the server host against FLOW's persisted claimed/approved run. */
export interface ClaimedApprovedFlowRunReader {
  verifyClaimedApprovedRun(context: ValidatedDailyReconciliationDispatch): Promise<VerifiedFlowRunScope>;
}

/**
 * A host-owned durable store must check the FLOW run is claimed and approved,
 * verify its tenant/workspace against this context, then serialize/replay by
 * idempotencyKey while retaining completed results.
 */
export interface DailyReconciliationDispatchStore {
  runOnce<T>(
    dispatch: ValidatedDailyReconciliationDispatch,
    work: () => Promise<T>,
  ): Promise<IdempotentDispatchResult<T>>;
}

export type DailyReconciliationHandler<T> = (
  dispatch: ValidatedDailyReconciliationDispatch,
) => Promise<T>;

export function validateDailyReconciliationDispatch(
  input: TrustedScheduledDispatchContext,
  nowMs = Date.now(),
): ValidatedDailyReconciliationDispatch {
  if (![input.tenantId,input.workspaceId,input.workflowId,input.runId,input.dispatchId].every((value)=>UUID.test(value))) {
    throw new Error('Scheduled custody dispatch requires authenticated scope, FLOW run identity, and a valid dispatch id');
  }
  const timestamp = Date.parse(input.scheduledFor);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== input.scheduledFor) {
    throw new Error('scheduledFor must be a canonical UTC ISO timestamp');
  }
  if (timestamp > nowMs + 60_000 || timestamp < nowMs - 24 * 60 * 60_000) {
    throw new Error('Scheduled reconciliation dispatch is outside the accepted UTC window');
  }
  const utcDay = input.scheduledFor.slice(0, 10);
  const expectedKey = `invest.custody.daily:${input.tenantId}:${input.workspaceId}:${input.workflowId}:${input.runId}:${utcDay}`;
  if (input.idempotencyKey !== expectedKey) {
    throw new Error('Scheduled reconciliation idempotency key must bind tenant, workspace, and UTC day');
  }
  return { ...input, utcDay };
}

/**
 * Internal host-to-module seam. Call only after authenticating the scheduler;
 * never register this as a UI, agent, workflow, or MCP capability.
 * The host store owns durable replay suppression; the callback receives no
 * caller-supplied tenant/workspace fields beyond this validated host context.
 */
export async function dispatchScheduledCustody<T>(
  input: TrustedScheduledDispatchContext,
  flowRunReader: ClaimedApprovedFlowRunReader,
  store: DailyReconciliationDispatchStore,
  work: DailyReconciliationHandler<T>,
  nowMs = Date.now(),
): Promise<IdempotentDispatchResult<T>> {
  const dispatch = validateDailyReconciliationDispatch(input, nowMs);
  const verifiedScope = await flowRunReader.verifyClaimedApprovedRun(dispatch);
  if (verifiedScope.tenantId !== dispatch.tenantId || verifiedScope.workspaceId !== dispatch.workspaceId ||
      verifiedScope.workflowId !== dispatch.workflowId || verifiedScope.runId !== dispatch.runId) {
    throw new Error('FLOW custody dispatch scope does not match the claimed approved run');
  }
  return store.runOnce(dispatch, () => work(dispatch));
}
