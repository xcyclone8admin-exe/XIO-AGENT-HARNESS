import type { AgentProfile } from './contracts';

export type RunAccessRequest =
  | { readonly dimension: 'capability'; readonly id: string }
  | { readonly dimension: 'secret'; readonly id: string }
  | { readonly dimension: 'network'; readonly host: string }
  | { readonly dimension: 'filesystem'; readonly path: string }
  | { readonly dimension: 'budget'; readonly estimatedCostUsd: number; readonly remainingCostUsd: number };

export type RunAccessDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Per-run containment checks supplement the authoritative Capability Bus policy decision. */
export function decideRunAccess(profile: AgentProfile, request: RunAccessRequest): RunAccessDecision {
  switch (request.dimension) {
    case 'capability':
      return profile.capabilityGrants.includes(request.id)
        ? { allowed: true }
        : { allowed: false, reason: 'CAPABILITY_NOT_GRANTED' };
    case 'secret':
      return profile.secretScopes.includes(request.id)
        ? { allowed: true }
        : { allowed: false, reason: 'SECRET_SCOPE_DENIED' };
    case 'network':
      return profile.networkPolicy.mode === 'allow-list' && profile.networkPolicy.allowedHosts.includes(request.host)
        ? { allowed: true }
        : { allowed: false, reason: 'NETWORK_SCOPE_DENIED' };
    case 'filesystem':
      return profile.filesystemPolicy.mode !== 'none' && profile.filesystemPolicy.allowedPaths.includes(request.path)
        ? { allowed: true }
        : { allowed: false, reason: 'FILESYSTEM_SCOPE_DENIED' };
    case 'budget':
      return Number.isFinite(request.estimatedCostUsd) && request.estimatedCostUsd >= 0 && request.estimatedCostUsd <= request.remainingCostUsd
        ? { allowed: true }
        : { allowed: false, reason: 'BUDGET_EXCEEDED' };
  }
}
