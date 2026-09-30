import type { AgentProfile, RunBudget, SpawnContract } from './contracts';

export interface DelegationRequest {
  readonly parentProfile: AgentProfile;
  readonly childProfile: AgentProfile;
  readonly parentDepth: number;
  readonly maximumDepth: number;
  readonly parentRemainingBudget: RunBudget;
}

export type DelegationDecision = { readonly allowed: true; readonly depth: number } | { readonly allowed: false; readonly reason: string };

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
  if (!withinBudget(request.childProfile.budgets, request.parentRemainingBudget)) {
    return { allowed: false, reason: 'DELEGATION_BUDGET_EXCEEDED' };
  }
  return { allowed: true, depth };
}

export function compileSpawnContract(input: Omit<SpawnContract, 'charter' | 'memoryScope' | 'capabilityGrants'>, profile: AgentProfile): SpawnContract {
  return {
    ...input,
    charter: profile.charter,
    memoryScope: profile.memoryScope,
    capabilityGrants: [...profile.capabilityGrants],
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
