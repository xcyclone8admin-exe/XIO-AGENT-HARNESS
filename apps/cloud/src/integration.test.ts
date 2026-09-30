/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON responses from the Worker under test */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Drives the REAL bundled Worker and its SQLite-backed WorkspaceHub Durable Object on workerd
 * through HTTP and WebSocket. No mocks of the DO. Neon/R2-live remain out of scope (no credentials);
 * R2 here is Miniflare's local emulation.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const outDir = path.join(appDir, 'dist');

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const W1 = '33333333-3333-4333-8333-333333333333';
const U1 = '55555555-5555-4555-8555-555555555555';
const U2 = '88888888-8888-4888-8888-888888888888';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTERNAL = 'internal-token-for-tests';
const URL_BASE = 'http://cloud.test';

let mf: Miniflare;
let privateKey: CryptoKey;

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const hlc = (ms: number, counter = 0) =>
  `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-nodea`;

async function mint(sub: string, over: Record<string, unknown> = {}, key = privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64(
    JSON.stringify({
      sub,
      kind: 'user',
      tenant_id: T1,
      workspace_ids: [W1],
      active_workspace: W1,
      autonomy_level: 1,
      iat: now,
      exp: now + 900,
      aud: 'xyra-cloud',
      iss: 'xyra-auth',
      ...over,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64(sig)}`;
}

async function hub(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'x-hub-internal-token': INTERNAL },
) {
  const ns = await mf.getDurableObjectNamespace('HUB');
  return ns
    .get(ns.idFromName(W1))
    .fetch(`http://hub${path}`, { method: 'POST', body: JSON.stringify(body), headers });
}

const seed = (principalId: string, over: Record<string, unknown> = {}) =>
  hub('/internal/membership/upsert', {
    membership: {
      principalId,
      tenantId: T1,
      workspaceId: W1,
      role: 'owner',
      permissions: [],
      ...over,
    },
  });

const setKill = (engaged: boolean) =>
  hub('/internal/kill-switch/set', {
    killSwitch: {
      engaged,
      scope: 'workspace',
      reason: 'test',
      changedBy: null,
      changedAt: new Date().toISOString(),
    },
  });

async function call(
  method: string,
  route: string,
  token: string | null,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await mf.dispatchFetch(`${URL_BASE}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

let n = 0;
const pushBody = (changes: unknown[], key = `idem-int-${String(++n).padStart(10, '0')}`) => ({
  protocolVersion: 1,
  schemaVersion: 'cloud-sync-v1',
  nodeId: 'nodea',
  idempotencyKey: key,
  changes,
});
const task = (id: string, over: Record<string, unknown> = {}) => ({
  table: 'ops_tasks',
  id,
  tenantId: T1,
  workspaceId: W1,
  op: 'upsert',
  hlc: hlc(Date.now()),
  fields: { title: { value: 'hello', hlc: hlc(Date.now()), baseHlc: null } },
  ...over,
});
/** Real HTTP to workerd's socket so Content-Length reaches the Worker as an edge client would send it. */
async function rawPut(url: string, body: string): Promise<Response> {
  const base = await mf.ready;
  return fetch(new URL(new URL(url).pathname, base), { method: 'PUT', body });
}
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

beforeAll(async () => {
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outDir], {
    cwd: appDir,
    shell: true,
    stdio: 'pipe',
  });
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: outDir,
      scriptPath: path.join(outDir, 'index.js'),
      compatibilityDate: '2026-09-30',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { HUB: { className: 'WorkspaceHub', useSQLite: true } },
      r2Buckets: ['BLOBS'],
      kvNamespaces: ['CACHE'],
      queueProducers: { JOBS: 'jobs' },
      bindings: {
        AUTH_JWT_JWK: jwk,
        AUTH_JWT_AUDIENCE: 'xyra-cloud',
        AUTH_JWT_ISSUER: 'xyra-auth',
        BLOB_ACCESS_SECRET: 'blob-secret-for-tests',
        HUB_INTERNAL_TOKEN: INTERNAL,
        BLOB_MAX_BYTES: '16',
      },
    }),
  );
  await mf.ready;
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('auth on the real Worker', () => {
  it('fails closed without or with bad credentials', async () => {
    expect((await call('GET', '/v1/sync/pull', null)).status).toBe(401);
    expect((await call('GET', '/v1/sync/pull', 'a.b.c')).status).toBe(401);
    const other = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const forged = await mint(U1, {}, other.privateKey);
    expect(await call('GET', '/v1/sync/pull', forged)).toMatchObject({
      status: 401,
      json: { code: 'INVALID_SIGNATURE' },
    });
  });
  it('rejects a valid token when the Hub has no current membership', async () => {
    const res = await call('GET', '/v1/sync/pull', await mint('99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(403);
  });
  it('protects internal Hub routes with the internal token', async () => {
    expect((await hub('/internal/membership/upsert', {}, { 'x-hub-internal-token': 'wrong' })).status).toBe(
      403,
    );
    expect((await hub('/internal/kill-switch/set', {}, {})).status).toBe(403);
  });
});

describe('sync on workerd', () => {
  it('round-trips push/pull, replays idempotently and rejects payload mismatch', async () => {
    await seed(U1);
    const token = await mint(U1);
    const body = pushBody([task(uuid(1))], 'idem-roundtrip-0001');
    const first = await call('POST', '/v1/sync/push', token, body);
    expect(first.json).toMatchObject({ accepted: 1, replayed: false });
    const replay = await call('POST', '/v1/sync/push', token, body);
    expect(replay.json).toMatchObject({ accepted: 1, replayed: true });
    const mismatch = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([task(uuid(2))], 'idem-roundtrip-0001'),
    );
    expect(mismatch).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const pulled = await call('GET', '/v1/sync/pull', token);
    expect(pulled.json?.['changes'].map((c: any) => c.change.id)).toContain(uuid(1));
    const after = await call('GET', `/v1/sync/pull?cursor=${pulled.json?.['cursor']}`, token);
    expect(after.json?.['changes']).toEqual([]);
  });
  it('rejects cross-tenant rows and guarded fields per row', async () => {
    await seed(U1);
    const token = await mint(U1);
    const res = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([
        task(uuid(3), { tenantId: T2 }),
        task(uuid(4), { fields: { status: { value: 'done', hlc: hlc(Date.now()), baseHlc: null } } }),
      ]),
    );
    expect(res.json?.['rejected'].map((r: any) => r.code)).toEqual(['AUTH_SCOPE_MISMATCH', 'GUARDED_FIELD']);
    expect(res.json?.['accepted']).toBe(0);
  });
  it('honors membership revoked mid-session', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    await seed(id);
    const token = await mint(id);
    expect((await call('POST', '/v1/sync/push', token, pushBody([task(uuid(5))]))).status).toBe(200);
    await seed(id, { revokedAtMs: Date.now() - 1 });
    expect((await call('POST', '/v1/sync/push', token, pushBody([task(uuid(6))]))).status).toBe(403);
    expect((await call('GET', '/v1/sync/pull', token)).status).toBe(403);
  });
  it('retains conflict history and pages it', async () => {
    await seed(U1);
    const token = await mint(U1);
    const now = Date.now();
    await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([task(uuid(7), { fields: { title: { value: 'new', hlc: hlc(now, 5), baseHlc: null } } })]),
    );
    const r = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([task(uuid(7), { fields: { title: { value: 'old', hlc: hlc(now, 1), baseHlc: null } } })]),
    );
    expect(r.json).toMatchObject({ conflicts: 1 });
    const page = await call('GET', '/v1/sync/conflicts?limit=1', token);
    expect(page.json?.['items'][0].record).toMatchObject({ rowId: uuid(7), losingValue: 'old' });
  });
  it('stamps the actor on appended audit rows', async () => {
    await seed(U1);
    const token = await mint(U1);
    const w = (value: unknown) => ({ value, hlc: hlc(Date.now()), baseHlc: null });
    const row = {
      table: 'audit_events',
      id: uuid(8),
      tenantId: T1,
      workspaceId: W1,
      op: 'append',
      hlc: hlc(Date.now()),
      fields: { action: w('x'), target_type: w('t') },
    };
    const forged = { ...row, id: uuid(9), fields: { ...row.fields, actor_id: w(U2) } };
    const res = await call('POST', '/v1/sync/push', token, pushBody([row, forged]));
    expect(res.json?.['rejected'].map((r: any) => r.code)).toEqual(['ACTOR_FIELD']);
    const pulled = await call('GET', '/v1/sync/pull', token);
    const stored = pulled.json?.['changes'].find((c: any) => c.change.id === uuid(8));
    expect(stored.change.fields.actor_id.value).toBe(U1);
  });
  it('keeps working after state grows past 2 MB', async () => {
    await seed(U1);
    const token = await mint(U1);
    const blob = 'x'.repeat(900_000);
    for (let i = 0; i < 4; i += 1) {
      const res = await call(
        'POST',
        '/v1/sync/push',
        token,
        pushBody([
          task(uuid(100 + i), {
            fields: { description: { value: blob, hlc: hlc(Date.now()), baseHlc: null } },
          }),
        ]),
      );
      expect(res.status).toBe(200);
      expect(res.json?.['accepted']).toBe(1);
    }
    const small = await call('POST', '/v1/sync/push', token, pushBody([task(uuid(200))]));
    expect(small.json).toMatchObject({ accepted: 1 });
    const pulled = await call('GET', '/v1/sync/pull', token);
    expect(pulled.status).toBe(200);
    expect(pulled.json?.['changes'].length).toBeGreaterThan(4);
  }, 60_000);
});

describe('leases and kill switch on workerd', () => {
  it('serializes lease contention and refuses while the kill switch is engaged', async () => {
    await setKill(false);
    await seed(U1);
    await seed(U2);
    const [a, b] = [await mint(U1), await mint(U2)];
    const results = await Promise.all([
      call('POST', '/v1/leases/acquire', a, { key: 'job:race', ttlMs: 30_000 }),
      call('POST', '/v1/leases/acquire', b, { key: 'job:race', ttlMs: 30_000 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await setKill(true);
    expect((await call('POST', '/v1/leases/acquire', a, { key: 'job:other', ttlMs: 30_000 })).status).toBe(
      423,
    );
    await setKill(false);
  });
  it('blocks agent pushes while engaged but not user pushes', async () => {
    await seed(AGENT, { role: 'member', permissions: ['ops:task:write'] });
    await seed(U1);
    await setKill(true);
    const agent = await mint(AGENT, { kind: 'agent' });
    expect(await call('POST', '/v1/sync/push', agent, pushBody([task(uuid(300))]))).toMatchObject({
      status: 423,
      json: { code: 'KILL_SWITCH_ENGAGED' },
    });
    expect((await call('POST', '/v1/sync/push', await mint(U1), pushBody([task(uuid(301))]))).status).toBe(
      200,
    );
    await setKill(false);
    expect((await call('POST', '/v1/sync/push', agent, pushBody([task(uuid(302))]))).status).toBe(200);
  });
  it('delivers kill-switch state over a hibernatable WebSocket within 5 s and closes on revocation', async () => {
    await setKill(false);
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await seed(id);
    const denied = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: { upgrade: 'websocket' },
    });
    expect(denied.status).toBe(401);
    const res = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: { upgrade: 'websocket', authorization: `Bearer ${await mint(id)}` },
    });
    expect(res.status).toBe(101);
    const socket = res.webSocket;
    if (!socket) throw new Error('no websocket');
    const messages: any[] = [];
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    socket.accept();
    const waitFor = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < 5_000) await new Promise((r) => setTimeout(r, 25));
      return predicate();
    };
    expect(await waitFor(() => messages.length >= 1)).toBe(true);
    expect(messages[0].killSwitch.engaged).toBe(false);
    const started = Date.now();
    await setKill(true);
    expect(await waitFor(() => messages.some((m) => m.killSwitch?.engaged === true))).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await setKill(false);
    await seed(id, { revokedAtMs: Date.now() - 1 });
    // The revoked principal's socket is closed server-side: it receives no further fan-out and cannot reconnect.
    // (Miniflare's client does not surface the close frame as an event, so absence of delivery is asserted.)
    const before = messages.length;
    await setKill(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(messages.length).toBe(before);
    const retry = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: { upgrade: 'websocket', authorization: `Bearer ${await mint(id)}` },
    });
    expect(retry.status).toBe(403);
    await setKill(false);
  });
});

describe('blob references on workerd', () => {
  const ref = (token: string, body: Record<string, unknown>) => call('POST', '/v1/blobs/ref', token, body);
  it('enforces TTL cap, length, membership and kill-switch at redemption', async () => {
    await setKill(false);
    await seed(U1);
    const token = await mint(U1);
    expect((await ref(token, { mode: 'PUT', name: 'a.txt', expiresInSec: 301 })).status).toBe(403);
    const put = await ref(token, { mode: 'PUT', name: 'a.txt', expiresInSec: 120 });
    expect(put.status).toBe(200);
    const url = `${URL_BASE}${put.json?.['url']}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'));
        controller.close();
      },
    });
    const noLength = await mf.dispatchFetch(url, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    } as never);
    expect(noLength.status).toBe(411);
    const oversize = 17;
    const tooBig = await rawPut(url, 'a'.repeat(oversize));
    expect(tooBig.status).toBe(413);
    expect(
      (
        await mf.dispatchFetch(url, {
          method: 'PUT',
          headers: { 'content-length': '10' },
          body: 'hello blob',
        })
      ).status,
    ).toBe(204);
    const get = await ref(token, { mode: 'GET', name: 'a.txt', expiresInSec: 120 });
    const read = await mf.dispatchFetch(`${URL_BASE}${get.json?.['url']}`);
    expect(await read.text()).toBe('hello blob');
    await setKill(true);
    expect((await mf.dispatchFetch(`${URL_BASE}${get.json?.['url']}`)).status).toBe(423);
    await setKill(false);
    await seed(U1, { revokedAtMs: Date.now() - 1 });
    expect((await mf.dispatchFetch(`${URL_BASE}${get.json?.['url']}`)).status).toBe(403);
    await seed(U1);
  });
});
