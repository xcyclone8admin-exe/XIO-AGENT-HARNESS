import { describe, expect, it } from 'vitest';
import { EMPTY_CHECKPOINT, mergeCheckpoint, nextStepIndex, runFromCheckpoint } from '../server/pipeline-engine';
import type { PipelineStep } from '../contracts';

const steps: PipelineStep[] = [
  { name: 'step-a', kind: 'csv_import', config: {} },
  { name: 'step-b', kind: 'sql_transform', config: {} },
];

describe('pipeline-engine (pure, DB-independent)', () => {
  it('starts at step 0 with an empty checkpoint and advances by one per completed step', () => {
    expect(nextStepIndex(steps, EMPTY_CHECKPOINT)).toBe(0);
    const afterFirst = mergeCheckpoint(EMPTY_CHECKPOINT, { stepIndex: 0, stepName: 'step-a', output: { ok: true } });
    expect(afterFirst.completedStepIndex).toBe(0);
    expect(nextStepIndex(steps, afterFirst)).toBe(1);
    const afterSecond = mergeCheckpoint(afterFirst, { stepIndex: 1, stepName: 'step-b', output: { ok: true } });
    expect(nextStepIndex(steps, afterSecond)).toBe(2);
  });

  it('runs every step exactly once from an empty checkpoint', async () => {
    const calls: number[] = [];
    const outcome = await runFromCheckpoint(steps, EMPTY_CHECKPOINT, async (step, context) => {
      calls.push(context.stepIndex);
      return { name: step.name };
    });
    expect(calls).toEqual([0, 1]);
    expect(outcome.completed).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.checkpoint.completedStepIndex).toBe(1);
    expect(outcome.checkpoint.stepResults).toEqual([{ name: 'step-a' }, { name: 'step-b' }]);
  });

  it('stops at the failing step and returns a checkpoint that resumes at that same step', async () => {
    const calls: number[] = [];
    const outcome = await runFromCheckpoint(steps, EMPTY_CHECKPOINT, async (step, context) => {
      calls.push(context.stepIndex);
      if (context.stepIndex === 1) throw new Error('boom');
      return { name: step.name };
    });
    expect(calls).toEqual([0, 1]);
    expect(outcome.completed).toBe(false);
    expect(outcome.error?.message).toBe('boom');
    expect(outcome.checkpoint.completedStepIndex).toBe(0);
    expect(nextStepIndex(steps, outcome.checkpoint)).toBe(1);

    const resumeCalls: number[] = [];
    const resumed = await runFromCheckpoint(steps, outcome.checkpoint, async (step, context) => {
      resumeCalls.push(context.stepIndex);
      return { name: step.name };
    });
    expect(resumeCalls).toEqual([1]);
    expect(resumed.completed).toBe(true);
  });

  it('short-circuits with no step calls once every step is already checkpointed complete', async () => {
    const calls: number[] = [];
    const doneCheckpoint = { completedStepIndex: steps.length - 1, stepResults: [{ a: 1 }, { b: 2 }] };
    const outcome = await runFromCheckpoint(steps, doneCheckpoint, async (step, context) => {
      calls.push(context.stepIndex);
      return { name: step.name };
    });
    expect(calls).toEqual([]);
    expect(outcome.completed).toBe(true);
  });
});
