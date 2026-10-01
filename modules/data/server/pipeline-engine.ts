import type { PipelineRunCheckpoint, PipelineStep } from '../contracts';

/**
 * Pure, DB-independent pipeline execution planning. Given the pipeline's steps and the most
 * recent checkpoint (or none), decides which step index runs next and how to merge its result
 * into the checkpoint. Kept independent of LocalScopedStore so it is unit-testable without PGlite.
 */
export interface StepExecutionResult {
  readonly stepIndex: number;
  readonly stepName: string;
  readonly output: Record<string, unknown>;
}

export interface StepExecutor {
  (step: PipelineStep, context: { stepIndex: number; priorResults: readonly Record<string, unknown>[] }): Promise<Record<string, unknown>>;
}

export function nextStepIndex(steps: readonly PipelineStep[], checkpoint: PipelineRunCheckpoint): number {
  const next = checkpoint.completedStepIndex + 1;
  if (next < 0) return 0;
  if (next >= steps.length) return steps.length;
  return next;
}

export function mergeCheckpoint(checkpoint: PipelineRunCheckpoint, result: StepExecutionResult): PipelineRunCheckpoint {
  const stepResults = [...checkpoint.stepResults];
  stepResults[result.stepIndex] = result.output;
  return { completedStepIndex: result.stepIndex, stepResults };
}

export const EMPTY_CHECKPOINT: PipelineRunCheckpoint = { completedStepIndex: -1, stepResults: [] };

/**
 * Runs every remaining step starting from the checkpoint, calling `execute` for each one and
 * folding its output into the checkpoint. Stops (without throwing further) and returns the
 * partial checkpoint plus the thrown error if a step fails, so the caller can persist a
 * 'failed' run with a checkpoint that resumes at the failed step on retry.
 */
export async function runFromCheckpoint(
  steps: readonly PipelineStep[],
  checkpoint: PipelineRunCheckpoint,
  execute: StepExecutor,
): Promise<{ checkpoint: PipelineRunCheckpoint; error: Error | null; completed: boolean }> {
  let current = checkpoint;
  for (let index = nextStepIndex(steps, current); index < steps.length; index = nextStepIndex(steps, current)) {
    const step = steps[index];
    if (!step) break;
    try {
      const output = await execute(step, { stepIndex: index, priorResults: current.stepResults });
      current = mergeCheckpoint(current, { stepIndex: index, stepName: step.name, output });
    } catch (cause) {
      return { checkpoint: current, error: cause instanceof Error ? cause : new Error(String(cause)), completed: false };
    }
  }
  return { checkpoint: current, error: null, completed: current.completedStepIndex >= steps.length - 1 };
}
