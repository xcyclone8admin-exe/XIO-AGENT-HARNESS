import type { WorkflowStep } from '../contracts';

/**
 * Resolves a workflow's declared step DAG into one valid linear execution order (Kahn's
 * algorithm). The engine still executes one step at a time, but this is what makes "DAG trigger"
 * honest: dependencies are declared, validated as acyclic, and the stored order is a real
 * topological sort of them rather than just whatever order the caller happened to list steps in.
 */
export function topologicalOrder(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) throw new Error('FLOW_DUPLICATE_STEP_ID');
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`FLOW_UNKNOWN_STEP_DEPENDENCY:${step.id}->${dependency}`);
      if (dependency === step.id) throw new Error(`FLOW_SELF_DEPENDENCY:${step.id}`);
    }
  }
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const ordered: WorkflowStep[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) throw new Error('FLOW_WORKFLOW_HAS_CYCLE');
    ready.sort();
    for (const id of ready) {
      ordered.push(byId.get(id)!);
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) deps.delete(id);
    }
  }
  return ordered;
}
