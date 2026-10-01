import type { EvalMetrics, PromptVersion } from './contracts';

/** In-memory version registry; persistence is the append-only swarm_prompt_versions table. */
export class PromptRegistry {
  private readonly prompts = new Map<string, PromptVersion[]>();

  register(prompt: PromptVersion): void {
    const versions = this.prompts.get(prompt.id) ?? [];
    if (versions.some((entry) => entry.version === prompt.version)) throw new Error('PROMPT_VERSION_EXISTS');
    this.prompts.set(prompt.id, [...versions, prompt].sort((a, b) => a.version - b.version));
  }

  /**
   * Rows are append-only: the highest version is authoritative. A prompt is retired by appending a
   * newer version whose retiredAt is set, so a retired latest row means no current prompt.
   */
  current(id: string): PromptVersion {
    const latest = this.latest(id);
    if (!latest) throw new Error('PROMPT_NOT_FOUND');
    if (latest.retiredAt !== null) throw new Error('PROMPT_RETIRED');
    return latest;
  }

  /** Appends a retired copy of the latest version; earlier rows are never mutated. */
  retire(id: string, at: string): PromptVersion {
    const latest = this.latest(id);
    if (!latest) throw new Error('PROMPT_NOT_FOUND');
    const retired = { ...latest, version: latest.version + 1, retiredAt: at };
    this.register(retired);
    return retired;
  }

  /** Restores an earlier version's content as a new, live version. */
  rollback(id: string, targetVersion: number): PromptVersion {
    const target = (this.prompts.get(id) ?? []).find((entry) => entry.version === targetVersion);
    if (!target) throw new Error('PROMPT_VERSION_NOT_FOUND');
    const latest = this.latest(id);
    const restored = { ...target, version: (latest?.version ?? 0) + 1, retiredAt: null };
    this.register(restored);
    return restored;
  }

  private latest(id: string): PromptVersion | undefined {
    return this.prompts.get(id)?.at(-1);
  }
}
export function regressionReasons(previous: EvalMetrics, candidate: EvalMetrics, tolerance = 0.02): string[] {
  if (tolerance < 0 || !Number.isFinite(tolerance)) throw new Error('Invalid regression tolerance');
  const failures: string[] = [];
  if (candidate.taskCompletion + tolerance < previous.taskCompletion) failures.push('TASK_COMPLETION_REGRESSION');
  if (candidate.toolSuccess + tolerance < previous.toolSuccess) failures.push('TOOL_SUCCESS_REGRESSION');
  if (candidate.schemaSuccess + tolerance < previous.schemaSuccess) failures.push('SCHEMA_SUCCESS_REGRESSION');
  if (candidate.hallucinationRate > previous.hallucinationRate + tolerance) failures.push('HALLUCINATION_REGRESSION');
  if (candidate.fallbackRate > previous.fallbackRate + tolerance) failures.push('FALLBACK_RATE_REGRESSION');
  return failures;
}
