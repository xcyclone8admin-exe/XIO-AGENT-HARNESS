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

const ChangeFieldNames = z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(256).superRefine((fields, context) => {
  if (new Set(fields).size !== fields.length) {
    context.addIssue({ code: 'custom', message: 'Outcome field names must be unique' });
  }
  if (fields.some((field, index) => index > 0 && fields[index - 1]! >= field)) {
    context.addIssue({ code: 'custom', message: 'Outcome field names must be sorted' });
  }
});

/** Durable per-change result. `index` binds duplicate change IDs unambiguously to this request. */
export const PushChangeOutcome = z.strictObject({
  index: z.number().int().nonnegative(),
  changeId: z.uuid(),
  table: z.string().regex(/^[a-z][a-z0-9_]*$/),
  rowId: z.uuid(),
  outcome: z.enum(['committed', 'unchanged', 'conflict', 'rejected']),
  appliedFields: ChangeFieldNames,
  unchangedFields: ChangeFieldNames,
  conflictedFields: ChangeFieldNames,
  rejectionCode: SyncRejectionCode.optional(),
}).superRefine((value, context) => {
  const applied = new Set(value.appliedFields);
  if (value.unchangedFields.some((field) => applied.has(field)) || value.conflictedFields.some((field) => applied.has(field))) {
    context.addIssue({ code: 'custom', message: 'Outcome field dispositions must not overlap' });
  }
  if (value.unchangedFields.some((field) => value.conflictedFields.includes(field))) {
    context.addIssue({ code: 'custom', message: 'Outcome field dispositions must not overlap' });
  }
  if (value.outcome === 'rejected') {
    if (!value.rejectionCode || value.appliedFields.length || value.unchangedFields.length || value.conflictedFields.length) {
      context.addIssue({ code: 'custom', message: 'Rejected outcome requires only a rejection code' });
    }
  } else if (value.rejectionCode !== undefined) {
    context.addIssue({ code: 'custom', message: 'Non-rejected outcome cannot carry a rejection code' });
  }
  if (value.outcome === 'unchanged' && (value.appliedFields.length || value.conflictedFields.length)) {
    context.addIssue({ code: 'custom', message: 'Unchanged outcome cannot apply or lose fields' });
  }
  if (value.outcome === 'conflict' && (value.appliedFields.length || !value.conflictedFields.length)) {
    context.addIssue({ code: 'custom', message: 'Conflict outcome requires lost fields and no applied fields' });
  }
});
export type PushChangeOutcome = z.infer<typeof PushChangeOutcome>;

/** Server sequence numbers are decimal strings; they exceed 2^53 over a workspace's life. */
const Seq = z.string().regex(/^\d{1,20}$/);

export const PushResponse = z.strictObject({
  accepted: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  serverSeq: Seq,
  rejected: z.array(SyncRejection),
  conflictHistory: z.array(ConflictRecord),
  /** Additive during rollout; acknowledgement consumers fail closed when omitted. */
  changeOutcomes: z.array(PushChangeOutcome).max(MAX_PUSH_ROWS).optional(),
  replayed: z.boolean(),
});
export type PushResponse = z.infer<typeof PushResponse>;

/**
 * Bind every row outcome to the exact request and ensure the aggregate summary agrees.
 * This does not itself authorize a workflow: callers must also verify expected scope, rows,
 * fields and digests and keep uncertain outcomes pending.
 */
export function assertPushResponseBoundToRequest(request: PushRequest, response: PushResponse): void {
  const parsedResponse = PushResponse.parse(response);
  if (!parsedResponse.changeOutcomes || parsedResponse.changeOutcomes.length !== request.changes.length) {
    throw new TypeError('SYNC_OUTCOME_COVERAGE_MISMATCH');
  }
  const rejectedByIndex = new Map(parsedResponse.rejected.map((item) => [item.index, item]));
  if (rejectedByIndex.size !== parsedResponse.rejected.length) throw new TypeError('SYNC_REJECTION_INDEX_DUPLICATE');
  let committed = 0;
  for (const [index, change] of request.changes.entries()) {
    const outcome = parsedResponse.changeOutcomes[index];
    if (
      !outcome || outcome.index !== index || outcome.changeId !== change.id ||
      outcome.table !== change.table || outcome.rowId !== change.id
    ) throw new TypeError('SYNC_OUTCOME_REQUEST_MISMATCH');
    const rejected = rejectedByIndex.get(index);
    if (outcome.outcome === 'rejected') {
      if (!rejected || rejected.changeId !== change.id || rejected.code !== outcome.rejectionCode) {
        throw new TypeError('SYNC_OUTCOME_REJECTION_MISMATCH');
      }
      if (outcome.appliedFields.length || outcome.unchangedFields.length || outcome.conflictedFields.length) {
        throw new TypeError('SYNC_REJECTED_FIELDS_MISMATCH');
      }
      continue;
    }
    if (rejected) throw new TypeError('SYNC_OUTCOME_REJECTION_MISMATCH');
    const requestedFields = Object.keys(change.fields).sort();
    const dispositions = [
      ...outcome.appliedFields,
      ...outcome.unchangedFields,
      ...outcome.conflictedFields,
    ].sort();
    if (dispositions.length !== requestedFields.length || dispositions.some((field, i) => field !== requestedFields[i])) {
      throw new TypeError('SYNC_OUTCOME_FIELDS_MISMATCH');
    }
    if (outcome.outcome === 'committed' && change.op !== 'delete' && outcome.appliedFields.length === 0) {
      throw new TypeError('SYNC_COMMITTED_WITHOUT_APPLIED_FIELDS');
    }
    if (outcome.outcome === 'committed') committed += 1;
  }
  if (parsedResponse.rejected.some((item) => item.index >= request.changes.length)) {
    throw new TypeError('SYNC_REJECTION_INDEX_OUT_OF_RANGE');
  }
  if (parsedResponse.accepted !== committed) throw new TypeError('SYNC_ACCEPTED_COUNT_MISMATCH');
}

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
