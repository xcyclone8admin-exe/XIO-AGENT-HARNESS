import { DurableObject } from 'cloudflare:workers';
import {
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  type ConflictRecord,
  type KillSwitchState,
  type RowChange,
  type SequencedChange,
} from '@xyra/contracts';
import { decideAccess, type AccessContext } from './access';
import { acquireLease, mayRelease, parseLeaseInput, renewLease, type LeaseHolder } from './leases';
import type { CandidateClaims, CurrentMembership, LeaseRecord } from './model';
import {
  PRINCIPAL_QUOTA,
  ENDPOINT_QUOTA,
  SKEW_QUARANTINE_MS,
  SKEW_STRIKES,
  SKEW_WINDOW_MS,
  WORKSPACE_QUOTA,
  consume,
  lowered,
  type QuotaWindow,
} from './quota';
import {
  byteLength,
  type IdempotencyEntry,
  type Page,
  type PageRequest,
  type StoredConflict,
  type StoredRow,
  type SyncStorePort,
} from './store';
import { IdempotencyKeyReusedError, SyncAuthorityEngine, hashRequest, parseSyncPush } from './sync';
import { MANIFESTS } from './tables';
import type { Env } from './index';

const EMPTY_KILL_SWITCH: KillSwitchState = {
  engaged: false,
  scope: 'workspace',
  reason: null,
  changedBy: null,
  changedAt: null,
};

const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOMBSTONE = '\u0000delete';
const CORE = MANIFESTS.find((manifest) => manifest.id === 'core');
/** Housekeeping cadence while the hub holds leases or sockets. */
const MAINTENANCE_INTERVAL_MS = 10 * 60_000;

/** SQLite-backed store; every statement runs inside the caller's transactionSync. */
class SqlSyncStore implements SyncStorePort {
  constructor(private readonly sql: SqlStorage) {}

  getRow(key: string): StoredRow | undefined {
    const row = this.sql
      .exec<{ fields: string; deleted_hlc: string | null }>(
        'SELECT fields, deleted_hlc FROM sync_rows WHERE key = ?',
        key,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      fields: JSON.parse(row.fields) as StoredRow['fields'],
      ...(row.deleted_hlc ? { deletedHlc: row.deleted_hlc } : {}),
    };
  }
  putRow(key: string, row: StoredRow): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO sync_rows (key, fields, deleted_hlc) VALUES (?, ?, ?)',
      key,
      JSON.stringify(row.fields),
      row.deletedHlc ?? null,
    );
  }
  serverSeq(): bigint {
    // sqlite_sequence survives compaction deleting the newest entries' predecessors.
    const row = this.sql
      .exec<{ seq: number | null }>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'")
      .toArray()[0];
    return BigInt(row?.seq ?? 0);
  }
  appendLog(change: RowChange): bigint {
    const rowKey = `${change.table}:${change.id}`;
    const text = JSON.stringify(change);
    const seq = this.sql
      .exec<{ seq: number }>(
        'INSERT INTO sync_log (tbl, row_key, change, bytes) VALUES (?, ?, ?, ?) RETURNING seq',
        change.table,
        rowKey,
        text,
        byteLength(text),
      )
      .one().seq;
    if (change.op === 'append') return BigInt(seq);
    if (change.op === 'delete') {
      // A tombstone supersedes every earlier entry for the row (including an older tombstone).
      this.sql.exec(
        'DELETE FROM sync_log WHERE seq IN (SELECT DISTINCT seq FROM sync_field_seq WHERE row_key = ?)',
        rowKey,
      );
      this.sql.exec('DELETE FROM sync_field_seq WHERE row_key = ?', rowKey);
      this.sql.exec(
        'INSERT INTO sync_field_seq (row_key, field, seq) VALUES (?, ?, ?)',
        rowKey,
        TOMBSTONE,
        seq,
      );
      return BigInt(seq);
    }
    const strip = new Map<number, string[]>();
    for (const field of Object.keys(change.fields)) {
      const old = this.sql
        .exec<{ seq: number }>(
          'SELECT seq FROM sync_field_seq WHERE row_key = ? AND field = ?',
          rowKey,
          field,
        )
        .toArray()[0];
      if (old) strip.set(old.seq, [...(strip.get(old.seq) ?? []), field]);
      this.sql.exec(
        'INSERT OR REPLACE INTO sync_field_seq (row_key, field, seq) VALUES (?, ?, ?)',
        rowKey,
        field,
        seq,
      );
    }
    for (const [oldSeq, fields] of strip) {
      const entry = this.sql
        .exec<{ change: string }>('SELECT change FROM sync_log WHERE seq = ?', oldSeq)
        .toArray()[0];
      if (!entry) continue;
      const previous = JSON.parse(entry.change) as RowChange;
      const kept = Object.fromEntries(
        Object.entries(previous.fields).filter(([field]) => !fields.includes(field)),
      );
      if (Object.keys(kept).length === 0) {
        this.sql.exec('DELETE FROM sync_log WHERE seq = ?', oldSeq);
      } else {
        const rewritten = JSON.stringify({ ...previous, fields: kept });
        this.sql.exec(
          'UPDATE sync_log SET change = ?, bytes = ? WHERE seq = ?',
          rewritten,
          byteLength(rewritten),
          oldSeq,
        );
      }
    }
    return BigInt(seq);
  }
  readLogPage(request: PageRequest): Page<SequencedChange> {
    return this.page(
      'SELECT seq AS position, tbl, bytes FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?',
      request,
      (position) => {
        const row = this.sql
          .exec<{ change: string }>('SELECT change FROM sync_log WHERE seq = ?', position)
          .one();
        return { seq: String(position), change: JSON.parse(row.change) as RowChange };
      },
    );
  }
  readConflictPage(request: PageRequest): Page<StoredConflict> {
    return this.page(
      'SELECT id AS position, tbl, bytes FROM sync_conflicts WHERE id > ? ORDER BY id LIMIT ?',
      request,
      (position) => {
        const row = this.sql
          .exec<{ record: string }>('SELECT record FROM sync_conflicts WHERE id = ?', position)
          .one();
        return { id: position, record: JSON.parse(row.record) as ConflictRecord };
      },
    );
  }
  /** Scans light metadata only; payloads are loaded solely for delivered, readable entries. */
  private page<T>(query: string, request: PageRequest, load: (position: number) => T): Page<T> {
    const items: T[] = [];
    let bytes = 0;
    let lastExamined = request.after;
    const candidates = this.sql.exec<{ position: number; tbl: string; bytes: number }>(
      query,
      Number(request.after),
      request.maxScan + 1,
    );
    let scanned = 0;
    for (const candidate of candidates) {
      if (items.length >= request.maxRows || scanned >= request.maxScan)
        return { items, lastExamined, exhausted: false };
      scanned += 1;
      if (request.readable(candidate.tbl)) {
        // Account for seq/change wrappers and JSON punctuation as well as stored payload bytes.
        const cost = candidate.bytes + 128;
        if (items.length > 0 && bytes + cost > request.maxBytes)
          return { items, lastExamined, exhausted: false };
        bytes += cost;
        items.push(load(candidate.position));
      }
      lastExamined = BigInt(candidate.position);
    }
    return { items, lastExamined, exhausted: true };
  }
  getIdempotency(key: string): IdempotencyEntry | undefined {
    const row = this.sql
      .exec<{ hash: string; response: string; at_ms: number }>(
        'SELECT hash, response, at_ms FROM sync_idempotency WHERE key = ?',
        key,
      )
      .toArray()[0];
    return row
      ? {
          hash: row.hash,
          response: JSON.parse(row.response) as IdempotencyEntry['response'],
          atMs: row.at_ms,
        }
      : undefined;
  }
  putIdempotency(key: string, entry: IdempotencyEntry): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO sync_idempotency (key, hash, response, at_ms) VALUES (?, ?, ?, ?)',
      key,
      entry.hash,
      JSON.stringify(entry.response),
      entry.atMs,
    );
  }
  pruneIdempotency(beforeMs: number): void {
    this.sql.exec('DELETE FROM sync_idempotency WHERE at_ms < ?', beforeMs);
  }
  addConflict(record: ConflictRecord): void {
    const text = JSON.stringify(record);
    this.sql.exec(
      'INSERT INTO sync_conflicts (tbl, record, bytes) VALUES (?, ?, ?)',
      record.table,
      text,
      byteLength(text),
    );
  }
  setRefs(childKey: string, parentKeys: readonly string[]): void {
    this.sql.exec('DELETE FROM sync_refs WHERE child_key = ?', childKey);
    for (const parent of new Set(parentKeys))
      this.sql.exec('INSERT INTO sync_refs (child_key, parent_key) VALUES (?, ?)', childKey, parent);
  }
  hasLiveChildren(parentKey: string): boolean {
    return (
      this.sql.exec('SELECT 1 FROM sync_refs WHERE parent_key = ? LIMIT 1', parentKey).toArray().length > 0
    );
  }
}

function isCandidateClaims(value: unknown): value is CandidateClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Record<string, unknown>;
  const optionalUuid = (key: string): boolean =>
    claims[key] === undefined || (typeof claims[key] === 'string' && UUID.test(claims[key]));
  return (
    typeof claims['principalId'] === 'string' &&
    typeof claims['tenantId'] === 'string' &&
    typeof claims['activeWorkspaceId'] === 'string' &&
    (claims['kind'] === 'user' || claims['kind'] === 'agent') &&
    Array.isArray(claims['workspaceIds']) &&
    claims['workspaceIds'].every((id) => typeof id === 'string') &&
    [0, 1, 2, 3, 4].includes(claims['autonomy'] as number) &&
    typeof claims['expiresAtMs'] === 'number' &&
    optionalUuid('deviceId') &&
    optionalUuid('delegatedBy') &&
    optionalUuid('runId')
  );
}

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tokenMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || provided === null) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return (
    crypto.subtle as SubtleCrypto & { timingSafeEqual(x: ArrayBufferView, y: ArrayBufferView): boolean }
  ).timingSafeEqual(a, b);
}

interface SocketAttachment {
  readonly principalId: string;
  readonly expiresAtMs: number;
}

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment() as unknown;
  if (!value || typeof value !== 'object') return null;
  const { principalId, expiresAtMs } = value as Record<string, unknown>;
  return typeof principalId === 'string' && typeof expiresAtMs === 'number'
    ? { principalId, expiresAtMs }
    : null;
}

/**
 * One Durable Object per workspace: the strong-consistency boundary for membership revocation,
 * sync sequencing, leases, quotas and kill-switch fan-out. All state lives in SQLite; every
 * mutation is a synchronous transaction with no await inside. Every route requires the internal
 * service token and builds identity only from the Worker-verified `claims` (CLD-R-001).
 */
export class WorkspaceHub extends DurableObject<Env> {
  private readonly store: SqlSyncStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // Never deployed before this schema; no migration of earlier local shapes is required.
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS sync_rows (key TEXT PRIMARY KEY, fields TEXT NOT NULL, deleted_hlc TEXT)',
      'CREATE TABLE IF NOT EXISTS sync_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_key TEXT NOT NULL, change TEXT NOT NULL, bytes INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sync_field_seq (row_key TEXT NOT NULL, field TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (row_key, field))',
      'CREATE TABLE IF NOT EXISTS sync_idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL, at_ms INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS sync_idempotency_at ON sync_idempotency (at_ms)',
      'CREATE TABLE IF NOT EXISTS sync_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, record TEXT NOT NULL, bytes INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sync_refs (child_key TEXT NOT NULL, parent_key TEXT NOT NULL, PRIMARY KEY (child_key, parent_key))',
      'CREATE INDEX IF NOT EXISTS sync_refs_parent ON sync_refs (parent_key)',
      'CREATE TABLE IF NOT EXISTS hub_memberships (principal_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS hub_leases (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS hub_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS hub_quota (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, requests INTEGER NOT NULL, bytes INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS hub_device_health (device_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, strikes INTEGER NOT NULL, quarantined_until INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS hub_kill_switch (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)',
    ])
      sql.exec(statement);
    this.store = new SqlSyncStore(sql);
  }

  // ------------------------------------------------------------------ state helpers

  private killSwitch(): KillSwitchState {
    const row = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM hub_kill_switch WHERE id = 1')
      .toArray()[0];
    return row ? (JSON.parse(row.state) as KillSwitchState) : EMPTY_KILL_SWITCH;
  }

  private record(principalId: string): CurrentMembership | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM hub_memberships WHERE principal_id = ?', principalId)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as CurrentMembership) : null;
  }

  private static current(record: CurrentMembership | null, nowMs: number): record is CurrentMembership {
    return record !== null && (record.revokedAtMs === undefined || record.revokedAtMs > nowMs);
  }

  /** Current membership for verified claims, plus (agents) the delegator's current record. */
  private accessFor(claims: CandidateClaims, nowMs: number): AccessContext | null {
    const membership = this.record(claims.principalId);
    if (
      !WorkspaceHub.current(membership, nowMs) ||
      membership.principalId !== claims.principalId ||
      membership.tenantId !== claims.tenantId ||
      membership.workspaceId !== claims.activeWorkspaceId ||
      claims.expiresAtMs <= nowMs
    ) {
      return null;
    }
    const delegatorRecord = membership.delegatedBy ? this.record(membership.delegatedBy) : null;
    const delegator =
      WorkspaceHub.current(delegatorRecord, nowMs) &&
      delegatorRecord.tenantId === membership.tenantId &&
      delegatorRecord.workspaceId === membership.workspaceId
        ? delegatorRecord
        : undefined;
    return { claims, membership, delegator, killSwitchEngaged: this.killSwitch().engaged };
  }

  private nextCounter(name: string): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        'INSERT INTO hub_counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value',
        name,
      )
      .one().value;
  }

  private consumeQuota(principalId: string, bytes: number, nowMs: number, endpoint: string): Response | null {
    const limits: [string, typeof PRINCIPAL_QUOTA][] = [
      [
        `p:${principalId}`,
        lowered(PRINCIPAL_QUOTA, this.env.QUOTA_PRINCIPAL_RPM, this.env.QUOTA_PRINCIPAL_BYTES),
      ],
      ['w', WORKSPACE_QUOTA],
      [`e:${endpoint}`, lowered(ENDPOINT_QUOTA, this.env.QUOTA_ENDPOINT_RPM)],
    ];
    return this.ctx.storage.transactionSync(() => {
      const updates: [string, QuotaWindow][] = [];
      for (const [key, limit] of limits) {
        const row = this.ctx.storage.sql
          .exec<{ window_start: number; requests: number; bytes: number }>(
            'SELECT window_start, requests, bytes FROM hub_quota WHERE key = ?',
            key,
          )
          .toArray()[0];
        const result = consume(
          row ? { windowStart: row.window_start, requests: row.requests, bytes: row.bytes } : undefined,
          limit,
          bytes,
          nowMs,
        );
        if (!result.ok)
          return response({ code: 'RATE_LIMITED', retryAfterSec: result.retryAfterSec }, 429, {
            'retry-after': String(result.retryAfterSec),
          });
        updates.push([key, result.next]);
      }
      for (const [key, next] of updates)
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO hub_quota (key, window_start, requests, bytes) VALUES (?, ?, ?, ?)',
          key,
          next.windowStart,
          next.requests,
          next.bytes,
        );
      return null;
    });
  }

  private async ensureAlarm(atMs: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > atMs) await this.ctx.storage.setAlarm(atMs);
  }

  // ------------------------------------------------------------------ routing

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/internal/')) return response({ code: 'HUB_NOT_PUBLIC' }, 404);
    if (!tokenMatches(request.headers.get('x-hub-internal-token'), this.env.HUB_INTERNAL_TOKEN))
      return response({ code: 'INTERNAL_AUTH_REQUIRED' }, 403);
    if (url.pathname === '/internal/events') return this.handleEvents(request);

    const body = await readJson(request);
    if (!body) return response({ code: 'INVALID_REQUEST' }, 400);
    switch (url.pathname) {
      case '/internal/membership/upsert':
        return this.upsertMembership(body);
      case '/internal/membership/revoke':
        return this.revokeMembership(body);
      case '/internal/kill-switch/set':
        return this.setKillSwitch(body);
      case '/internal/blob/check':
        return this.checkBlob(body);
      case '/internal/maintenance':
        return response(this.maintain(Date.now()));
      case '/internal/sockets':
        return response({ open: this.ctx.getWebSockets().length });
    }

    const claims = body['claims'];
    if (!isCandidateClaims(claims)) return response({ code: 'INVALID_CLAIMS' }, 400);
    const nowMs = Date.now();
    const access = this.accessFor(claims, nowMs);
    if (!access) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);

    switch (url.pathname) {
      case '/internal/authorize': {
        // Single choke point for every public request: quota by principal and workspace.
        const bytes = typeof body['bytes'] === 'number' && body['bytes'] >= 0 ? body['bytes'] : 0;
        const endpoint =
          typeof body['endpoint'] === 'string' && /^\/v1\/[a-z/-]{1,80}$/.test(body['endpoint'])
            ? body['endpoint']
            : '/v1/unknown';
        const limited = this.consumeQuota(claims.principalId, bytes, nowMs, endpoint);
        if (limited) return limited;
        return response({ membership: access.membership, killSwitchEngaged: access.killSwitchEngaged });
      }
      case '/internal/kill-switch/get':
        return response({ killSwitch: this.killSwitch() });
      case '/internal/sync/push':
        return this.push(claims, body['request']);
      case '/internal/sync/pull': {
        if (
          body['protocolVersion'] !== SYNC_PROTOCOL_VERSION ||
          body['schemaVersion'] !== SYNC_SCHEMA_VERSION
        )
          return response(
            {
              code: 'UPDATE_REQUIRED',
              protocolVersion: SYNC_PROTOCOL_VERSION,
              schemaVersion: SYNC_SCHEMA_VERSION,
            },
            426,
          );
        const cursor = typeof body['cursor'] === 'string' ? body['cursor'] : undefined;
        const limit = typeof body['limit'] === 'number' ? body['limit'] : undefined;
        const result = new SyncAuthorityEngine(this.store).pull(access, cursor, limit);
        return result.ok
          ? response(result.response)
          : response({ code: result.code }, 409 - (result.code === 'INVALID_CURSOR' ? 9 : 0));
      }
      case '/internal/sync/conflicts': {
        const after = typeof body['after'] === 'number' ? body['after'] : 0;
        const limit = typeof body['limit'] === 'number' ? body['limit'] : 50;
        const page = new SyncAuthorityEngine(this.store).conflictPage(access, after, limit);
        return page ? response(page) : response({ code: 'INVALID_PAGE' }, 400);
      }
      case '/internal/lease/acquire':
      case '/internal/lease/renew':
      case '/internal/lease/release':
        return this.lease(url.pathname.slice('/internal/lease/'.length), access, body['lease'], nowMs);
      case '/internal/blob/authorize':
        return this.authorizeBlob(access, body['mode']);
    }
    return response({ code: 'HUB_ROUTE_NOT_FOUND' }, 404);
  }

  // ------------------------------------------------------------------ sync

  private deviceKey(claims: CandidateClaims, nodeId: string): string {
    return claims.deviceId ? `d:${claims.deviceId}` : `n:${claims.principalId}:${nodeId}`;
  }

  private quarantined(deviceKey: string, nowMs: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ quarantined_until: number }>(
        'SELECT quarantined_until FROM hub_device_health WHERE device_key = ?',
        deviceKey,
      )
      .toArray()[0];
    return row !== undefined && row.quarantined_until > nowMs;
  }

  private recordSkew(deviceKey: string, strikes: number, nowMs: number): void {
    if (strikes === 0) return;
    const row = this.ctx.storage.sql
      .exec<{ window_start: number; strikes: number }>(
        'SELECT window_start, strikes FROM hub_device_health WHERE device_key = ?',
        deviceKey,
      )
      .toArray()[0];
    const fresh = !row || nowMs - row.window_start >= SKEW_WINDOW_MS;
    const total = (fresh ? 0 : row.strikes) + strikes;
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hub_device_health (device_key, window_start, strikes, quarantined_until) VALUES (?, ?, ?, ?)',
      deviceKey,
      fresh ? nowMs : row.window_start,
      total,
      total >= SKEW_STRIKES ? nowMs + SKEW_QUARANTINE_MS : 0,
    );
  }

  private async push(claims: CandidateClaims, raw: unknown): Promise<Response> {
    if (
      !raw ||
      typeof raw !== 'object' ||
      (raw as Record<string, unknown>)['protocolVersion'] !== SYNC_PROTOCOL_VERSION ||
      (raw as Record<string, unknown>)['schemaVersion'] !== SYNC_SCHEMA_VERSION
    )
      return response(
        {
          code: 'UPDATE_REQUIRED',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          schemaVersion: SYNC_SCHEMA_VERSION,
        },
        426,
      );
    const syncRequest = parseSyncPush(raw);
    if (!syncRequest) return response({ code: 'INVALID_SYNC_REQUEST' }, 400);
    const hash = await hashRequest(syncRequest);
    // No await below this line: membership, kill switch, sequencing and persistence are one atomic step.
    const nowMs = Date.now();
    const access = this.accessFor(claims, nowMs);
    if (!access) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (claims.kind === 'agent' && access.killSwitchEngaged)
      return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    const device = this.deviceKey(claims, syncRequest.nodeId);
    if (this.quarantined(device, nowMs)) return response({ code: 'DEVICE_QUARANTINED' }, 403);
    try {
      const result = this.ctx.storage.transactionSync(() => {
        const outcome = new SyncAuthorityEngine(this.store).push(access, syncRequest, nowMs, hash);
        if (!outcome.replayed)
          this.recordSkew(
            device,
            outcome.rejected.filter((item) => item.code === 'CLOCK_SKEW').length,
            nowMs,
          );
        return outcome;
      });
      return response(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError)
        return response({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
      throw error;
    }
  }

  // ------------------------------------------------------------------ leases

  private lease(
    action: string,
    access: AccessContext,
    raw: unknown,
    nowMs: number,
  ): Response | Promise<Response> {
    if (access.killSwitchEngaged) return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    if (!CORE) return response({ code: 'POLICY_UNAVAILABLE' }, 503);
    const decision = decideAccess(access, CORE, 'core:workspace:write', 'write');
    if (!decision.ok) return response({ code: decision.code, reason: decision.reason }, 403);
    const deviceId = access.claims.deviceId;
    if (!deviceId) return response({ code: 'DEVICE_REQUIRED' }, 403);
    const input = parseLeaseInput(raw, action !== 'acquire');
    if (!input) return response({ code: 'INVALID_LEASE_REQUEST' }, 400);
    const holder: LeaseHolder = { principalId: access.claims.principalId, deviceId };
    const outcome = this.ctx.storage.transactionSync((): LeaseRecord | 'released' | null => {
      const row = this.ctx.storage.sql
        .exec<{ data: string }>('SELECT data FROM hub_leases WHERE key = ?', input.key)
        .toArray()[0];
      const existing = row ? (JSON.parse(row.data) as LeaseRecord) : undefined;
      if (action === 'release') {
        if (!input.token || !mayRelease(existing, holder, input.token)) return null;
        this.ctx.storage.sql.exec('DELETE FROM hub_leases WHERE key = ?', input.key);
        return 'released';
      }
      const next =
        action === 'acquire'
          ? existing && existing.expiresAtMs > nowMs
            ? null
            : acquireLease(
                existing,
                input.key,
                holder,
                input.ttlMs,
                nowMs,
                crypto.randomUUID(),
                this.nextCounter('fence'),
              )
          : renewLease(existing, holder, input.token ?? '', input.ttlMs, nowMs);
      if (next)
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO hub_leases (key, data, expires_at_ms) VALUES (?, ?, ?)',
          next.key,
          JSON.stringify(next),
          next.expiresAtMs,
        );
      return next;
    });
    if (outcome === 'released') return response({ released: true });
    if (!outcome)
      return response({ code: action === 'acquire' ? 'LEASE_UNAVAILABLE' : 'LEASE_NOT_HELD' }, 409);
    return this.ensureAlarm(outcome.expiresAtMs + 1_000).then(() => response({ lease: outcome }));
  }

  // ------------------------------------------------------------------ server authority (internal token)

  private upsertMembership(body: Record<string, unknown>): Response {
    const value = body['membership'];
    if (!value || typeof value !== 'object') return response({ code: 'INVALID_MEMBERSHIP' }, 400);
    const m = value as Record<string, unknown>;
    const kind = m['kind'] ?? 'user';
    if (
      typeof m['principalId'] !== 'string' ||
      typeof m['tenantId'] !== 'string' ||
      typeof m['workspaceId'] !== 'string' ||
      !ROLES.includes(m['role'] as string) ||
      !Array.isArray(m['permissions']) ||
      !m['permissions'].every((permission) => typeof permission === 'string') ||
      (kind !== 'user' && kind !== 'agent') ||
      (m['delegatedBy'] !== undefined &&
        (typeof m['delegatedBy'] !== 'string' || !UUID.test(m['delegatedBy']))) ||
      (m['autonomy'] !== undefined && ![0, 1, 2, 3, 4].includes(m['autonomy'] as number)) ||
      (m['workspaceKind'] !== undefined &&
        m['workspaceKind'] !== 'standard' &&
        m['workspaceKind'] !== 'sample') ||
      (kind === 'agent') !== (m['delegatedBy'] !== undefined)
    ) {
      return response({ code: 'INVALID_MEMBERSHIP' }, 400);
    }
    const updated: CurrentMembership = {
      principalId: m['principalId'],
      tenantId: m['tenantId'],
      workspaceId: m['workspaceId'],
      role: m['role'] as CurrentMembership['role'],
      permissions: m['permissions'] as string[],
      kind,
      ...(typeof m['delegatedBy'] === 'string' ? { delegatedBy: m['delegatedBy'] } : {}),
      ...(typeof m['autonomy'] === 'number' ? { autonomy: m['autonomy'] as 0 | 1 | 2 | 3 | 4 } : {}),
      ...(m['workspaceKind'] === 'sample' ? { workspaceKind: 'sample' as const } : {}),
      ...(typeof m['revokedAtMs'] === 'number' ? { revokedAtMs: m['revokedAtMs'] } : {}),
    };
    const previous = this.record(updated.principalId);
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hub_memberships (principal_id, data) VALUES (?, ?)',
      updated.principalId,
      JSON.stringify(updated),
    );
    const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(updated);
    if ((updated.revokedAtMs !== undefined && updated.revokedAtMs <= Date.now()) || changed) {
      for (const socket of this.ctx.getWebSockets(updated.principalId))
        socket.close(1008, changed ? 'membership_changed' : 'membership_revoked');
    }
    return response({ ok: true });
  }

  private revokeMembership(body: Record<string, unknown>): Response {
    const principalId = body['principalId'];
    if (typeof principalId !== 'string' || !UUID.test(principalId))
      return response({ code: 'INVALID_MEMBERSHIP' }, 400);
    const existing = this.record(principalId);
    if (existing) {
      this.ctx.storage.sql.exec(
        'UPDATE hub_memberships SET data = ? WHERE principal_id = ?',
        JSON.stringify({ ...existing, revokedAtMs: Date.now() }),
        principalId,
      );
    }
    for (const socket of this.ctx.getWebSockets(principalId)) socket.close(1008, 'membership_revoked');
    return response({ ok: true });
  }

  private setKillSwitch(body: Record<string, unknown>): Response {
    const value = body['killSwitch'];
    if (!value || typeof value !== 'object') return response({ code: 'INVALID_KILL_SWITCH' }, 400);
    const k = value as Record<string, unknown>;
    if (
      typeof k['engaged'] !== 'boolean' ||
      k['scope'] !== 'workspace' ||
      typeof k['changedAt'] !== 'string'
    ) {
      return response({ code: 'INVALID_KILL_SWITCH' }, 400);
    }
    const next: KillSwitchState = {
      engaged: k['engaged'],
      scope: 'workspace',
      reason: typeof k['reason'] === 'string' ? k['reason'] : null,
      changedBy: typeof k['changedBy'] === 'string' ? k['changedBy'] : null,
      changedAt: k['changedAt'],
    };
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hub_kill_switch (id, state) VALUES (1, ?)',
      JSON.stringify(next),
    );
    this.broadcast({ type: 'kill_switch', killSwitch: next });
    return response({ ok: true, killSwitch: next });
  }

  /**
   * Fan-out in the same step as the state change (<=5 s requirement). Each socket's own expiry and
   * its principal's current membership are rechecked first: an expired or revoked session is
   * closed instead of served (CLD-R-011). Attachments survive hibernation.
   */
  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    const nowMs = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (!attachment || attachment.expiresAtMs <= nowMs) {
        socket.close(1008, 'token_expired');
        continue;
      }
      if (!WorkspaceHub.current(this.record(attachment.principalId), nowMs)) {
        socket.close(1008, 'membership_revoked');
        continue;
      }
      try {
        socket.send(text);
      } catch {
        // A dead socket must not block delivery to the rest.
      }
    }
  }

  // ------------------------------------------------------------------ blobs

  private blobPermission(mode: unknown): string | null {
    return mode === 'GET' ? 'core:workspace:read' : mode === 'PUT' ? 'core:workspace:write' : null;
  }

  private authorizeBlob(access: AccessContext, mode: unknown): Response {
    const permission = this.blobPermission(mode);
    if (!permission || !CORE) return response({ code: 'INVALID_REQUEST' }, 400);
    const decision = decideAccess(access, CORE, permission, mode === 'GET' ? 'read' : 'write');
    return decision.ok
      ? response({ ok: true })
      : response({ code: 'BLOB_ACCESS_DENIED', reason: decision.reason }, 403);
  }

  /** Blob redemption recheck: current membership + policy + disengaged kill switch + quota. */
  private checkBlob(body: Record<string, unknown>): Response {
    const { principalId, key, mode, bytes } = body;
    const permission = this.blobPermission(mode);
    if (typeof principalId !== 'string' || typeof key !== 'string' || !permission || !CORE)
      return response({ code: 'INVALID_REQUEST' }, 400);
    const [tenantId, workspaceId] = key.split('/');
    const nowMs = Date.now();
    const membership = this.record(principalId);
    if (
      !WorkspaceHub.current(membership, nowMs) ||
      membership.tenantId !== tenantId ||
      membership.workspaceId !== workspaceId
    ) {
      return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    }
    if (this.killSwitch().engaged) return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    // Redemption has no JWT, so the recheck uses the record alone; agents never redeem blob refs.
    if (membership.kind === 'agent') return response({ code: 'BLOB_ACCESS_DENIED' }, 403);
    const claims: CandidateClaims = {
      principalId,
      kind: 'user',
      tenantId: membership.tenantId,
      workspaceIds: [membership.workspaceId],
      activeWorkspaceId: membership.workspaceId,
      autonomy: 0,
      expiresAtMs: nowMs + 1,
      deviceThumbprint: 'A'.repeat(43),
    };
    const decision = decideAccess(
      { claims, membership, killSwitchEngaged: false },
      CORE,
      permission,
      mode === 'GET' ? 'read' : 'write',
    );
    if (!decision.ok) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    const limited = this.consumeQuota(
      principalId,
      typeof bytes === 'number' && bytes > 0 ? bytes : 0,
      nowMs,
      '/v1/blobs/access',
    );
    return limited ?? response({ ok: true });
  }

  // ------------------------------------------------------------------ events socket

  /** Hibernatable WebSocket for kill-switch fan-out; the Worker has already verified the JWT. */
  private async handleEvents(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return response({ code: 'UPGRADE_REQUIRED' }, 426);
    let claims: unknown;
    try {
      claims = JSON.parse(request.headers.get('x-hub-claims') ?? 'null');
    } catch {
      claims = null;
    }
    if (!isCandidateClaims(claims)) return response({ code: 'INVALID_CLAIMS' }, 400);
    if (!this.accessFor(claims, Date.now())) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [claims.principalId]);
    server.serializeAttachment({
      principalId: claims.principalId,
      expiresAtMs: claims.expiresAtMs,
    } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: 'kill_switch', killSwitch: this.killSwitch() }));
    await this.ensureAlarm(claims.expiresAtMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // Server-push only; client frames are ignored.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    ws.close(code === 1005 ? 1000 : code);
  }

  // ------------------------------------------------------------------ maintenance

  /**
   * Housekeeping that bounds hot state without discarding required evidence: closes expired
   * sockets, drops expired leases (fences stay monotonic via hub_counters), prunes idempotency and
   * stale quota windows. Conflict history is never deleted here; the log compacts on write.
   */
  private maintain(nowMs: number): { closedSockets: number; expiredLeases: number; nextAtMs: number | null } {
    let closedSockets = 0;
    let nextSocketExpiry: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (!attachment || attachment.expiresAtMs <= nowMs) {
        socket.close(1008, 'token_expired');
        closedSockets += 1;
      } else if (nextSocketExpiry === null || attachment.expiresAtMs < nextSocketExpiry) {
        nextSocketExpiry = attachment.expiresAtMs;
      }
    }
    const expiredLeases = this.ctx.storage.sql
      .exec('DELETE FROM hub_leases WHERE expires_at_ms <= ? RETURNING key', nowMs)
      .toArray().length;
    this.store.pruneIdempotency(nowMs - 7 * 24 * 3_600_000);
    this.ctx.storage.sql.exec('DELETE FROM hub_quota WHERE window_start < ?', nowMs - 5 * 60_000);
    const nextLease = this.ctx.storage.sql
      .exec<{ at: number | null }>('SELECT MIN(expires_at_ms) AS at FROM hub_leases')
      .one().at;
    const candidates = [nextSocketExpiry, nextLease === null ? null : nextLease + 1_000].filter(
      (at): at is number => at !== null,
    );
    const nextAtMs =
      candidates.length > 0 ? Math.min(Math.min(...candidates), nowMs + MAINTENANCE_INTERVAL_MS) : null;
    return { closedSockets, expiredLeases, nextAtMs };
  }

  override async alarm(): Promise<void> {
    const { nextAtMs } = this.maintain(Date.now());
    if (nextAtMs !== null) await this.ctx.storage.setAlarm(nextAtMs);
  }
}
