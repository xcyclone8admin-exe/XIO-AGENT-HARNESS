import type { CapabilityKind, ModuleManifest, Principal, RiskClass } from '@xyra/contracts';

export type PolicyDecision =
  | { readonly status: 'allow' }
  | { readonly status: 'deny'; readonly reason: string }
  | { readonly status: 'approval_required'; readonly policy: string };

export interface PolicyRequest {
  readonly principal: Principal;
  readonly workspaceId: string;
  readonly manifest: ModuleManifest;
  readonly permission: string;
  readonly kind: CapabilityKind;
  readonly risk: RiskClass;
  readonly sampleOnly?: boolean;
  readonly approvalPolicy?: string;
  /** A verified, scope-hashed approval supplied by the approval service. */
  readonly approvalVerified?: boolean;
  /** Computed server-side from the delegating user's current grants. Required for agents. */
  readonly delegatorPermissions?: ReadonlySet<string>;
  readonly killSwitchEngaged?: boolean;
}

/** A pure deny-first check; callers resolve identity, workspace and approval proofs on the trusted side. */
export function decidePolicy(request: PolicyRequest): PolicyDecision {
  const { principal, manifest, workspaceId, permission } = request;
  if (request.killSwitchEngaged && request.kind !== 'read')
    return { status: 'deny', reason: 'KILL_SWITCH_ENGAGED' };
  const membership = principal.workspaces.find((w) => w.id === workspaceId);
  if (!membership) return { status: 'deny', reason: 'WORKSPACE_NOT_GRANTED' };
  if (!manifest.permissions.includes(permission) || !permission.startsWith(`${manifest.id}:`)) {
    return { status: 'deny', reason: 'PERMISSION_UNDECLARED' };
  }
  if (request.sampleOnly && membership.kind !== 'sample') return { status: 'deny', reason: 'SAMPLE_ONLY' };
  if (membership.kind === 'sample' && request.kind === 'consequential')
    return { status: 'deny', reason: 'SAMPLE_OUTBOUND_DISABLED' };

  const roleAllows =
    membership.role === 'owner' ||
    membership.role === 'admin' ||
    manifest.roleGrants[membership.role]?.includes(permission);
  const explicitGrant = principal.grants.includes(permission);
  if (!roleAllows && !explicitGrant) return { status: 'deny', reason: 'PERMISSION_DENIED' };

  if (principal.kind === 'agent') {
    if (!principal.delegatedBy || !request.delegatorPermissions?.has(permission) || !explicitGrant) {
      return { status: 'deny', reason: 'DELEGATION_SCOPE' };
    }
    if ((principal.autonomy ?? 0) < (request.kind === 'read' ? 0 : request.kind === 'write' ? 2 : 3)) {
      return { status: 'deny', reason: 'AUTONOMY_CEILING' };
    }
  }

  if (
    (request.kind === 'consequential' ||
      request.risk === 'high' ||
      request.risk === 'critical' ||
      request.approvalPolicy) &&
    !request.approvalVerified
  ) {
    return { status: 'approval_required', policy: request.approvalPolicy ?? 'default.consequential' };
  }
  return { status: 'allow' };
}
