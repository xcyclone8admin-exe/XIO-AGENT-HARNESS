/** Worker-internal types and limits. The sync wire contract lives in @xyra/contracts. */
/** Idempotency records are kept 7 days; a later replay is re-applied (field-LWW makes that safe). */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 3_600_000;
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_BLOB_TTL_SEC = 300;
/** Conflict history carried inline in a push response; the rest is paged from /v1/sync/conflicts. */
export const MAX_INLINE_CONFLICT_BYTES = 256_000;
/** Rows examined per pull page before returning `more: true` even if nothing was readable. */
export const MAX_PULL_SCAN_ROWS = 5_000;

export type CloudPrincipalKind = 'user' | 'agent';
export type WorkspaceRoleName = 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'auditor';

/** Verified JWT claims are only a candidate scope; the Hub rechecks membership. */
export interface CandidateClaims {
  readonly principalId: string;
  readonly kind: CloudPrincipalKind;
  readonly tenantId: string;
  readonly workspaceIds: readonly string[];
  readonly activeWorkspaceId: string;
  readonly autonomy: 0 | 1 | 2 | 3 | 4;
  readonly expiresAtMs: number;
  /** RFC 7638 thumbprint of the non-exportable per-device DPoP public key. */
  readonly deviceThumbprint: string;
  /** Authenticated device (issuer-bound); required for execution leases. */
  readonly deviceId?: string;
  /** Agents only: the delegating user; must match the Hub's current record. */
  readonly delegatedBy?: string;
  readonly runId?: string;
}

/** Current, server-provided membership material stored by the WorkspaceHub. */
export interface CurrentMembership {
  readonly principalId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRoleName;
  /** Explicit grants (custom roles, agent profile grants). */
  readonly permissions: readonly string[];
  readonly kind?: CloudPrincipalKind;
  /** Agents: the delegating user and the autonomy ceiling currently granted to the agent. */
  readonly delegatedBy?: string;
  readonly autonomy?: 0 | 1 | 2 | 3 | 4;
  readonly workspaceKind?: 'standard' | 'sample';
  readonly revokedAtMs?: number;
}

export interface ActivePrincipal extends CandidateClaims {
  readonly membership: CurrentMembership;
}

export interface LeaseRecord {
  readonly key: string;
  readonly principalId: string;
  readonly deviceId: string;
  /** Opaque bearer of this specific grant; renew/release must present it. */
  readonly token: string;
  /** Monotonic across the workspace; a newer grant always carries a larger fence. */
  readonly fence: number;
  readonly expiresAtMs: number;
}
