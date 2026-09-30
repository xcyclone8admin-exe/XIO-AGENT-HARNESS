import { DurableObject } from 'cloudflare:workers';
import type { KillSwitchState, RowChange } from '@xyra/contracts';
import { acquireLease, renewLease, type LeaseBook } from './leases';
import type {
  CandidateClaims,
  ConflictRecord,
  CurrentMembership,
  LeaseRecord,
  SequencedChange,
} from './model';
import type { IdempotencyEntry, StoredConflict, StoredRow, SyncStorePort } from './store';
import { IdempotencyKeyReusedError, SyncAuthorityEngine, hashRequest, parseSyncPush } from './sync';
import { hasPermission } from './tables';
import type { Env } from './index';

const EMPTY_KILL_SWITCH: KillSwitchState = {
  engaged: false,
  scope: 'workspace',
  reason: null,
  changedBy: null,
  changedAt: null,
};

const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'];

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
    const row = this.sql.exec<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM sync_log').one();
    return BigInt(row.seq ?? 0);
  }
  appendLog(change: RowChange): bigint {
    const row = this.sql
      .exec<{ seq: number }>('INSERT INTO sync_log (change) VALUES (?) RETURNING seq', JSON.stringify(change))
      .one();
    return BigInt(row.seq);
  }
  readLog(after: bigint, limit: number): SequencedChange[] {
    return this.sql
      .exec<{ seq: number; change: string }>(
        'SELECT seq, change FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?',
        Number(after),
        limit,
      )
      .toArray()
      .map((row) => ({ seq: String(row.seq), change: JSON.parse(row.change) as RowChange }));
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
    this.sql.exec('INSERT INTO sync_conflicts (record) VALUES (?)', JSON.stringify(record));
  }
  readConflicts(afterId: number, limit: number): StoredConflict[] {
    return this.sql
      .exec<{ id: number; record: string }>(
        'SELECT id, record FROM sync_conflicts WHERE id > ? ORDER BY id LIMIT ?',
        afterId,
        limit,
      )
      .toArray()
      .map((row) => ({ id: row.id, record: JSON.parse(row.record) as ConflictRecord }));
  }
}

function isCandidateClaims(value: unknown): value is CandidateClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims['principalId'] === 'string' &&
    typeof claims['tenantId'] === 'string' &&
    typeof claims['activeWorkspaceId'] === 'string' &&
    (claims['kind'] === 'user' || claims['kind'] === 'agent') &&
    Array.isArray(claims['workspaceIds']) &&
    claims['workspaceIds'].every((id) => typeof id === 'string') &&
    [0, 1, 2, 3, 4].includes(claims['autonomy'] as number) &&
    typeof claims['expiresAtMs'] === 'number'
  );
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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

/**
 * One Durable Object per workspace: the strong-consistency boundary for membership
 * revocation, sync sequencing, leases and kill-switch fan-out. All state lives in
 * SQLite tables; every mutation is a synchronous transaction with no await inside.
 */
export class WorkspaceHub extends DurableObject<Env> {
  private readonly store: SqlSyncStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(() => {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS sync_rows (key TEXT PRIMARY KEY, fields TEXT NOT NULL, deleted_hlc TEXT)',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS sync_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, change TEXT NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS sync_idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL, at_ms INTEGER NOT NULL)',
      );
      sql.exec('CREATE INDEX IF NOT EXISTS sync_idempotency_at ON sync_idempotency (at_ms)');
      sql.exec(
        'CREATE TABLE IF NOT EXISTS sync_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS hub_memberships (principal_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS hub_leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at_ms INTEGER NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE IF NOT EXISTS hub_kill_switch (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)',
      );
      return Promise.resolve();
    });
    this.store = new SqlSyncStore(sql);
  }

  private killSwitch(): KillSwitchState {
    const row = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM hub_kill_switch WHERE id = 1')
      .toArray()[0];
    return row ? (JSON.parse(row.state) as KillSwitchState) : EMPTY_KILL_SWITCH;
  }

  private membershipFor(claims: CandidateClaims, nowMs: number): CurrentMembership | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM hub_memberships WHERE principal_id = ?', claims.principalId)
      .toArray()[0];
    if (!row) return null;
    const membership = JSON.parse(row.data) as CurrentMembership;
    if (
      membership.principalId !== claims.principalId ||
      membership.tenantId !== claims.tenantId ||
      membership.workspaceId !== claims.activeWorkspaceId ||
      claims.expiresAtMs <= nowMs ||
      (membership.revokedAtMs !== undefined && membership.revokedAtMs <= nowMs)
    ) {
      return null;
    }
    return membership;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/internal/')) return response({ code: 'HUB_NOT_PUBLIC' }, 404);

    if (url.pathname === '/internal/events') return this.handleEvents(request);

    const body = await readJson(request);
    if (!body) return response({ code: 'INVALID_REQUEST' }, 400);
    const trusted = tokenMatches(request.headers.get('x-hub-internal-token'), this.env.HUB_INTERNAL_TOKEN);

    if (
      ['/internal/membership/upsert', '/internal/kill-switch/set', '/internal/blob/check'].includes(
        url.pathname,
      )
    ) {
      if (!trusted) return response({ code: 'INTERNAL_AUTH_REQUIRED' }, 403);
      if (url.pathname === '/internal/membership/upsert') return this.upsertMembership(body);
      if (url.pathname === '/internal/kill-switch/set') return this.setKillSwitch(body);
      return this.checkBlob(body);
    }

    const claims = body['claims'];
    if (!isCandidateClaims(claims)) return response({ code: 'INVALID_CLAIMS' }, 400);
    const nowMs = Date.now();
    const membership = this.membershipFor(claims, nowMs);
    if (!membership) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (url.pathname === '/internal/authorize') return response({ membership });
    if (url.pathname === '/internal/kill-switch/get') return response({ killSwitch: this.killSwitch() });

    if (url.pathname === '/internal/sync/push') return this.push(claims, body['request']);
    if (url.pathname === '/internal/sync/pull') {
      const cursor = typeof body['cursor'] === 'string' ? body['cursor'] : undefined;
      const result = new SyncAuthorityEngine(this.store).pull(cursor);
      return result ? response(result) : response({ code: 'INVALID_CURSOR' }, 400);
    }
    if (url.pathname === '/internal/sync/conflicts') {
      const after = typeof body['after'] === 'number' ? body['after'] : 0;
      const limit = typeof body['limit'] === 'number' ? body['limit'] : 50;
      const page = new SyncAuthorityEngine(this.store).conflictPage(after, limit);
      return page ? response(page) : response({ code: 'INVALID_PAGE' }, 400);
    }
    if (url.pathname === '/internal/lease/acquire' || url.pathname === '/internal/lease/renew') {
      return this.lease(url.pathname.endsWith('/acquire'), claims, membership, body, nowMs);
    }
    return response({ code: 'HUB_ROUTE_NOT_FOUND' }, 404);
  }

  private async push(claims: CandidateClaims, raw: unknown): Promise<Response> {
    const syncRequest = parseSyncPush(raw);
    if (!syncRequest) return response({ code: 'INVALID_SYNC_REQUEST' }, 400);
    const hash = await hashRequest(syncRequest);
    // No await below this line: membership, kill switch, sequencing and persistence are one atomic step.
    const nowMs = Date.now();
    const membership = this.membershipFor(claims, nowMs);
    if (!membership) return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (claims.kind === 'agent' && this.killSwitch().engaged)
      return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    try {
      const result = this.ctx.storage.transactionSync(() =>
        new SyncAuthorityEngine(this.store).push({ ...claims, membership }, syncRequest, nowMs, hash),
      );
      return response(result);
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError)
        return response({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
      throw error;
    }
  }

  private lease(
    acquire: boolean,
    claims: CandidateClaims,
    membership: CurrentMembership,
    body: Record<string, unknown>,
    nowMs: number,
  ): Response {
    if (this.killSwitch().engaged) return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    if (!hasPermission(membership, 'core:workspace:write'))
      return response({ code: 'PERMISSION_DENIED' }, 403);
    const key = typeof body['key'] === 'string' ? body['key'] : '';
    const ttlMs = typeof body['ttlMs'] === 'number' ? body['ttlMs'] : 0;
    const lease = this.ctx.storage.transactionSync((): LeaseRecord | null => {
      const row = this.ctx.storage.sql
        .exec<{ holder: string; expires_at_ms: number }>(
          'SELECT holder, expires_at_ms FROM hub_leases WHERE key = ?',
          key,
        )
        .toArray()[0];
      const book: LeaseBook = {
        leases: row ? { [key]: { key, holder: row.holder, expiresAtMs: row.expires_at_ms } } : {},
      };
      const next = acquire
        ? acquireLease(book, key, claims.principalId, ttlMs, nowMs)
        : renewLease(book, key, claims.principalId, ttlMs, nowMs);
      if (next)
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO hub_leases (key, holder, expires_at_ms) VALUES (?, ?, ?)',
          next.key,
          next.holder,
          next.expiresAtMs,
        );
      return next;
    });
    return lease ? response({ lease }) : response({ code: 'LEASE_UNAVAILABLE' }, 409);
  }

  private upsertMembership(body: Record<string, unknown>): Response {
    const value = body['membership'];
    if (!value || typeof value !== 'object') return response({ code: 'INVALID_MEMBERSHIP' }, 400);
    const m = value as Record<string, unknown>;
    if (
      typeof m['principalId'] !== 'string' ||
      typeof m['tenantId'] !== 'string' ||
      typeof m['workspaceId'] !== 'string' ||
      !ROLES.includes(m['role'] as string) ||
      !Array.isArray(m['permissions']) ||
      !m['permissions'].every((permission) => typeof permission === 'string')
    ) {
      return response({ code: 'INVALID_MEMBERSHIP' }, 400);
    }
    const updated: CurrentMembership = {
      principalId: m['principalId'],
      tenantId: m['tenantId'],
      workspaceId: m['workspaceId'],
      role: m['role'] as CurrentMembership['role'],
      permissions: m['permissions'] as string[],
      ...(typeof m['revokedAtMs'] === 'number' ? { revokedAtMs: m['revokedAtMs'] } : {}),
    };
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO hub_memberships (principal_id, data) VALUES (?, ?)',
      updated.principalId,
      JSON.stringify(updated),
    );
    if (updated.revokedAtMs !== undefined && updated.revokedAtMs <= Date.now()) {
      for (const socket of this.ctx.getWebSockets(updated.principalId))
        socket.close(4001, 'membership_revoked');
    }
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
    // Fan-out to every connected client in the same step as the state change (<=5 s requirement).
    const message = JSON.stringify({ type: 'kill_switch', killSwitch: next });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A dead socket must not block delivery to the rest.
      }
    }
    return response({ ok: true, killSwitch: next });
  }

  /** Blob redemption recheck: current membership + permission + disengaged kill switch. */
  private checkBlob(body: Record<string, unknown>): Response {
    const { principalId, key, mode } = body;
    if (typeof principalId !== 'string' || typeof key !== 'string' || (mode !== 'GET' && mode !== 'PUT'))
      return response({ code: 'INVALID_REQUEST' }, 400);
    const [tenantId, workspaceId] = key.split('/');
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM hub_memberships WHERE principal_id = ?', principalId)
      .toArray()[0];
    const membership = row ? (JSON.parse(row.data) as CurrentMembership) : null;
    const now = Date.now();
    if (
      !membership ||
      membership.tenantId !== tenantId ||
      membership.workspaceId !== workspaceId ||
      (membership.revokedAtMs !== undefined && membership.revokedAtMs <= now) ||
      !hasPermission(membership, mode === 'GET' ? 'core:workspace:read' : 'core:workspace:write')
    ) {
      return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    }
    if (this.killSwitch().engaged) return response({ code: 'KILL_SWITCH_ENGAGED' }, 423);
    return response({ ok: true });
  }

  /** Hibernatable WebSocket for kill-switch fan-out; the Worker has already verified the JWT. */
  private handleEvents(request: Request): Response {
    if (request.headers.get('upgrade') !== 'websocket') return response({ code: 'UPGRADE_REQUIRED' }, 426);
    let claims: unknown;
    try {
      claims = JSON.parse(request.headers.get('x-hub-claims') ?? 'null');
    } catch {
      claims = null;
    }
    if (!isCandidateClaims(claims)) return response({ code: 'INVALID_CLAIMS' }, 400);
    if (!this.membershipFor(claims, Date.now()))
      return response({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [claims.principalId]);
    server.send(JSON.stringify({ type: 'kill_switch', killSwitch: this.killSwitch() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // Server-push only; client frames are ignored.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    ws.close(code === 1005 ? 1000 : code);
  }
}
