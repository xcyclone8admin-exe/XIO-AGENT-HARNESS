import { PushRequest as PushRequestSchema } from '@xyra/contracts';
import type { RowChange } from '@xyra/contracts';
import {
  IDEMPOTENCY_RETENTION_MS,
  MAX_HLC_DRIFT_MS,
  MAX_PULL_ROWS,
  MAX_PUSH_BYTES,
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  type ActivePrincipal,
  type ConflictRecord,
  type RejectionCode,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from './model';
import { MemorySyncStore, type FieldWrite, type StoredConflict, type SyncStorePort } from './store';
import { TABLE_RULES, forbiddenField, hasPermission, type TableRule } from './tables';

interface ParsedHlc {
  readonly physical: number;
  readonly logical: number;
  readonly node: string;
}

/** Same key, different payload (ADR-0003 idempotency): surfaced as HTTP 409 by the Hub. */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED');
  }
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
  return a.physical - b.physical || a.logical - b.logical || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
}

function keyFor(change: RowChange): string {
  return `${change.table}:${change.id}`;
}

function idempotencyKey(principal: ActivePrincipal, request: SyncPushRequest): string {
  return `${principal.tenantId}:${principal.activeWorkspaceId}:${principal.principalId}:${request.nodeId}:${request.idempotencyKey}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 (hex) of the canonical request body, excluding the idempotency key itself. */
export async function hashRequest(request: SyncPushRequest): Promise<string> {
  const { idempotencyKey: _key, ...body } = request;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(body)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Synchronous stand-in used when a caller has no precomputed hash (in-memory tests). */
function fallbackHash(request: SyncPushRequest): string {
  const { idempotencyKey: _key, ...body } = request;
  return canonical(body);
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

function requestSize(request: SyncPushRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

export function parseSyncPush(input: unknown): SyncPushRequest | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Record<string, unknown>;
  if (
    candidate['protocolVersion'] !== SYNC_PROTOCOL_VERSION ||
    candidate['schemaVersion'] !== SYNC_SCHEMA_VERSION ||
    typeof candidate['nodeId'] !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(candidate['nodeId']) ||
    typeof candidate['idempotencyKey'] !== 'string' ||
    !/^[A-Za-z0-9._-]{16,256}$/.test(candidate['idempotencyKey'])
  ) {
    return null;
  }
  const parsed = PushRequestSchema.safeParse({ nodeId: candidate['nodeId'], changes: candidate['changes'] });
  if (!parsed.success) return null;
  const request: SyncPushRequest = {
    protocolVersion: candidate['protocolVersion'],
    schemaVersion: candidate['schemaVersion'],
    nodeId: candidate['nodeId'],
    idempotencyKey: candidate['idempotencyKey'],
    changes: parsed.data.changes,
  };
  return requestSize(request) <= MAX_PUSH_BYTES ? request : null;
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

/** Server-stamped author on insert makes a row attributable to its verified principal. */
function stampActor(change: RowChange, rule: TableRule, principal: ActivePrincipal): RowChange {
  if (!rule.actorField) return change;
  return {
    ...change,
    fields: {
      ...change.fields,
      [rule.actorField]: { value: principal.principalId, hlc: change.hlc, baseHlc: null },
    },
  };
}

/**
 * Pure field-LWW authority engine over a storage port. The caller (WorkspaceHub) must run
 * push() inside a single storage transaction so rows, log, seq, conflicts and the
 * idempotency record commit or roll back together.
 */
export class SyncAuthorityEngine {
  constructor(readonly store: SyncStorePort = new MemorySyncStore()) {}

  /** Test helper; only meaningful for the in-memory store. */
  snapshot(): ReturnType<MemorySyncStore['snapshot']> {
    if (!(this.store instanceof MemorySyncStore)) throw new Error('snapshot() requires MemorySyncStore');
    return this.store.snapshot();
  }

  push(
    principal: ActivePrincipal,
    request: SyncPushRequest,
    nowMs = Date.now(),
    requestHash = fallbackHash(request),
  ): SyncPushResponse {
    const store = this.store;
    const replayKey = idempotencyKey(principal, request);
    store.pruneIdempotency(nowMs - IDEMPOTENCY_RETENTION_MS);
    const previous = store.getIdempotency(replayKey);
    if (previous) {
      if (previous.hash !== requestHash) throw new IdempotencyKeyReusedError();
      return { ...previous.response, replayed: true };
    }

    const rejected: { index: number; changeId: string; code: RejectionCode }[] = [];
    const conflicts: ConflictRecord[] = [];
    let accepted = 0;
    for (const [index, change] of request.changes.entries()) {
      const authorization = validateChange(principal, change, nowMs);
      if ('code' in authorization) {
        rejected.push({ index, changeId: change.id, code: authorization.code });
        continue;
      }
      const rowKey = keyFor(change);
      const current = store.getRow(rowKey);

      if (authorization.rule.authority === 'append') {
        if (!current) {
          const stamped = stampActor(change, authorization.rule, principal);
          store.putRow(rowKey, { fields: stamped.fields });
          store.appendLog(stamped);
          accepted += 1;
        }
        continue;
      }

      if (change.op === 'delete') {
        if (!current?.deletedHlc || compareHlc(change.hlc, current.deletedHlc) > 0) {
          store.putRow(rowKey, { fields: current?.fields ?? {}, deletedHlc: change.hlc });
          store.appendLog({ ...change, fields: {} });
          accepted += 1;
        }
        continue;
      }
      if (current?.deletedHlc) {
        rejected.push({ index, changeId: change.id, code: 'TOMBSTONED' });
        continue;
      }

      const incomingChange = current ? change : stampActor(change, authorization.rule, principal);
      const existingFields = current?.fields ?? {};
      const nextFields: Record<string, FieldWrite> = { ...existingFields };
      const applied: Record<string, FieldWrite> = {};
      for (const [field, incoming] of Object.entries(incomingChange.fields)) {
        const existing = existingFields[field];
        if (existing) {
          const order = compareHlc(incoming.hlc, existing.hlc);
          // An identical re-delivery (same HLC, same value) is a no-op, not a conflict.
          if (order === 0 && canonical(incoming.value) === canonical(existing.value)) continue;
          if (order <= 0) {
            const conflict: ConflictRecord = {
              table: change.table,
              rowId: change.id,
              field,
              winningHlc: existing.hlc,
              losingHlc: incoming.hlc,
              losingValue: incoming.value,
            };
            conflicts.push(conflict);
            store.addConflict(conflict);
            continue;
          }
        }
        nextFields[field] = incoming;
        applied[field] = incoming;
      }
      if (Object.keys(applied).length > 0) {
        store.putRow(rowKey, { fields: nextFields });
        store.appendLog({ ...change, fields: applied });
        accepted += 1;
      }
    }
    const response: SyncPushResponse = {
      accepted,
      conflicts: conflicts.length,
      serverSeq: store.serverSeq().toString(10),
      rejected,
      conflictHistory: conflicts,
      replayed: false,
    };
    store.putIdempotency(replayKey, { hash: requestHash, response, atMs: nowMs });
    return response;
  }

  pull(cursor: string | undefined, pageSize = MAX_PULL_ROWS): SyncPullResponse | null {
    const after = decodeCursor(cursor);
    if (after === null || pageSize < 1 || pageSize > MAX_PULL_ROWS) return null;
    const fetched = this.store.readLog(after, pageSize + 1);
    const changes = fetched.slice(0, pageSize);
    const last = changes.at(-1);
    return {
      changes,
      cursor: encodeCursor(last ? BigInt(last.seq) : after),
      more: fetched.length > changes.length,
      serverSeq: this.store.serverSeq().toString(10),
    };
  }

  /** Conflict history is retained indefinitely (REQ-DATA-008) and read in pages. */
  conflictPage(afterId: number, limit: number): { items: StoredConflict[]; more: boolean } | null {
    if (!Number.isInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      return null;
    const fetched = this.store.readConflicts(afterId, limit + 1);
    return { items: fetched.slice(0, limit), more: fetched.length > limit };
  }
}
