import {
  MAX_HLC_DRIFT_MS,
  MAX_PULL_BYTES,
  MAX_PULL_ROWS,
  MAX_ROW_BYTES,
  PushRequest as PushRequestSchema,
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  type ConflictRecord,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type RowChange,
  type SyncRejection,
  type SyncRejectionCode,
} from '@xyra/contracts';
import { decideAccess, type AccessContext } from './access';
import { IDEMPOTENCY_RETENTION_MS, MAX_INLINE_CONFLICT_BYTES, MAX_PULL_SCAN_ROWS } from './model';
import { checkRow } from './schema';
import {
  MemorySyncStore,
  byteLength,
  type FieldWrite,
  type StoredConflict,
  type SyncStorePort,
} from './store';
import { TABLE_RULES, forbiddenField, ruleFor, type TableRule } from './tables';

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

function parseHlc(value: string | null | undefined): ParsedHlc | null {
  // Shared encoding (packages/core hlc.ts): `<ms:13 digits>-<counter:4 hex>-<node>`.
  const match = /^(\d{13})-([0-9a-f]{4})-([a-z0-9]{1,32})$/.exec(value ?? '');
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { physical: Number(match[1]), logical: parseInt(match[2], 16), node: match[3] };
}

/** Plain code-point order on the fixed-width encoding: identical to packages/core compareHlc. */
export function compareHlc(left: string, right: string): number {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (!a || !b) throw new Error('invalid HLC passed to comparator');
  return a.physical - b.physical || a.logical - b.logical || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
}

function keyFor(table: string, id: string): string {
  return `${table}:${id}`;
}

function idempotencyKey(access: AccessContext, request: PushRequest): string {
  const { claims } = access;
  return `${claims.tenantId}:${claims.activeWorkspaceId}:${claims.principalId}:${request.nodeId}:${request.idempotencyKey}`;
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
export async function hashRequest(request: PushRequest): Promise<string> {
  const { idempotencyKey: _key, ...body } = request;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(body)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Synchronous stand-in used when a caller has no precomputed hash (in-memory tests). */
function fallbackHash(request: PushRequest): string {
  const { idempotencyKey: _key, ...body } = request;
  return canonical(body);
}

/** Version identity is checked before any row is parsed (ADR-0003 A1 §G). */
export function versionsSupported(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Record<string, unknown>;
  return (
    candidate['protocolVersion'] === SYNC_PROTOCOL_VERSION &&
    candidate['schemaVersion'] === SYNC_SCHEMA_VERSION
  );
}

/** Transport bytes are capped by the caller before JSON parsing (CLD-R-008). */
export function parseSyncPush(input: unknown): PushRequest | null {
  const parsed = PushRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------- cursors

/** Short, stable fingerprint of the tables a caller may read; not a security token. */
function scopeFingerprint(readable: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of readable.join(',')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function encodeCursor(seq: bigint, scope: string): string {
  return btoa(`v2:${seq.toString(10)}:${scope}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

type DecodedCursor = { readonly seq: bigint; readonly scope: string | null } | null;

function decodeCursor(cursor: string | undefined): DecodedCursor {
  if (!cursor) return { seq: 0n, scope: null };
  if (cursor.length > 512) return null;
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
  try {
    const match = /^v2:(\d{1,20}):([0-9a-f]{8})$/.exec(atob(padded));
    return match?.[1] && match[2] ? { seq: BigInt(match[1]), scope: match[2] } : null;
  } catch {
    return null;
  }
}

export type PullOutcome =
  | { readonly ok: true; readonly response: PullResponse }
  | { readonly ok: false; readonly code: 'INVALID_CURSOR' | 'RESYNC_REQUIRED' };

// ---------------------------------------------------------------- validation

type Validated =
  { readonly rule: TableRule } | { readonly code: SyncRejectionCode; readonly reason?: string };

function validateClocks(change: RowChange, nowMs: number): SyncRejectionCode | null {
  const horizon = nowMs + MAX_HLC_DRIFT_MS;
  const row = parseHlc(change.hlc);
  if (!row || row.physical > horizon) return 'CLOCK_SKEW';
  for (const write of Object.values(change.fields)) {
    const field = parseHlc(write.hlc);
    // Every clock used for ordering is bounded, and a field clock may not exceed its row clock.
    if (!field || field.physical > horizon) return 'CLOCK_SKEW';
    if (compareHlc(write.hlc, change.hlc) > 0) return 'CLOCK_SKEW';
    if (write.baseHlc !== null) {
      if (!parseHlc(write.baseHlc)) return 'INVALID_ROW';
      if (compareHlc(write.baseHlc, write.hlc) >= 0) return 'CLOCK_SKEW';
    }
  }
  return null;
}

function validateChange(access: AccessContext, change: RowChange, nowMs: number): Validated {
  const { claims } = access;
  if (change.tenantId !== claims.tenantId || change.workspaceId !== claims.activeWorkspaceId)
    return { code: 'AUTH_SCOPE_MISMATCH' };
  const rule = ruleFor(change.table);
  if (!rule) return { code: 'UNKNOWN_TABLE' };
  if (rule.authority === 'server') return { code: 'SERVER_AUTHORITY' };
  if (rule.authority === 'local') return { code: 'LOCAL_ONLY' };
  if (rule.authority === 'append' && change.op !== 'append') return { code: 'APPEND_REQUIRED' };
  if (rule.authority === 'synced' && change.op === 'append') return { code: 'UPSERT_REQUIRED' };
  const decision = decideAccess(access, rule.manifest, rule.permission, 'write');
  if (!decision.ok) return { code: decision.code, reason: decision.reason };
  const clock = validateClocks(change, nowMs);
  if (clock) return { code: clock };
  if (change.op === 'delete' && Object.keys(change.fields).length > 0) return { code: 'INVALID_ROW' };
  for (const field of Object.keys(change.fields)) {
    const fieldError = forbiddenField(rule, field);
    if (fieldError) return { code: fieldError };
  }
  return { rule };
}

/** Server stamps on insert: verified actor and receipt time (never device-supplied). */
function stamps(
  rule: TableRule,
  access: AccessContext,
  hlc: string,
  nowMs: number,
): Record<string, FieldWrite> {
  const stamped: Record<string, FieldWrite> = {};
  if (rule.actorField) stamped[rule.actorField] = { value: access.claims.principalId, hlc, baseHlc: null };
  if (rule.receivedAtField)
    stamped[rule.receivedAtField] = { value: new Date(nowMs).toISOString(), hlc, baseHlc: null };
  return stamped;
}

function parentKeys(rule: TableRule, fields: Readonly<Record<string, FieldWrite>>): string[] {
  const parents: string[] = [];
  for (const [field, spec] of rule.columns) {
    const value = fields[field]?.value;
    if (spec.references && typeof value === 'string') parents.push(keyFor(spec.references.table, value));
  }
  return parents;
}

/**
 * Pure field-LWW authority engine over a storage port. The caller (WorkspaceHub) must run push()
 * inside a single storage transaction so rows, log, seq, conflicts and the idempotency record
 * commit or roll back together.
 */
export class SyncAuthorityEngine {
  constructor(readonly store: SyncStorePort = new MemorySyncStore()) {}

  /** Test helper; only meaningful for the in-memory store. */
  snapshot(): ReturnType<MemorySyncStore['snapshot']> {
    if (!(this.store instanceof MemorySyncStore)) throw new Error('snapshot() requires MemorySyncStore');
    return this.store.snapshot();
  }

  private liveParent(key: string): boolean {
    const parent = this.store.getRow(key);
    return parent !== undefined && parent.deletedHlc === undefined;
  }

  push(
    access: AccessContext,
    request: PushRequest,
    nowMs = Date.now(),
    requestHash = fallbackHash(request),
  ): PushResponse {
    const store = this.store;
    const replayKey = idempotencyKey(access, request);
    store.pruneIdempotency(nowMs - IDEMPOTENCY_RETENTION_MS);
    const previous = store.getIdempotency(replayKey);
    if (previous) {
      if (previous.hash !== requestHash) throw new IdempotencyKeyReusedError();
      return { ...previous.response, replayed: true };
    }

    const rejected: SyncRejection[] = [];
    const conflicts: ConflictRecord[] = [];
    let accepted = 0;
    const reject = (index: number, change: RowChange, code: SyncRejectionCode, reason?: string): void => {
      rejected.push({ index, changeId: change.id, code, ...(reason ? { reason } : {}) });
    };

    for (const [index, change] of request.changes.entries()) {
      const validated = validateChange(access, change, nowMs);
      if ('code' in validated) {
        reject(index, change, validated.code, validated.reason);
        continue;
      }
      const { rule } = validated;
      const rowKey = keyFor(change.table, change.id);
      const current = store.getRow(rowKey);

      if (change.op === 'delete') {
        if (current?.deletedHlc && compareHlc(change.hlc, current.deletedHlc) <= 0) continue;
        // Parents referenced by live rows cannot be removed (the migration's ON DELETE RESTRICT).
        if (store.hasLiveChildren(rowKey)) {
          reject(index, change, 'ORPHAN_REFERENCE', 'LIVE_CHILDREN');
          continue;
        }
        store.putRow(rowKey, { fields: current?.fields ?? {}, deletedHlc: change.hlc });
        store.setRefs(rowKey, []);
        store.appendLog({ ...change, fields: {} });
        accepted += 1;
        continue;
      }
      if (current?.deletedHlc) {
        reject(index, change, 'TOMBSTONED');
        continue;
      }
      if (rule.authority === 'append' && current) continue; // insert-only; redelivery is a no-op

      const insert = current === undefined;
      const incoming: Record<string, FieldWrite> = insert
        ? { ...change.fields, ...stamps(rule, access, change.hlc, nowMs) }
        : change.fields;
      const existing = current?.fields ?? {};
      const next: Record<string, FieldWrite> = { ...existing };
      const applied: Record<string, FieldWrite> = {};
      const rowConflicts: ConflictRecord[] = [];
      for (const [field, write] of Object.entries(incoming)) {
        const stored = existing[field];
        if (!stored) {
          next[field] = write;
          applied[field] = write;
          continue;
        }
        const order = compareHlc(write.hlc, stored.hlc);
        if (order === 0 && canonical(write.value) === canonical(stored.value)) continue; // redelivery
        // Sequential: the writer saw the stored value. Otherwise the writes were concurrent and the
        // loser is retained whichever arrived first (CLD-R-006).
        const sequential = write.baseHlc !== null && compareHlc(write.baseHlc, stored.hlc) === 0;
        if (order > 0) {
          next[field] = write;
          applied[field] = write;
          if (!sequential) {
            rowConflicts.push({
              table: change.table,
              rowId: change.id,
              field,
              winningHlc: write.hlc,
              losingHlc: stored.hlc,
              losingValue: stored.value,
            });
          }
        } else {
          rowConflicts.push({
            table: change.table,
            rowId: change.id,
            field,
            winningHlc: stored.hlc,
            losingHlc: write.hlc,
            losingValue: write.value,
          });
        }
      }

      // Every value that would be stored, and the whole resulting row, must satisfy the schema.
      const problem = checkRow(rule.columns, incoming, false) ?? checkRow(rule.columns, next, insert);
      if (problem) {
        reject(index, change, 'SCHEMA_VIOLATION', `${problem.kind}:${problem.field}`.slice(0, 64));
        continue;
      }
      const parents = parentKeys(rule, next);
      if (parents.some((parent) => !this.liveParent(parent))) {
        reject(index, change, 'ORPHAN_REFERENCE');
        continue;
      }
      if (byteLength(JSON.stringify(next)) > MAX_ROW_BYTES) {
        reject(index, change, 'ROW_TOO_LARGE');
        continue;
      }
      for (const conflict of rowConflicts) {
        conflicts.push(conflict);
        store.addConflict(conflict);
      }
      if (Object.keys(applied).length > 0) {
        store.putRow(rowKey, { fields: next });
        store.setRefs(rowKey, parents);
        store.appendLog({ ...change, fields: applied });
        accepted += 1;
      }
    }

    // Inline history is bounded; the full record is always paged from /v1/sync/conflicts.
    const inline: ConflictRecord[] = [];
    let inlineBytes = 0;
    for (const conflict of conflicts) {
      inlineBytes += byteLength(JSON.stringify(conflict));
      if (inlineBytes > MAX_INLINE_CONFLICT_BYTES) break;
      inline.push(conflict);
    }
    const response: PushResponse = {
      accepted,
      conflicts: conflicts.length,
      serverSeq: store.serverSeq().toString(10),
      rejected,
      conflictHistory: inline,
      replayed: false,
    };
    store.putIdempotency(replayKey, { hash: requestHash, response, atMs: nowMs });
    return response;
  }

  private readableTables(access: AccessContext): string[] {
    const readable: string[] = [];
    for (const [name, rule] of TABLE_RULES) {
      if (rule.authority !== 'synced' && rule.authority !== 'append') continue;
      if (decideAccess(access, rule.manifest, rule.readPermission, 'read').ok) readable.push(name);
    }
    return readable.sort();
  }

  /**
   * Pages the log by rows AND serialized bytes, delivering only tables the caller may read now.
   * The cursor advances past unreadable entries and carries the read scope, so a grant change
   * forces a resync (and local purge) instead of silently skipping or leaking rows (CLD-R-003).
   */
  pull(
    access: AccessContext,
    cursor: string | undefined,
    limit = MAX_PULL_ROWS,
    maxBytes = MAX_PULL_BYTES,
  ): PullOutcome {
    const decoded = decodeCursor(cursor);
    if (!decoded || !Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_ROWS)
      return { ok: false, code: 'INVALID_CURSOR' };
    const readable = this.readableTables(access);
    const scope = scopeFingerprint(readable);
    if (decoded.scope !== null && decoded.scope !== scope) return { ok: false, code: 'RESYNC_REQUIRED' };
    const allowed = new Set(readable);
    const serverSeq = this.store.serverSeq();
    const page = this.store.readLogPage({
      after: decoded.seq,
      maxRows: limit,
      maxBytes,
      maxScan: MAX_PULL_SCAN_ROWS,
      readable: (table) => allowed.has(table),
    });
    const resume = page.exhausted && serverSeq > page.lastExamined ? serverSeq : page.lastExamined;
    return {
      ok: true,
      response: {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: SYNC_SCHEMA_VERSION,
        changes: page.items,
        cursor: encodeCursor(resume, scope),
        more: !page.exhausted,
        serverSeq: serverSeq.toString(10),
      },
    };
  }

  /** Conflict history is retained (REQ-DATA-008), read-filtered and paged by rows and bytes. */
  conflictPage(
    access: AccessContext,
    afterId: number,
    limit: number,
    maxBytes = MAX_PULL_BYTES,
  ): { items: StoredConflict[]; more: boolean; next: number } | null {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      return null;
    const allowed = new Set(this.readableTables(access));
    const page = this.store.readConflictPage({
      after: BigInt(afterId),
      maxRows: limit,
      maxBytes,
      maxScan: MAX_PULL_SCAN_ROWS,
      readable: (table) => allowed.has(table),
    });
    return { items: page.items, more: !page.exhausted, next: Number(page.lastExamined) };
  }
}
