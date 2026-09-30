import { z } from 'zod';

/**
 * Sync wire contract `cloud-sync-v1` (ADR-0003) shared by the sidecar sync
 * client and the Worker. A version or schema mismatch is rejected whole.
 */
export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_SCHEMA_VERSION = 'cloud-sync-v1';
export const MAX_PUSH_ROWS = 500;
export const MAX_PUSH_BYTES = 1_000_000;
export const MAX_PULL_ROWS = 1_000;
/** Serialized pull-page budget; a page always carries at least one change. */
export const MAX_PULL_BYTES = 4_000_000;
/** Serialized merged row incl. field clocks; larger rows reject as ROW_TOO_LARGE. */
export const MAX_ROW_BYTES = 1_000_000;
/** Equals MAX_DRIFT_MS in packages/core hlc.ts (asserted in sync.test.ts). */
export const MAX_HLC_DRIFT_MS = 5 * 60_000;

/**
 * HLC encoding `<ms:13 digits>-<counter:4 hex>-<node>` (packages/core hlc.ts).
 * Fixed widths make plain code-point string order the total order; never
 * compare with localeCompare.
 */
export const HLC_PATTERN = /^\d{13}-[0-9a-f]{4}-[a-z0-9]{1,32}$/;
export const Hlc = z.string().regex(HLC_PATTERN);

/** One field write carries its HLC and the HLC it was based on. */
export const FieldWrite = z.object({ value: z.unknown(), hlc: Hlc, baseHlc: Hlc.nullable() });
export const RowChange = z.object({
  table: z.string().regex(/^[a-z][a-z0-9_]*$/),
  id: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  /** lww: per-field writes; append: full immutable row; delete: tombstone. */
  op: z.enum(['upsert', 'append', 'delete']),
  fields: z.record(z.string(), FieldWrite),
  hlc: Hlc,
});
export type RowChange = z.infer<typeof RowChange>;

/**
 * The Worker counts streamed request bytes against MAX_PUSH_BYTES before JSON parsing and
 * checks protocolVersion/schemaVersion before parsing rows (426 SyncUpdateRequired).
 */
export const PushRequest = z.object({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  nodeId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  /** Retrying with the same key returns the saved result; a different payload is refused. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._-]{16,256}$/),
  changes: z.array(RowChange).max(MAX_PUSH_ROWS),
});
export type PushRequest = z.infer<typeof PushRequest>;

/** Per-row outcomes; one rejected row never aborts the rest of the push. */
export const SyncRejectionCode = z.enum([
  'AUTH_SCOPE_MISMATCH',
  'UNKNOWN_TABLE',
  'SERVER_AUTHORITY',
  'LOCAL_ONLY',
  'APPEND_REQUIRED',
  'UPSERT_REQUIRED',
  'PERMISSION_DENIED',
  'IMMUTABLE_FIELD',
  'ACTOR_FIELD',
  'GUARDED_FIELD',
  'INVALID_ROW',
  'CLOCK_SKEW',
  'TOMBSTONED',
  'KILL_SWITCH_ENGAGED',
  'SCHEMA_VIOLATION',
  'ORPHAN_REFERENCE',
  'ROW_TOO_LARGE',
  'POLICY_DENIED',
]);
export type SyncRejectionCode = z.infer<typeof SyncRejectionCode>;

export const SyncRejection = z.object({
  index: z.number().int().nonnegative(),
  changeId: z.uuid(),
  code: SyncRejectionCode,
  /** Machine reason, e.g. the policy decision (AUTONOMY_CEILING) or the violated column. */
  reason: z.string().max(64).optional(),
});
export type SyncRejection = z.infer<typeof SyncRejection>;

/** The losing value of a field conflict is retained, never discarded (REQ-DATA-008). */
export const ConflictRecord = z.object({
  table: z.string(),
  rowId: z.uuid(),
  field: z.string(),
  winningHlc: Hlc,
  losingHlc: Hlc,
  losingValue: z.unknown(),
});
export type ConflictRecord = z.infer<typeof ConflictRecord>;

/** Server sequence numbers are decimal strings; they exceed 2^53 over a workspace's life. */
const Seq = z.string().regex(/^\d{1,20}$/);

export const PushResponse = z.object({
  accepted: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  serverSeq: Seq,
  rejected: z.array(SyncRejection),
  conflictHistory: z.array(ConflictRecord),
  replayed: z.boolean(),
});
export type PushResponse = z.infer<typeof PushResponse>;

export const SequencedChange = z.object({ seq: Seq, change: RowChange });
export type SequencedChange = z.infer<typeof SequencedChange>;

/** Pull query string; versions are checked before the cursor. */
export const PullRequest = z.object({
  protocolVersion: z.coerce.number().pipe(z.literal(SYNC_PROTOCOL_VERSION)),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_ROWS).optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PullResponse = z.object({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  changes: z.array(SequencedChange).max(MAX_PULL_ROWS),
  /** Opaque and resumable; clients echo it back unchanged. */
  cursor: z.string().min(1),
  more: z.boolean(),
  serverSeq: Seq,
});
export type PullResponse = z.infer<typeof PullResponse>;

/** HTTP 426 on push or pull when the client's versions are missing or mismatched; sync stops safely. */
export const SyncUpdateRequired = z.object({
  code: z.literal('UPDATE_REQUIRED'),
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
});
export type SyncUpdateRequired = z.infer<typeof SyncUpdateRequired>;
