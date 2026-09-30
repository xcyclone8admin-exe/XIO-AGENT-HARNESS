/** Worker-internal types and limits. The sync wire contract lives in @xyra/contracts. */
/** Idempotency records are kept 7 days; a later replay is re-applied (field-LWW makes that safe). */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 3_600_000;
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_BLOB_TTL_SEC = 300;

export type CloudPrincipalKind = 'user' | 'agent';

/** Verified JWT claims are only a candidate scope; the Hub rechecks membership. */
export interface CandidateClaims {
  readonly principalId: string;
  readonly kind: CloudPrincipalKind;
  readonly tenantId: string;
  readonly workspaceIds: readonly string[];
  readonly activeWorkspaceId: string;
  readonly autonomy: 0 | 1 | 2 | 3 | 4;
  readonly expiresAtMs: number;
}

/** Current, server-provided membership material stored by the WorkspaceHub. */
export interface CurrentMembership {
  readonly principalId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly role: 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'auditor';
  readonly permissions: readonly string[];
  readonly revokedAtMs?: number;
}

export interface ActivePrincipal extends CandidateClaims {
  readonly membership: CurrentMembership;
}

export interface LeaseRecord {
  readonly key: string;
  readonly holder: string;
  readonly expiresAtMs: number;
}
