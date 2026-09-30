import type { RowChange } from '@xyra/contracts';

/** Stable, Worker-owned wire contract. Shared contracts remain frozen. */
export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_SCHEMA_VERSION = 'cloud-sync-v1';
export const MAX_PUSH_BYTES = 1_000_000;
export const MAX_PULL_ROWS = 1_000;
export const MAX_HLC_DRIFT_MS = 5 * 60_000;
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

export interface SyncPushRequest {
  readonly protocolVersion: number;
  readonly schemaVersion: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
  readonly changes: readonly RowChange[];
}

export type RejectionCode =
  | 'AUTH_SCOPE_MISMATCH'
  | 'UNKNOWN_TABLE'
  | 'SERVER_AUTHORITY'
  | 'LOCAL_ONLY'
  | 'APPEND_REQUIRED'
  | 'UPSERT_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'IMMUTABLE_FIELD'
  | 'ACTOR_FIELD'
  | 'GUARDED_FIELD'
  | 'INVALID_ROW'
  | 'CLOCK_SKEW'
  | 'TOMBSTONED';

export interface SyncRejection {
  readonly index: number;
  readonly changeId: string;
  readonly code: RejectionCode;
}

export interface ConflictRecord {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;
  readonly winningHlc: string;
  readonly losingHlc: string;
  readonly losingValue: unknown;
}

export interface SequencedChange {
  readonly seq: string;
  readonly change: RowChange;
}

export interface SyncPushResponse {
  readonly accepted: number;
  readonly conflicts: number;
  readonly serverSeq: string;
  readonly rejected: readonly SyncRejection[];
  readonly conflictHistory: readonly ConflictRecord[];
  readonly replayed: boolean;
}

export interface SyncPullResponse {
  readonly changes: readonly SequencedChange[];
  readonly cursor: string;
  readonly more: boolean;
  readonly serverSeq: string;
}

export interface LeaseRecord {
  readonly key: string;
  readonly holder: string;
  readonly expiresAtMs: number;
}
