import { expect, test, vi } from 'vitest';
import {
  INVEST_DAILY_CUSTODY_HANDLER,
  registerInvestDailyCustodyHandler,
  validateScheduledCustodyContext,
  type PrivateFlowStepRegistry,
  type TrustedFlowStepContext,
} from '../server/scheduled-reconciliation';

const runId = '019a0000-0000-7000-8000-000000000701';
const context = (overrides: Partial<TrustedFlowStepContext> = {}): TrustedFlowStepContext => ({
  tenantId: '019a0000-0000-7000-8000-000000000702',
  workspaceId: '019a0000-0000-7000-8000-000000000703',
  principalId: '019a0000-0000-7000-8000-000000000704',
  workflowId: '019a0000-0000-7000-8000-000000000705',
  runId,
  trigger: 'schedule',
  stepId: 'daily-reconciliation',
  stepIndex: 0,
  attempt: 1,
  scheduledFor: new Date().toISOString(),
  dispatchId: `${runId}:0:1`,
  ...overrides,
});

test('scheduled custody derives stable tenant/workspace/workflow UTC-day idempotency from trusted FLOW context', () => {
  const first = validateScheduledCustodyContext(context());
  const retryRun = '019a0000-0000-7000-8000-000000000706';
  const second = validateScheduledCustodyContext(context({ runId: retryRun, attempt: 2, dispatchId: `${retryRun}:0:2` }));
  expect(first.idempotencyKey).toBe(second.idempotencyKey);
  expect(first.idempotencyKey).toContain(first.utcDay);
  expect(first.scope).toEqual({ tenantId: context().tenantId, workspaceId: context().workspaceId });
});

test('manual, missing, malformed, stale, and untrusted dispatch identities are refused', () => {
  expect(() => validateScheduledCustodyContext(context({ trigger: 'manual', scheduledFor: null }))).toThrow('INVEST_CUSTODY_SCHEDULE_TRIGGER_REQUIRED');
  expect(() => validateScheduledCustodyContext(context({ scheduledFor: null }))).toThrow('INVEST_CUSTODY_SCHEDULED_FOR_MISSING');
  expect(() => validateScheduledCustodyContext(context({ scheduledFor: 'not-a-schedule-time' }))).toThrow('INVEST_CUSTODY_SCHEDULED_FOR_INVALID');
  expect(() => validateScheduledCustodyContext(context({ scheduledFor: '2026-09-30T10:00:00-07:00' }))).not.toThrow();
  expect(() => validateScheduledCustodyContext(context({ dispatchId: 'renderer-value' }))).toThrow('INVEST_CUSTODY_FLOW_CONTEXT_INVALID');
  expect(() => validateScheduledCustodyContext(context({ scheduledFor: '2020-01-01T00:00:00.000Z' }))).toThrow('INVEST_CUSTODY_SCHEDULE_OUTSIDE_WINDOW');
});

test('FLOW handler accepts no statement data from workflow input and delegates trusted context', async () => {
  const handlers = new Map<string, (input:Record<string,unknown>,context:TrustedFlowStepContext)=>Promise<Record<string,unknown>>>();
  const registry:PrivateFlowStepRegistry={register:(name,handler)=>{handlers.set(name,handler);}};
  const dispatch = vi.fn(async (step: TrustedFlowStepContext) => ({ status: 'completed', runId: step.runId }));
  const step = context();
  registerInvestDailyCustodyHandler(registry, { dispatchScheduledCustody: dispatch });
  const handler=handlers.get(INVEST_DAILY_CUSTODY_HANDLER);
  if(!handler)throw new Error('Scheduled custody handler was not registered');
  await expect(handler({}, step)).resolves.toEqual({ status: 'completed', runId });
  expect(dispatch).toHaveBeenCalledWith(step);
  await expect(handler({ tenantId: 'attacker' }, step)).rejects.toThrow('INVEST_CUSTODY_FLOW_INPUT_MUST_BE_EMPTY');
});
