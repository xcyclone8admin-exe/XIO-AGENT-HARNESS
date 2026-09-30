import type { CapabilityKind, ModuleManifest, Principal } from '@xyra/contracts';
import { decidePolicy } from '@xyra/policy';
import type { CandidateClaims, CurrentMembership } from './model';
import { MANIFESTS } from './tables';

/**
 * Trusted-side access context for one request: verified claims, the Hub's current record for the
 * caller and (for agents) the delegating user's current record. Nothing here comes from the body.
 */
export interface AccessContext {
  readonly claims: CandidateClaims;
  readonly membership: CurrentMembership;
  /** Agents only; undefined when the delegator has no current membership (fails closed). */
  readonly delegator?: CurrentMembership | undefined;
  readonly killSwitchEngaged: boolean;
}

export type AccessDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'PERMISSION_DENIED' | 'POLICY_DENIED'; readonly reason: string };

const ALLOW: AccessDecision = { ok: true };
const deny = (code: 'PERMISSION_DENIED' | 'POLICY_DENIED', reason: string): AccessDecision => ({
  ok: false,
  code,
  reason,
});

/** Owner/admin hold every declared permission; others hold role grants plus explicit grants. */
export function effectivePermissions(record: CurrentMembership): ReadonlySet<string> {
  const all = new Set<string>(record.permissions);
  for (const manifest of MANIFESTS) {
    const granted =
      record.role === 'owner' || record.role === 'admin'
        ? manifest.permissions
        : (manifest.roleGrants[record.role] ?? []);
    for (const permission of granted) all.add(permission);
  }
  return all;
}

/**
 * Resolves the trusted Principal the shared policy expects. Returns null (deny) whenever the
 * verified claims and the Hub's current record disagree about who or what the caller is.
 */
export function trustedPrincipal(context: AccessContext): Principal | null {
  const { claims, membership } = context;
  const kind = membership.kind ?? 'user';
  if (kind !== claims.kind) return null;
  const base = {
    id: claims.principalId,
    tenantId: claims.tenantId,
    workspaces: [
      { id: membership.workspaceId, role: membership.role, kind: membership.workspaceKind ?? 'standard' },
    ],
    grants: [...membership.permissions],
  };
  if (kind === 'user') return { ...base, kind };
  if (!membership.delegatedBy || claims.delegatedBy !== membership.delegatedBy) return null;
  // The effective ceiling is the lower of what the token says and what the agent is granted now.
  const autonomy = Math.min(claims.autonomy, membership.autonomy ?? 0) as Principal['autonomy'];
  return {
    ...base,
    kind,
    delegatedBy: membership.delegatedBy,
    autonomy,
    ...(claims.runId ? { runId: claims.runId } : {}),
  };
}

/**
 * The same deny-first decision live capabilities use (packages/policy decidePolicy), applied to a
 * synced read or write. `permission` undefined means the manifest declares none for this table.
 */
export function decideAccess(
  context: AccessContext,
  manifest: ModuleManifest,
  permission: string | undefined,
  kind: Extract<CapabilityKind, 'read' | 'write'>,
): AccessDecision {
  const principal = trustedPrincipal(context);
  if (!principal) return deny('POLICY_DENIED', 'PRINCIPAL_MISMATCH');
  if (principal.kind === 'agent') {
    const delegator = context.delegator;
    if (!delegator || (delegator.kind ?? 'user') !== 'user') return deny('POLICY_DENIED', 'DELEGATION_SCOPE');
    // Without a declared permission there is nothing to intersect with the delegator: fail closed.
    if (permission === undefined) return deny('POLICY_DENIED', 'DELEGATION_SCOPE');
  } else if (permission === undefined) {
    if (kind === 'read') return ALLOW;
    const role = context.membership.role;
    return role === 'viewer' || role === 'auditor' ? deny('PERMISSION_DENIED', 'READ_ONLY_ROLE') : ALLOW;
  }
  const decision = decidePolicy({
    principal,
    workspaceId: context.membership.workspaceId,
    manifest,
    permission,
    kind,
    risk: 'low',
    ...(context.delegator ? { delegatorPermissions: effectivePermissions(context.delegator) } : {}),
    // The kill switch stops agents; humans keep working (lead decision, WP-CLOUD R3).
    killSwitchEngaged: context.killSwitchEngaged && principal.kind === 'agent',
  });
  if (decision.status === 'allow') return ALLOW;
  if (decision.status === 'approval_required') return deny('POLICY_DENIED', 'APPROVAL_REQUIRED');
  return ['DELEGATION_SCOPE', 'AUTONOMY_CEILING', 'KILL_SWITCH_ENGAGED'].includes(decision.reason)
    ? deny('POLICY_DENIED', decision.reason)
    : deny('PERMISSION_DENIED', decision.reason);
}
