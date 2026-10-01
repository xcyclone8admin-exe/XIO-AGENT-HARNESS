import { expect, test, vi } from 'vitest';
import { dispatchScheduledCustody, validateDailyReconciliationDispatch } from '../server/scheduled-reconciliation';

const now = Date.parse('2026-09-30T12:00:00.000Z');
const context = {
  tenantId: '019a0000-0000-7000-8000-000000000501',
  workspaceId: '019a0000-0000-7000-8000-000000000502',
  workflowId: '019a0000-0000-7000-8000-000000000504',
  runId: '019a0000-0000-7000-8000-000000000505',
  scheduledFor: '2026-09-30T02:00:00.000Z',
  dispatchId: '019a0000-0000-7000-8000-000000000503',
  idempotencyKey: 'invest.custody.daily:019a0000-0000-7000-8000-000000000501:019a0000-0000-7000-8000-000000000502:019a0000-0000-7000-8000-000000000504:019a0000-0000-7000-8000-000000000505:2026-09-30',
};

test('server dispatch validates UTC scope/day and binds its deterministic idempotency key', () => {
  expect(validateDailyReconciliationDispatch(context, now)).toMatchObject({ ...context, utcDay: '2026-09-30' });
  expect(() => validateDailyReconciliationDispatch({ ...context, scheduledFor: '2026-09-30T02:00:00-07:00' }, now)).toThrow(/canonical UTC/);
  expect(() => validateDailyReconciliationDispatch({ ...context, idempotencyKey: 'caller-choice' }, now)).toThrow(/idempotency key/);
  expect(() => validateDailyReconciliationDispatch({ ...context, scheduledFor: '2026-10-01T02:00:00.000Z' }, now)).toThrow(/UTC window/);
  expect(() => validateDailyReconciliationDispatch({ ...context, workspaceId: 'not-a-uuid' }, now)).toThrow(/authenticated scope/);
});

test('authenticated host port routes once through its durable idempotency store without becoming a capability', async () => {
  const handler = vi.fn(async (dispatch: ReturnType<typeof validateDailyReconciliationDispatch>) => dispatch.utcDay);
  const call = vi.fn();
  const store = {
    async runOnce<T>(dispatch: ReturnType<typeof validateDailyReconciliationDispatch>, work: () => Promise<T>) {
      call(dispatch);
      return { value: await work(), idempotent: false };
    },
  };
  const flowRunReader={verifyClaimedApprovedRun:vi.fn(async()=>({tenantId:context.tenantId,workspaceId:context.workspaceId,workflowId:context.workflowId,runId:context.runId}))};
  await expect(dispatchScheduledCustody(context, flowRunReader, store, handler, now)).resolves.toEqual({ value: '2026-09-30', idempotent: false });
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey:context.idempotencyKey,dispatchId:context.dispatchId,workflowId:context.workflowId,runId:context.runId }));
  expect(handler).toHaveBeenCalledTimes(1);
  const mismatchedReader={verifyClaimedApprovedRun:vi.fn(async()=>({tenantId:context.tenantId,workspaceId:'019a0000-0000-7000-8000-000000000999',workflowId:context.workflowId,runId:context.runId}))};
  await expect(dispatchScheduledCustody(context,mismatchedReader,store,handler,now)).rejects.toThrow(/scope does not match/);
  expect(handler).toHaveBeenCalledTimes(1);
});
