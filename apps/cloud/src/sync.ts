import { PushRequest as PushRequestSchema } from '@xyra/contracts';
import type { RowChange } from '@xyra/contracts';
import {
  MAX_HLC_DRIFT_MS,
  MAX_PULL_ROWS,
  MAX_PUSH_BYTES,
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  type ActivePrincipal,
  type ConflictRecord,
  type RejectionCode,
  type SequencedChange,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from './model';
import { TABLE_RULES, forbiddenField, hasPermission, type TableRule } from './tables';

interface ParsedHlc {
  readonly physical: number;
  readonly logical: number;
  readonly node: string;
}

type FieldWrite = RowChange['fields'][string];

interface StoredRow {
  readonly fields: Record<string, FieldWrite>;
  readonly deletedHlc?: string;
}

export interface SyncSnapshot {
  readonly seq: string;
  readonly rows: Record<string, StoredRow>;
  readonly log: readonly SequencedChange[];
  readonly idempotency: Readonly<Record<string, SyncPushResponse>>;
  readonly conflicts: readonly ConflictRecord[];
}

export function emptySyncSnapshot(): SyncSnapshot {
  return { seq: '0', rows: {}, log: [], idempotency: {}, conflicts: [] };
}

function parseHlc(value: string): ParsedHlc | null {
  // Shared encoding (packages/core hlc.ts): `<ms:13 digits>-<counter:4 hex>-<node>`.
  const match = /^(\d{13})-([0-9a-f]{4})-([a-z0-9]{1,32})$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { physical: Number(match[1]), logical: parseInt(match[2], 16), node: match[3] };
}

function compareHlc(left: string, right: string): number {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (!a || !b) throw new Error('invalid HLC passed to comparator');
  return a.physical - b.physical || a.logical - b.logical || a.node.localeCompare(b.node);
}

function keyFor(change: RowChange): string {
  return `${change.table}:${change.id}`;
}

function idempotencyKey(principal: ActivePrincipal, request: SyncPushRequest): string {
  return `${principal.tenantId}:${principal.activeWorkspaceId}:${principal.principalId}:${request.nodeId}:${request.idempotencyKey}`;
}

function encodeCursor(seq: bigint): string {
  return btoa(`v1:${seq.toString(10)}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeCursor(cursor: string | undefined): bigint | null {
  if (!cursor) return 0n;
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
  try {
    const digits = /^v1:(\d+)$/.exec(atob(padded))?.[1];
    return digits === undefined ? null : BigInt(digits);
  } catch {
    return null;
  }
}

function responseSize(request: SyncPushRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

export function parseSyncPush(input: unknown): SyncPushRequest | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Record<string, unknown>;
  if (
    candidate.protocolVersion !== SYNC_PROTOCOL_VERSION ||
    candidate.schemaVersion !== SYNC_SCHEMA_VERSION ||
    typeof candidate.nodeId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(candidate.nodeId) ||
    typeof candidate.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._-]{16,256}$/.test(candidate.idempotencyKey)
  ) {
    return null;
  }
  const parsed = PushRequestSchema.safeParse({ nodeId: candidate.nodeId, changes: candidate.changes });
  if (!parsed.success) return null;
  const request: SyncPushRequest = {
    protocolVersion: candidate.protocolVersion,
    schemaVersion: candidate.schemaVersion,
    nodeId: candidate.nodeId,
    idempotencyKey: candidate.idempotencyKey,
    changes: parsed.data.changes,
  };
  return responseSize(request) <= MAX_PUSH_BYTES ? request : null;
}

function reject(
  rejected: { index: number; changeId: string; code: RejectionCode }[],
  index: number,
  change: RowChange,
  code: RejectionCode,
): void {
  rejected.push({ index, changeId: change.id, code });
}

function validateChange(
  principal: ActivePrincipal,
  change: RowChange,
  nowMs: number,
): { rule: TableRule } | { code: RejectionCode } {
  if (change.tenantId !== principal.tenantId || change.workspaceId !== principal.activeWorkspaceId)
    return { code: 'AUTH_SCOPE_MISMATCH' };
  const rule = TABLE_RULES[change.table];
  if (!rule) return { code: 'UNKNOWN_TABLE' };
  if (rule.authority === 'server') return { code: 'SERVER_AUTHORITY' };
  if (rule.authority === 'local') return { code: 'LOCAL_ONLY' };
  if (rule.authority === 'append' && change.op !== 'append') return { code: 'APPEND_REQUIRED' };
  if (rule.authority === 'synced' && change.op === 'append') return { code: 'UPSERT_REQUIRED' };
  if (!hasPermission(principal.membership, rule.permission)) return { code: 'PERMISSION_DENIED' };
  const stamp = parseHlc(change.hlc);
  if (!stamp || stamp.physical > nowMs + MAX_HLC_DRIFT_MS) return { code: 'CLOCK_SKEW' };
  for (const [field, write] of Object.entries(change.fields)) {
    if (!parseHlc(write.hlc)) return { code: 'INVALID_ROW' };
    const fieldError = forbiddenField(rule, field);
    if (fieldError) return { code: fieldError };
  }
  return { rule };
}

function appendLog(log: SequencedChange[], seq: bigint, change: RowChange): void {
  log.push({ seq: seq.toString(10), change });
}

/** Pure field-LWW authority engine. Its snapshot is persisted atomically by WorkspaceHub. */
export class SyncAuthorityEngine {
  private seq: bigint;
  private readonly rows: Record<string, StoredRow>;
  private readonly log: SequencedChange[];
  private readonly idempotency: Record<string, SyncPushResponse>;
  private readonly conflicts: ConflictRecord[];

  constructor(snapshot: SyncSnapshot = emptySyncSnapshot()) {
    this.seq = BigInt(snapshot.seq);
    this.rows = structuredClone(snapshot.rows);
    this.log = [...structuredClone(snapshot.log)];
    this.idempotency = { ...structuredClone(snapshot.idempotency) };
    this.conflicts = [...structuredClone(snapshot.conflicts)];
  }

  snapshot(): SyncSnapshot {
    return {
      seq: this.seq.toString(10),
      rows: structuredClone(this.rows),
      log: structuredClone(this.log),
      idempotency: structuredClone(this.idempotency),
      conflicts: structuredClone(this.conflicts),
    };
  }

  push(principal: ActivePrincipal, request: SyncPushRequest, nowMs = Date.now()): SyncPushResponse {
    const replayKey = idempotencyKey(principal, request);
    const previous = this.idempotency[replayKey];
    if (previous) return { ...previous, replayed: true };

    const rejected: { index: number; changeId: string; code: RejectionCode }[] = [];
    const conflicts: ConflictRecord[] = [];
    let accepted = 0;
    for (const [index, change] of request.changes.entries()) {
      const authorization = validateChange(principal, change, nowMs);
      if ('code' in authorization) {
        reject(rejected, index, change, authorization.code);
        continue;
      }
      if (authorization.rule.authority === 'append') {
        const rowKey = keyFor(change);
        if (!this.rows[rowKey]) {
          this.rows[rowKey] = { fields: structuredClone(change.fields) };
          this.seq += 1n;
          appendLog(this.log, this.seq, change);
          accepted += 1;
        }
        continue;
      }

      const rowKey = keyFor(change);
      const current = this.rows[rowKey];
      if (change.op === 'delete') {
        const deleteChange: RowChange = { ...change, fields: {} };
        if (!current || !current.deletedHlc || compareHlc(change.hlc, current.deletedHlc) > 0) {
          this.rows[rowKey] = { fields: current?.fields ?? {}, deletedHlc: change.hlc };
          this.seq += 1n;
          appendLog(this.log, this.seq, deleteChange);
          accepted += 1;
        }
        continue;
      }
      if (current?.deletedHlc) {
        reject(rejected, index, change, 'TOMBSTONED');
        continue;
      }

      const existingFields = current?.fields ?? {};
      const nextFields = structuredClone(existingFields);
      const applied: Record<string, FieldWrite> = {};
      for (const [field, incoming] of Object.entries(change.fields)) {
        const existing = existingFields[field];
        if (existing && compareHlc(incoming.hlc, existing.hlc) <= 0) {
          const conflict: ConflictRecord = {
            table: change.table,
            rowId: change.id,
            field,
            winningHlc: existing.hlc,
            losingHlc: incoming.hlc,
            losingValue: incoming.value,
          };
          conflicts.push(conflict);
          this.conflicts.push(conflict);
          continue;
        }
        nextFields[field] = incoming;
        applied[field] = incoming;
      }
      if (Object.keys(applied).length > 0) {
        const acceptedChange: RowChange = { ...change, fields: applied };
        this.rows[rowKey] = { fields: nextFields };
        this.seq += 1n;
        appendLog(this.log, this.seq, acceptedChange);
        accepted += 1;
      }
    }
    const response: SyncPushResponse = {
      accepted,
      conflicts: conflicts.length,
      serverSeq: this.seq.toString(10),
      rejected,
      conflictHistory: conflicts,
      replayed: false,
    };
    this.idempotency[replayKey] = response;
    return response;
  }

  pull(cursor: string | undefined, pageSize = MAX_PULL_ROWS): SyncPullResponse | null {
    const after = decodeCursor(cursor);
    if (after === null || pageSize < 1 || pageSize > MAX_PULL_ROWS) return null;
    const pending = this.log.filter((entry) => BigInt(entry.seq) > after);
    const changes = pending.slice(0, pageSize);
    const last = changes.at(-1);
    return {
      changes,
      cursor: encodeCursor(last ? BigInt(last.seq) : after),
      more: pending.length > changes.length,
      serverSeq: this.seq.toString(10),
    };
  }
}
