import { describe, expect, it } from 'vitest';
import type { RowChange } from '@xyra/contracts';
import { verifyAccessToken } from './auth';
import { signBlobAccess, tenantWorkspaceKey, verifyBlobAccess } from './blobs';
import { acquireLease, emptyLeaseBook, renewLease, type LeaseBook } from './leases';
import type { ActivePrincipal, CurrentMembership } from './model';
import { IDEMPOTENCY_RETENTION_MS, SYNC_PROTOCOL_VERSION, SYNC_SCHEMA_VERSION } from './model';
import { IdempotencyKeyReusedError, SyncAuthorityEngine, parseSyncPush } from './sync';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const W1 = '33333333-3333-4333-8333-333333333333';
const W2 = '44444444-4444-4444-8444-444444444444';
const U1 = '55555555-5555-4555-8555-555555555555';
const ROW = '66666666-6666-4666-8666-666666666666';
const ROW2 = '99999999-9999-4999-8999-999999999999';
const NOW = 1_800_000_000_000;
const hlc = (ms: number, counter = 0, node = 'nodea') =>
  `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${node}`;

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');

async function tokenFor(payload: Record<string, unknown>, opts: { tamper?: boolean; alg?: string } = {}) {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
  const head = b64(JSON.stringify({ alg: opts.alg ?? 'EdDSA', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  if (opts.tamper) sig[0] = (sig[0] ?? 0) ^ 0xff;
  return { token: `${head}.${body}.${b64(sig)}`, jwk };
}

const claimsPayload = (over: Record<string, unknown> = {}) => ({
  sub: U1,
  kind: 'user',
  tenant_id: T1,
  workspace_ids: [W1],
  active_workspace: W1,
  autonomy_level: 1,
  iat: NOW / 1000,
  exp: NOW / 1000 + 900,
  aud: 'xyra-cloud',
  iss: 'xyra-auth',
  ...over,
});
const req = (token?: string) =>
  new Request('https://x/', token ? { headers: { authorization: `Bearer ${token}` } } : {});
const cfg = (jwk?: string) => ({
  ...(jwk ? { verificationJwk: jwk } : {}),
  audience: 'xyra-cloud',
  issuer: 'xyra-auth',
  nowMs: NOW,
});

describe('access-token verification (fail closed)', () => {
  it('accepts a valid token and yields candidate claims', async () => {
    const { token, jwk } = await tokenFor(claimsPayload());
    const r = await verifyAccessToken(req(token), cfg(jwk));
    expect(r.ok && r.claims.tenantId).toBe(T1);
  });
  it('rejects missing header, bad scheme and malformed tokens', async () => {
    expect(await verifyAccessToken(req(), cfg('{}'))).toEqual({ ok: false, code: 'MISSING_AUTH' });
    const basic = new Request('https://x/', { headers: { authorization: 'Basic abc' } });
    expect(await verifyAccessToken(basic, cfg('{}'))).toEqual({ ok: false, code: 'MALFORMED_TOKEN' });
    expect(await verifyAccessToken(req('a.b.c'), cfg('{}'))).toMatchObject({ ok: false });
  });
  it('is not configured without key, audience or issuer', async () => {
    const { token, jwk } = await tokenFor(claimsPayload());
    expect(await verifyAccessToken(req(token), cfg())).toEqual({ ok: false, code: 'AUTH_NOT_CONFIGURED' });
    expect(await verifyAccessToken(req(token), { verificationJwk: jwk, nowMs: NOW })).toEqual({
      ok: false,
      code: 'AUTH_NOT_CONFIGURED',
    });
  });
  it('rejects tampered signature, wrong alg, expiry, wrong audience/issuer and inconsistent scope', async () => {
    const t = await tokenFor(claimsPayload(), { tamper: true });
    expect(await verifyAccessToken(req(t.token), cfg(t.jwk))).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
    const none = await tokenFor(claimsPayload(), { alg: 'none' });
    expect(await verifyAccessToken(req(none.token), cfg(none.jwk))).toEqual({
      ok: false,
      code: 'MALFORMED_TOKEN',
    });
    for (const over of [
      { exp: NOW / 1000 - 1 },
      { aud: 'other' },
      { iss: 'evil' },
      { active_workspace: W2 },
      { tenant_id: 'nope' },
    ]) {
      const x = await tokenFor(claimsPayload(over));
      expect(await verifyAccessToken(req(x.token), cfg(x.jwk))).toEqual({
        ok: false,
        code: 'INVALID_CLAIMS',
      });
    }
  });
  it('rejects a token signed by a different key', async () => {
    const a = await tokenFor(claimsPayload());
    const b = await tokenFor(claimsPayload());
    expect(await verifyAccessToken(req(a.token), cfg(b.jwk))).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
  });
});

const membership = (over: Partial<CurrentMembership> = {}): CurrentMembership => ({
  principalId: U1,
  tenantId: T1,
  workspaceId: W1,
  role: 'member',
  permissions: ['ops:task:write', 'ops:project:write'],
  ...over,
});
const principal = (over: Partial<ActivePrincipal> = {}): ActivePrincipal => ({
  principalId: U1,
  kind: 'user',
  tenantId: T1,
  workspaceIds: [W1],
  activeWorkspaceId: W1,
  autonomy: 1,
  expiresAtMs: NOW + 900_000,
  membership: membership(),
  ...over,
});
const change = (over: Partial<RowChange> = {}): RowChange => ({
  table: 'ops_tasks',
  id: ROW,
  tenantId: T1,
  workspaceId: W1,
  op: 'upsert',
  hlc: hlc(NOW),
  fields: { title: { value: 'a', hlc: hlc(NOW), baseHlc: null } },
  ...over,
});
let keyN = 0;
const push = (changes: RowChange[], key = `idem-key-${String(++keyN).padStart(8, '0')}`) => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  schemaVersion: SYNC_SCHEMA_VERSION,
  nodeId: 'nodea',
  idempotencyKey: key,
  changes,
});
const rowTitle = (e: SyncAuthorityEngine) => e.snapshot().rows[`ops_tasks:${ROW}`]?.fields['title']?.value;

describe('sync push authority', () => {
  it('accepts a valid change, assigns a server sequence and serves it via pull', () => {
    const e = new SyncAuthorityEngine();
    const r = e.push(principal(), push([change()]), NOW);
    expect(r).toMatchObject({ accepted: 1, serverSeq: '1', rejected: [] });
    const pulled = e.pull(undefined);
    expect(pulled?.changes.map((c) => c.seq)).toEqual(['1']);
    expect(e.pull(pulled?.cursor)?.changes).toEqual([]);
  });
  it('rejects cross-tenant and cross-workspace rows per row without blocking valid rows', () => {
    const e = new SyncAuthorityEngine();
    const r = e.push(
      principal(),
      push([
        change({ tenantId: T2 }),
        change({ workspaceId: W2 }),
        change({ workspaceId: null }),
        change({ id: ROW2 }),
      ]),
      NOW,
    );
    expect(r.rejected.map((x) => x.code)).toEqual([
      'AUTH_SCOPE_MISMATCH',
      'AUTH_SCOPE_MISMATCH',
      'AUTH_SCOPE_MISMATCH',
    ]);
    expect(r.accepted).toBe(1);
    expect(e.snapshot().log.every((l) => l.change.tenantId === T1 && l.change.workspaceId === W1)).toBe(true);
  });
  it('rejects server-authority, local-only, unknown tables and wrong op class', () => {
    const e = new SyncAuthorityEngine();
    const r = e.push(
      principal({ membership: membership({ role: 'owner' }) }),
      push([
        change({ table: 'memberships' }),
        change({ table: 'sync_outbox' }),
        change({ table: 'made_up' }),
        change({ table: 'audit_events', op: 'upsert' }),
        change({ table: 'ops_tasks', op: 'append' }),
      ]),
      NOW,
    );
    expect(r.rejected.map((x) => x.code)).toEqual([
      'SERVER_AUTHORITY',
      'LOCAL_ONLY',
      'UNKNOWN_TABLE',
      'APPEND_REQUIRED',
      'UPSERT_REQUIRED',
    ]);
    expect(r.accepted).toBe(0);
  });
  it('rejects guarded, immutable and unlisted fields even for admins', () => {
    const e = new SyncAuthorityEngine();
    const w = { value: 'x', hlc: hlc(NOW), baseHlc: null };
    const r = e.push(
      principal({ membership: membership({ role: 'admin' }) }),
      push([
        change({ fields: { status: w } }),
        change({ fields: { tenant_id: w } }),
        change({ fields: { secret_column: w } }),
      ]),
      NOW,
    );
    expect(r.rejected.map((x) => x.code)).toEqual(['GUARDED_FIELD', 'IMMUTABLE_FIELD', 'INVALID_ROW']);
    expect(e.snapshot().log).toEqual([]);
  });
  it('honors current membership permission, not stale claim scope', () => {
    const e = new SyncAuthorityEngine();
    const r = e.push(
      principal({ membership: membership({ role: 'viewer', permissions: [] }) }),
      push([change()]),
      NOW,
    );
    expect(r.rejected[0]?.code).toBe('PERMISSION_DENIED');
  });
  it('rejects future-skewed and malformed HLCs', () => {
    const e = new SyncAuthorityEngine();
    const r = e.push(
      principal(),
      push([
        change({ hlc: hlc(NOW + 10 * 60_000) }),
        change({ hlc: 'garbage' }),
        change({ fields: { title: { value: 1, hlc: 'bad', baseHlc: null } } }),
      ]),
      NOW,
    );
    expect(r.rejected.map((x) => x.code)).toEqual(['CLOCK_SKEW', 'CLOCK_SKEW', 'INVALID_ROW']);
  });
  it('replays an idempotent push without re-applying or re-sequencing', () => {
    const e = new SyncAuthorityEngine();
    const p = push([change()], 'idem-replay-0001');
    const first = e.push(principal(), p, NOW);
    const second = e.push(principal(), p, NOW + 1);
    expect(second).toEqual({ ...first, replayed: true });
    expect(e.snapshot().seq).toBe('1');
    const other = e.push(principal({ principalId: '88888888-8888-4888-8888-888888888888' }), p, NOW);
    expect(other.replayed).toBe(false);
  });
  it('retains the loser of a field conflict and converges regardless of arrival order', () => {
    const older = change({ fields: { title: { value: 'old', hlc: hlc(NOW, 0), baseHlc: null } } });
    const newer = change({ fields: { title: { value: 'new', hlc: hlc(NOW, 1), baseHlc: null } } });
    const a = new SyncAuthorityEngine();
    a.push(principal(), push([newer]), NOW);
    const r = a.push(principal(), push([older]), NOW);
    expect(r).toMatchObject({ accepted: 0, conflicts: 1 });
    expect(r.conflictHistory[0]).toMatchObject({
      field: 'title',
      losingValue: 'old',
      winningHlc: hlc(NOW, 1),
      losingHlc: hlc(NOW, 0),
    });
    expect(a.snapshot().conflicts).toHaveLength(1);
    const b = new SyncAuthorityEngine();
    b.push(principal(), push([older]), NOW);
    b.push(principal(), push([newer]), NOW);
    expect(rowTitle(a)).toBe('new');
    expect(rowTitle(b)).toBe('new');
  });
  it('tombstones block later upserts', () => {
    const e = new SyncAuthorityEngine();
    e.push(principal(), push([change({ op: 'delete', fields: {}, hlc: hlc(NOW, 5) })]), NOW);
    const r = e.push(
      principal(),
      push([change({ fields: { title: { value: 'z', hlc: hlc(NOW, 9), baseHlc: null } } })]),
      NOW,
    );
    expect(r.rejected[0]?.code).toBe('TOMBSTONED');
  });
  it('append rows are insert-only', () => {
    const e = new SyncAuthorityEngine();
    const row = change({
      table: 'audit_events',
      op: 'append',
      fields: { action: { value: 'a', hlc: hlc(NOW), baseHlc: null } },
    });
    e.push(principal(), push([row]), NOW);
    const r = e.push(
      principal(),
      push([{ ...row, fields: { action: { value: 'tampered', hlc: hlc(NOW, 3), baseHlc: null } } }]),
      NOW,
    );
    expect(r.accepted).toBe(0);
    expect(e.snapshot().rows[`audit_events:${ROW}`]?.fields['action']?.value).toBe('a');
  });
  it('rejects the same idempotency key with a different payload', () => {
    const e = new SyncAuthorityEngine();
    e.push(principal(), push([change()], 'idem-reuse-00001'), NOW);
    const other = change({ fields: { title: { value: 'different', hlc: hlc(NOW, 2), baseHlc: null } } });
    expect(() => e.push(principal(), push([other], 'idem-reuse-00001'), NOW)).toThrow(
      IdempotencyKeyReusedError,
    );
    expect(e.snapshot().seq).toBe('1');
  });
  it('prunes idempotency records past the retention bound', () => {
    const e = new SyncAuthorityEngine();
    e.push(principal(), push([change()], 'idem-retain-0001'), NOW);
    expect(e.snapshot().idempotencyCount).toBe(1);
    e.push(principal(), push([change({ id: ROW2 })], 'idem-retain-0002'), NOW + IDEMPOTENCY_RETENTION_MS + 1);
    expect(e.snapshot().idempotencyCount).toBe(1);
  });
  it('treats an identical redelivery as a no-op rather than a conflict', () => {
    const e = new SyncAuthorityEngine();
    e.push(principal(), push([change()]), NOW);
    const r = e.push(principal(), push([change()]), NOW);
    expect(r).toMatchObject({ accepted: 0, conflicts: 0 });
  });
  it('server-stamps actor and time on append rows and rejects client-supplied actor fields', () => {
    const e = new SyncAuthorityEngine();
    const w = (value: unknown) => ({ value, hlc: hlc(NOW), baseHlc: null });
    const good = change({
      table: 'audit_events',
      op: 'append',
      fields: { action: w('login'), target_type: w('user') },
    });
    const forged = change({
      table: 'audit_events',
      op: 'append',
      id: ROW2,
      fields: { action: w('x'), actor_id: w(T2) },
    });
    const forgedTime = change({
      table: 'audit_events',
      op: 'append',
      id: ROW2,
      fields: { action: w('x'), occurred_at: w('2000-01-01') },
    });
    const unlisted = change({
      table: 'domain_events',
      op: 'append',
      fields: { event_type: w('e'), evil: w(1) },
    });
    const r = e.push(principal(), push([good, forged, forgedTime, unlisted]), NOW);
    expect(r.rejected.map((x) => x.code)).toEqual(['ACTOR_FIELD', 'ACTOR_FIELD', 'INVALID_ROW']);
    const stored = e.snapshot().log[0]?.change.fields;
    expect(stored?.['actor_id']?.value).toBe(U1);
    expect(stored?.['occurred_at']?.value).toBe(new Date(NOW).toISOString());
  });
  it('keeps approval_decisions server-only and denies read-only roles append', () => {
    const e = new SyncAuthorityEngine();
    const row = change({ table: 'approval_decisions', op: 'append', fields: {} });
    expect(e.push(principal(), push([row]), NOW).rejected[0]?.code).toBe('SERVER_AUTHORITY');
    const audit = change({
      table: 'audit_events',
      op: 'append',
      fields: { action: { value: 'a', hlc: hlc(NOW), baseHlc: null } },
    });
    const viewer = principal({ membership: membership({ role: 'viewer', permissions: [] }) });
    expect(e.push(viewer, push([audit]), NOW).rejected[0]?.code).toBe('PERMISSION_DENIED');
  });
  it('pages conflict history', () => {
    const e = new SyncAuthorityEngine();
    e.push(
      principal(),
      push([change({ fields: { title: { value: 'n', hlc: hlc(NOW, 9), baseHlc: null } } })]),
      NOW,
    );
    for (let i = 0; i < 3; i += 1) {
      e.push(
        principal(),
        push([change({ fields: { title: { value: `o${i}`, hlc: hlc(NOW, i), baseHlc: null } } })]),
        NOW,
      );
    }
    const first = e.conflictPage(0, 2);
    expect(first?.items).toHaveLength(2);
    expect(first?.more).toBe(true);
    expect(e.conflictPage(first?.items.at(-1)?.id ?? 0, 2)?.more).toBe(false);
    expect(e.conflictPage(-1, 2)).toBeNull();
  });
});

describe('pull and request parsing', () => {
  it('rejects tampered cursors and pages with more=true', () => {
    const e = new SyncAuthorityEngine();
    e.push(principal(), push([change(), change({ id: ROW2 })]), NOW);
    expect(e.pull('not-a-cursor')).toBeNull();
    const page = e.pull(undefined, 1);
    expect(page?.more).toBe(true);
    expect(e.pull(page?.cursor, 1)?.more).toBe(false);
    expect(e.pull(undefined, 0)).toBeNull();
  });
  it('parseSyncPush rejects wrong versions, bad keys and oversize payloads', () => {
    expect(parseSyncPush(push([change()]))).not.toBeNull();
    expect(parseSyncPush({ ...push([change()]), protocolVersion: 99 })).toBeNull();
    expect(parseSyncPush({ ...push([change()]), idempotencyKey: 'short' })).toBeNull();
    expect(parseSyncPush(null)).toBeNull();
    const big = change({ fields: { title: { value: 'x'.repeat(1_100_000), hlc: hlc(NOW), baseHlc: null } } });
    expect(parseSyncPush(push([big]))).toBeNull();
  });
});

describe('leases', () => {
  it('serializes competing acquisitions: one holder wins, the other is refused', () => {
    let book: LeaseBook = emptyLeaseBook();
    const first = acquireLease(book, 'job:1', 'a', 10_000, NOW);
    expect(first).not.toBeNull();
    if (first) book = { leases: { [first.key]: first } };
    expect(acquireLease(book, 'job:1', 'b', 10_000, NOW + 1)).toBeNull();
    expect(acquireLease(book, 'job:1', 'a', 10_000, NOW + 1)).not.toBeNull();
  });
  it('lets an expired lease be taken and refuses renewal after expiry or by a non-holder', () => {
    const book: LeaseBook = { leases: { 'job:1': { key: 'job:1', holder: 'a', expiresAtMs: NOW + 10_000 } } };
    expect(renewLease(book, 'job:1', 'b', 10_000, NOW)).toBeNull();
    expect(renewLease(book, 'job:1', 'a', 10_000, NOW + 10_000)).toBeNull();
    expect(acquireLease(book, 'job:1', 'b', 10_000, NOW + 10_000)?.holder).toBe('b');
  });
  it('rejects invalid ttl and keys', () => {
    expect(acquireLease(emptyLeaseBook(), 'k', 'a', 1, NOW)).toBeNull();
    expect(acquireLease(emptyLeaseBook(), 'bad key!', 'a', 10_000, NOW)).toBeNull();
  });
});

describe('blob references', () => {
  const secret = 'test-secret-value';
  it('scopes keys to tenant/workspace and rejects traversal names', () => {
    expect(tenantWorkspaceKey(T1, W1, 'a.png')).toBe(`${T1}/${W1}/a.png`);
    expect(tenantWorkspaceKey(T1, W1, '../x')).toBeNull();
    expect(tenantWorkspaceKey(T1, W1, 'a/b')).toBeNull();
  });
  it('round-trips a signed ref and rejects tamper, wrong secret and expiry', async () => {
    const access = {
      key: `${T1}/${W1}/a.png`,
      principalId: U1,
      mode: 'GET' as const,
      expiresAtMs: NOW + 60_000,
    };
    const token = await signBlobAccess(access, secret);
    expect(await verifyBlobAccess(token, secret, NOW)).toEqual(access);
    expect(await verifyBlobAccess(token, 'other', NOW)).toBeNull();
    expect(await verifyBlobAccess(token, secret, NOW + 60_001)).toBeNull();
    const sig = token.split('.')[1];
    const forged = b64(JSON.stringify({ ...access, key: `${T2}/${W2}/a.png` }));
    expect(await verifyBlobAccess(`${forged}.${sig}`, secret, NOW)).toBeNull();
  });
});
