import type { AgentProfile, RunBudget, RunCounters, SpawnContract } from './contracts';

export interface DelegationRequest {
  readonly parentProfile: AgentProfile;
  readonly childProfile: AgentProfile;
  readonly parentDepth: number;
  readonly maximumDepth: number;
  /** The parent's authorized caps and what it has consumed so far; the child is bounded by the remainder. */
  readonly parentBudget: RunBudget;
  readonly parentConsumed: { readonly counters: RunCounters; readonly elapsedMs: number };
}

export type DelegationDecision =
  | { readonly allowed: true; readonly depth: number; readonly budget: RunBudget }
  | { readonly allowed: false; readonly reason: string };

/** A child can only become less privileged than its parent and cannot lengthen the delegation tree. */
export function decideDelegation(request: DelegationRequest): DelegationDecision {
  const depth = request.parentDepth + 1;
  if (!Number.isInteger(request.parentDepth) || request.parentDepth < 0 || depth > request.maximumDepth) {
    return { allowed: false, reason: 'DELEGATION_DEPTH_EXCEEDED' };
  }
  if (request.childProfile.autonomyLevel > request.parentProfile.autonomyLevel) {
    return { allowed: false, reason: 'DELEGATION_AUTONOMY_EXCEEDED' };
  }
  if (!request.childProfile.capabilityGrants.every((grant) => request.parentProfile.capabilityGrants.includes(grant))) {
    return { allowed: false, reason: 'DELEGATION_CAPABILITY_ESCALATION' };
  }
  if (!request.childProfile.secretScopes.every((scope) => request.parentProfile.secretScopes.includes(scope))) {
    return { allowed: false, reason: 'DELEGATION_SECRET_ESCALATION' };
  }
  const remaining = remainingBudget(request.parentBudget, request.parentConsumed);
  if (!remaining || !withinBudget(request.childProfile.budgets, remaining)) {
    return { allowed: false, reason: 'DELEGATION_BUDGET_EXCEEDED' };
  }
  return { allowed: true, depth, budget: { ...request.childProfile.budgets } };
}

export function compileSpawnContract(input: Omit<SpawnContract, 'charter' | 'memoryScope' | 'capabilityGrants'>, profile: AgentProfile): SpawnContract {
  return {
    ...input,
    charter: profile.charter,
    memoryScope: profile.memoryScope,
    capabilityGrants: [...profile.capabilityGrants],
  };
}

/** Undefined when consumption is invalid (negative/non-finite), which fails delegation closed. */
export function remainingBudget(budget: RunBudget, consumed: DelegationRequest['parentConsumed']): RunBudget | undefined {
  const used = [consumed.elapsedMs, consumed.counters.costUsd, consumed.counters.actions, consumed.counters.failures, consumed.counters.iterations];
  if (!used.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
  return {
    maxDurationMs: budget.maxDurationMs - consumed.elapsedMs,
    maxCostUsd: budget.maxCostUsd - consumed.counters.costUsd,
    maxActions: budget.maxActions - consumed.counters.actions,
    maxFailures: budget.maxFailures - consumed.counters.failures,
    maxIterations: budget.maxIterations - consumed.counters.iterations,
  };
}

function withinBudget(child: RunBudget, parent: RunBudget): boolean {
  return (
    child.maxDurationMs <= parent.maxDurationMs &&
    child.maxCostUsd <= parent.maxCostUsd &&
    child.maxActions <= parent.maxActions &&
    child.maxFailures <= parent.maxFailures &&
    child.maxIterations <= parent.maxIterations
  );
}
