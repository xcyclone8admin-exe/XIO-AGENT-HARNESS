import type { EvalMetrics, PromptVersion } from './contracts';

/** In-memory version registry; persistence is the append-only swarm_prompt_versions table. */
export class PromptRegistry {
  private readonly prompts = new Map<string, PromptVersion[]>();

  register(prompt: PromptVersion): void {
    const versions = this.prompts.get(prompt.id) ?? [];
    if (versions.some((entry) => entry.version === prompt.version)) throw new Error('PROMPT_VERSION_EXISTS');
    this.prompts.set(prompt.id, [...versions, prompt].sort((a, b) => a.version - b.version));
  }

  current(id: string): PromptVersion {
    const versions = this.prompts.get(id) ?? [];
    const prompt = [...versions].reverse().find((entry) => entry.retiredAt === null);
    if (!prompt) throw new Error('PROMPT_NOT_FOUND');
    return prompt;
  }

  rollback(id: string, targetVersion: number, at: string): PromptVersion {
    const versions = this.prompts.get(id) ?? [];
    const target = versions.find((entry) => entry.version === targetVersion);
    if (!target) throw new Error('PROMPT_VERSION_NOT_FOUND');
    const retired = versions.map((entry) => (entry.retiredAt === null ? { ...entry, retiredAt: at } : entry));
    const restored = { ...target, version: Math.max(...versions.map((entry) => entry.version), 0) + 1, retiredAt: null };
    this.prompts.set(id, [...retired, restored]);
    return restored;
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
