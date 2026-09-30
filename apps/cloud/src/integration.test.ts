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
const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INTERNAL = 'internal-token-for-tests';
const URL_BASE = 'http://cloud.test';

let mf: Miniflare;
let privateKey: CryptoKey;
const fixtureMemberships = new Map<string, Record<string, any>>();
const fixtureDpopReplays = new Set<string>();
const deviceKeyPairs = new Map<string, CryptoKeyPair>();

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
async function deviceKey(deviceId: string): Promise<CryptoKeyPair> {
  let pair = deviceKeyPairs.get(deviceId);
  if (!pair) {
    pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    deviceKeyPairs.set(deviceId, pair);
  }
  return pair;
}

async function thumbprint(deviceId: string): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', (await deviceKey(deviceId)).publicKey);
  const canonical = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x });
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))));
}

const hlc = (ms: number, counter = 0) =>
  `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-nodea`;

async function mint(sub: string, over: Record<string, unknown> = {}, key = privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const deviceId = typeof over['device_id'] === 'string' ? over['device_id'] : DEVICE_A;
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
      device_id: deviceId,
      cnf: { jkt: await thumbprint(deviceId) },
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

async function dpop(token: string, method: string, route: string): Promise<string> {
  let payload: { device_id: string };
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      device_id: string;
    };
  } catch {
    return '';
  }
  if (typeof payload.device_id !== 'string') return '';
  const pair = await deviceKey(payload.device_id);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const url = new URL(route, URL_BASE);
  url.search = '';
  url.hash = '';
  const header = b64(
    JSON.stringify({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } }),
  );
  const ath = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
  const body = b64(
    JSON.stringify({
      htu: url.toString(),
      htm: method.toUpperCase(),
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      ath,
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${b64(signature)}`;
}

async function protectedHeaders(
  method: string,
  route: string,
  token: string,
): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${token}`,
    dpop: await dpop(token, method, route),
  };
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

const seed = (principalId: string, over: Record<string, unknown> = {}) => {
  const membership = {
    principalId,
    tenantId: T1,
    workspaceId: W1,
    role: 'owner',
    permissions: [],
    ...over,
  };
  fixtureMemberships.set(principalId, membership);
  return hub('/internal/membership/upsert', { membership });
};

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
  if (route.startsWith('/v1/sync/pull') && !route.includes('protocolVersion='))
    route += `${route.includes('?') ? '&' : '?'}protocolVersion=1&schemaVersion=cloud-sync-v1`;
  const headers: Record<string, string> = { ...extra };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
    const proof = await dpop(token, method, route);
    if (proof) headers['dpop'] = proof;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await mf.dispatchFetch(`${URL_BASE}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

async function findPulled(token: string, id: string, field?: string): Promise<any> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await call('GET', `/v1/sync/pull${cursor ? `?cursor=${cursor}` : ''}`, token);
    if (result.status !== 200) throw new Error(`pull failed: ${JSON.stringify(result)}`);
    const found = result.json?.['changes'].find(
      (c: any) => c.change.id === id && (!field || field in c.change.fields),
    );
    if (found) return found;
    if (!result.json?.['more']) break;
    cursor = result.json?.['cursor'];
  }
  return null;
}

let n = 0;
const pushBody = (changes: unknown[], key = `idem-int-${String(++n).padStart(10, '0')}`) => ({
  protocolVersion: 1,
  schemaVersion: 'cloud-sync-v1',
  nodeId: 'nodea',
  idempotencyKey: key,
  changes,
});
const task = (id: string, over: Record<string, unknown> = {}) => {
  const stamp = hlc(Date.now());
  const fields = {
    project_id: { value: PROJECT, hlc: stamp, baseHlc: null },
    title: { value: 'hello', hlc: stamp, baseHlc: null },
    ...(over['fields'] as Record<string, unknown> | undefined),
  };
  return {
    table: 'ops_tasks',
    id,
    tenantId: T1,
    workspaceId: W1,
    op: 'upsert',
    hlc: stamp,
    ...over,
    fields,
  };
};
const project = () => {
  const stamp = hlc(Date.now());
  return {
    table: 'ops_projects',
    id: PROJECT,
    tenantId: T1,
    workspaceId: W1,
    op: 'upsert',
    hlc: stamp,
    fields: { name: { value: 'Fixture project', hlc: stamp, baseHlc: null } },
  };
};
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
      serviceBindings: {
        CLOUD_TEST_AUTHORITY: async (request: Request) => {
          let input: any;
          try {
            input = await request.json();
          } catch {
            return Response.json({ code: 'INVALID_REQUEST' }, { status: 400 });
          }
          const path = new URL(request.url).pathname;
          if (path === '/dpop') {
            const key = `${input?.tenantId}:${input?.deviceId}:${input?.jtiHashHex}`;
            if (!input?.jtiHashHex || fixtureDpopReplays.has(key))
              return Response.json({ code: 'DPOP_REPLAYED' }, { status: 409 });
            fixtureDpopReplays.add(key);
            return Response.json({ ok: true });
          }
          if (path !== '/resolve') return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
          const claims = input?.claims;
          if (!claims || typeof claims.principalId !== 'string')
            return Response.json({ code: 'INVALID_CLAIMS' }, { status: 400 });
          const membership = fixtureMemberships.get(claims.principalId);
          if (
            !membership ||
            (typeof membership.revokedAtMs === 'number' && membership.revokedAtMs <= Date.now()) ||
            membership.tenantId !== claims.tenantId ||
            membership.workspaceId !== claims.activeWorkspaceId ||
            (membership.kind ?? 'user') !== claims.kind
          ) {
            return Response.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, { status: 404 });
          }
          const delegator =
            typeof membership.delegatedBy === 'string'
              ? fixtureMemberships.get(membership.delegatedBy)
              : undefined;
          if (
            membership.kind === 'agent' &&
            (!delegator ||
              (typeof delegator.revokedAtMs === 'number' && delegator.revokedAtMs <= Date.now()) ||
              delegator.tenantId !== membership.tenantId ||
              delegator.workspaceId !== membership.workspaceId)
          ) {
            return Response.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, { status: 404 });
          }
          return Response.json({ membership, ...(delegator ? { delegator } : {}) });
        },
      },
      bindings: {
        AUTH_JWT_JWK: jwk,
        AUTH_JWT_AUDIENCE: 'xyra-cloud',
        AUTH_JWT_ISSUER: 'xyra-auth',
        BLOB_ACCESS_SECRET: 'blob-secret-for-tests',
        HUB_INTERNAL_TOKEN: INTERNAL,
        BLOB_MAX_BYTES: '16',
        QUOTA_PRINCIPAL_RPM: '100',
        QUOTA_PRINCIPAL_BYTES: '5000000',
        QUOTA_ENDPOINT_RPM: '200',
      },
    }),
  );
  await mf.ready;
  await seed(U1);
  const initialized = await call(
    'POST',
    '/v1/sync/push',
    await mint(U1),
    pushBody([project()], 'fixture-project-0001'),
  );
  if (initialized.json?.['accepted'] !== 1)
    throw new Error(`project fixture rejected: ${JSON.stringify(initialized)}`);
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('auth on the real Worker', () => {
  it('keeps PKCE/passkey and refresh issuance disabled without provisioned Neon and RP configuration', async () => {
    for (const route of [
      '/v1/auth/passkey/begin',
      '/v1/auth/passkey/complete',
      '/v1/auth/passkey/register/begin',
      '/v1/auth/passkey/register/complete',
      '/v1/auth/token',
      '/v1/auth/refresh',
    ]) {
      const result = await call('POST', route, null, {});
      expect(result).toMatchObject({ status: 503, json: { code: 'AUTH_NOT_CONFIGURED' } });
    }
    expect(
      await call('POST', '/v1/auth/passkey/begin', null, { ignored: 'x'.repeat(600_000) }),
    ).toMatchObject({ status: 413, json: { code: 'AUTH_BODY_TOO_LARGE' } });
  });
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
  it('rejects reuse of the same valid device proof at the HTTP boundary', async () => {
    await seed(U1);
    const token = await mint(U1);
    const route = '/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1';
    const headers = await protectedHeaders('GET', route, token);
    const first = await mf.dispatchFetch(`${URL_BASE}${route}`, { headers });
    expect(first.status).toBe(200);
    const replay = await mf.dispatchFetch(`${URL_BASE}${route}`, { headers });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: 'DPOP_REPLAYED' });
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
      pushBody([
        task(uuid(7), {
          hlc: hlc(now, 5),
          fields: {
            project_id: { value: PROJECT, hlc: hlc(now, 5), baseHlc: null },
            title: { value: 'new', hlc: hlc(now, 5), baseHlc: null },
          },
        }),
      ]),
    );
    const r = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([
        {
          ...task(uuid(7)),
          hlc: hlc(now, 1),
          fields: { title: { value: 'old', hlc: hlc(now, 1), baseHlc: null } },
        },
      ]),
    );
    expect(r.json).toMatchObject({ conflicts: 1 });
    const page = await call('GET', '/v1/sync/conflicts?limit=1', token);
    expect(page.json?.['items'][0].record).toMatchObject({ rowId: uuid(7), losingValue: 'old' });
  });
  it('stamps the actor on appended audit rows', async () => {
    await seed(U1);
    const token = await mint(U1);
    const stamp = hlc(Date.now());
    const w = (value: unknown) => ({ value, hlc: stamp, baseHlc: null });
    const row = {
      table: 'audit_events',
      id: uuid(8),
      tenantId: T1,
      workspaceId: W1,
      op: 'append',
      hlc: stamp,
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
    const [a, b] = [await mint(U1, { device_id: DEVICE_A }), await mint(U2, { device_id: DEVICE_B })];
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
    await seed(AGENT, {
      kind: 'agent',
      delegatedBy: U1,
      autonomy: 2,
      role: 'member',
      permissions: ['ops:task:write'],
    });
    await seed(U1);
    await setKill(true);
    const agent = await mint(AGENT, { kind: 'agent', delegated_by: U1, autonomy_level: 2 });
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
    const token = await mint(id);
    const res = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: { upgrade: 'websocket', ...(await protectedHeaders('GET', '/v1/workspace/events', token)) },
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
    const retryToken = await mint(id);
    const retry = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: {
        upgrade: 'websocket',
        ...(await protectedHeaders('GET', '/v1/workspace/events', retryToken)),
      },
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

describe('cycle-1 review regressions on real workerd HTTP', () => {
  it('CLD-R-001 rejects a lease body that tries to replace verified claims', async () => {
    await setKill(false);
    await seed(U1);
    const token = await mint(U1, { device_id: DEVICE_A });
    const forged = await call('POST', '/v1/leases/acquire', token, {
      key: 'review:claim-override',
      ttlMs: 30_000,
      claims: { principalId: U2, tenantId: T2, activeWorkspaceId: W1 },
    });
    expect(forged).toMatchObject({ status: 400, json: { code: 'INVALID_LEASE_REQUEST' } });
    const real = await call('POST', '/v1/leases/acquire', token, {
      key: 'review:claim-override',
      ttlMs: 30_000,
    });
    expect(real.status).toBe(200);
    expect(real.json?.['lease']).toMatchObject({ principalId: U1, deviceId: DEVICE_A });
  });

  it('CLD-R-002 serializes two devices of one user and rejects stale renewal', async () => {
    await seed(U1);
    const a = await mint(U1, { device_id: DEVICE_A });
    const b = await mint(U1, { device_id: DEVICE_B });
    const key = 'review:same-user-devices';
    const first = await call('POST', '/v1/leases/acquire', a, { key, ttlMs: 5_000 });
    expect(first.status).toBe(200);
    const old = first.json?.['lease'];
    expect((await call('POST', '/v1/leases/acquire', b, { key, ttlMs: 5_000 })).status).toBe(409);
    expect((await call('POST', '/v1/leases/renew', b, { key, token: old.token, ttlMs: 5_000 })).status).toBe(
      409,
    );
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const next = await call('POST', '/v1/leases/acquire', b, { key, ttlMs: 5_000 });
    expect(next.status).toBe(200);
    expect(next.json?.['lease'].fence).toBeGreaterThan(old.fence);
    expect((await call('POST', '/v1/leases/renew', a, { key, token: old.token, ttlMs: 5_000 })).status).toBe(
      409,
    );
  }, 12_000);

  it('CLD-R-003 filters pull and advances a cursor past unreadable audit rows', async () => {
    await seed(U2, { role: 'member', permissions: [] });
    const author = await mint(U1);
    const reader = await mint(U2);
    const stamp = hlc(Date.now());
    const id = uuid(400);
    const write = (value: unknown) => ({ value, hlc: stamp, baseHlc: null });
    const audit = {
      table: 'audit_events',
      id,
      tenantId: T1,
      workspaceId: W1,
      op: 'append',
      hlc: stamp,
      fields: { action: write('secret'), target_type: write('workspace') },
    };
    expect((await call('POST', '/v1/sync/push', author, pushBody([audit]))).json?.['accepted']).toBe(1);
    const hidden = await call('GET', '/v1/sync/pull', reader);
    expect(hidden.status).toBe(200);
    expect(hidden.json?.['changes'].some((c: any) => c.change.id === id)).toBe(false);
    const next = await call('GET', `/v1/sync/pull?cursor=${hidden.json?.['cursor']}`, reader);
    expect(next.json?.['changes']).toEqual([]);
    expect(
      (await call('GET', '/v1/sync/pull', author)).json?.['changes'].some((c: any) => c.change.id === id),
    ).toBe(true);
    expect((await call('GET', '/v1/sync/conflicts', reader)).status).toBe(200);
  });

  it('CLD-R-003 filters real ops conflict records by agent read grants and advances conflict cursor', async () => {
    const writer = '48484848-4848-4484-8484-484848484848';
    const agent = '49494949-4949-4494-8494-494949494949';
    await seed(writer, { role: 'owner' });
    await seed(agent, {
      kind: 'agent',
      delegatedBy: writer,
      autonomy: 2,
      role: 'member',
      permissions: ['ops:task:write'],
    });
    const ownerToken = await mint(writer);
    const agentToken = await mint(agent, { kind: 'agent', delegated_by: writer, autonomy_level: 2 });
    const before = await call('GET', '/v1/sync/conflicts?limit=200', ownerToken);
    expect(before.status).toBe(200);
    const after = Number(before.json?.['next']);
    const id = uuid(470);
    const ms = Date.now();
    const oldHlc = hlc(ms, 1);
    const newHlc = hlc(ms, 2);
    const first = task(id, {
      hlc: oldHlc,
      fields: {
        project_id: { value: PROJECT, hlc: oldHlc, baseHlc: null },
        title: { value: 'restricted-losing-value-470', hlc: oldHlc, baseHlc: null },
      },
    });
    expect((await call('POST', '/v1/sync/push', ownerToken, pushBody([first]))).json?.['accepted']).toBe(1);
    const winner = {
      ...task(id),
      hlc: newHlc,
      fields: { title: { value: 'authorized-winning-value-470', hlc: newHlc, baseHlc: null } },
    };
    const push = await call('POST', '/v1/sync/push', ownerToken, pushBody([winner]));
    expect(push.json?.['conflictHistory']).toContainEqual(
      expect.objectContaining({ rowId: id, field: 'title', losingValue: 'restricted-losing-value-470' }),
    );

    const ownerPage = await call('GET', `/v1/sync/conflicts?after=${after}&limit=20`, ownerToken);
    expect(ownerPage.json?.['items']).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({ rowId: id, losingValue: 'restricted-losing-value-470' }),
      }),
    );
    const restrictedPage = await call('GET', `/v1/sync/conflicts?after=${after}&limit=20`, agentToken);
    expect(restrictedPage.status).toBe(200);
    expect(restrictedPage.json?.['items']).toEqual([]);
    expect(restrictedPage.json?.['next']).toBeGreaterThan(after);
    expect(JSON.stringify(restrictedPage.json)).not.toContain(id);
    expect(JSON.stringify(restrictedPage.json)).not.toContain('restricted-losing-value-470');
  });

  it('CLD-R-004 denies L0 agent writes and lost delegator grants', async () => {
    const delegated = 'abababab-abab-4bab-8bab-abababababab';
    await seed(delegated, { role: 'manager', permissions: [] });
    await seed(AGENT, {
      kind: 'agent',
      delegatedBy: delegated,
      autonomy: 2,
      role: 'member',
      permissions: ['ops:task:write'],
    });
    const l0 = await mint(AGENT, { kind: 'agent', delegated_by: delegated, autonomy_level: 0 });
    const denied = await call('POST', '/v1/sync/push', l0, pushBody([task(uuid(401))]));
    expect(denied.json?.['rejected'][0]).toMatchObject({ code: 'POLICY_DENIED' });
    const l2 = await mint(AGENT, { kind: 'agent', delegated_by: delegated, autonomy_level: 2 });
    const allowed = await call('POST', '/v1/sync/push', l2, pushBody([task(uuid(402))]));
    expect(allowed.json?.['accepted']).toBe(1);
    await seed(delegated, { role: 'viewer', permissions: [] });
    const removed = await call('POST', '/v1/sync/push', l2, pushBody([task(uuid(403))]));
    expect(removed.json?.['rejected'][0]).toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('CLD-R-005 rejects a field clock beyond the drift bound without poisoning later edits', async () => {
    const token = await mint(U1);
    const id = uuid(404);
    const future = hlc(Date.now() + 365 * 24 * 60 * 60_000);
    const bad = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([
        task(id, {
          fields: {
            title: { value: 'poison', hlc: future, baseHlc: null },
          },
        }),
      ]),
    );
    expect(bad.json?.['rejected'][0]).toMatchObject({ code: 'CLOCK_SKEW' });
    const good = await call('POST', '/v1/sync/push', token, pushBody([task(id)]));
    expect(good.json?.['accepted']).toBe(1);
  });

  it('CLD-R-006 records the loser in both arrival orders but not a sequential edit', async () => {
    const token = await mint(U1);
    const base = Date.now();
    const older = hlc(base, 1);
    const newer = hlc(base, 2);
    const initial = (id: string, title: string, stamp: string) =>
      task(id, {
        hlc: stamp,
        fields: {
          project_id: { value: PROJECT, hlc: stamp, baseHlc: null },
          title: { value: title, hlc: stamp, baseHlc: null },
        },
      });
    const update = (id: string, title: string, stamp: string, baseHlc: string | null) => ({
      ...task(id),
      hlc: stamp,
      fields: { title: { value: title, hlc: stamp, baseHlc } },
    });
    const a = uuid(405);
    expect(
      (await call('POST', '/v1/sync/push', token, pushBody([initial(a, 'old', older)]))).json?.['accepted'],
    ).toBe(1);
    const win = await call('POST', '/v1/sync/push', token, pushBody([update(a, 'new', newer, null)]));
    expect(win.json?.['conflictHistory']).toContainEqual(
      expect.objectContaining({ rowId: a, losingValue: 'old' }),
    );
    const sequential = await call(
      'POST',
      '/v1/sync/push',
      token,
      pushBody([update(a, 'next', hlc(base, 3), newer)]),
    );
    expect(sequential.json?.['conflicts']).toBe(0);
    const b = uuid(406);
    expect(
      (await call('POST', '/v1/sync/push', token, pushBody([initial(b, 'new', newer)]))).json?.['accepted'],
    ).toBe(1);
    const lose = await call('POST', '/v1/sync/push', token, pushBody([update(b, 'old', older, null)]));
    expect(lose.json?.['conflictHistory']).toContainEqual(
      expect.objectContaining({ rowId: b, losingValue: 'old' }),
    );
    const history = await call('GET', '/v1/sync/conflicts?limit=50', token);
    expect(
      history.json?.['items'].some((c: any) => c.record.rowId === a && c.record.losingValue === 'old'),
    ).toBe(true);
  });

  it('CLD-R-007 rejects invalid typed rows and orphan parents per row', async () => {
    const token = await mint(U1);
    const stamp = hlc(Date.now() + 10_000);
    const w = (value: unknown) => ({ value, hlc: stamp, baseHlc: null });
    const rows = [
      task(uuid(407), { hlc: stamp, fields: { title: w({ bad: true }) } }),
      task(uuid(408), { hlc: stamp, fields: { project_id: w('not-a-uuid') } }),
      task(uuid(409), { hlc: stamp, fields: { project_id: w(uuid(999)) } }),
      task(uuid(410), { hlc: stamp, fields: { title: w('valid') } }),
    ];
    const result = await call('POST', '/v1/sync/push', token, pushBody(rows));
    expect(result.json?.['rejected'].map((r: any) => r.code)).toEqual([
      'SCHEMA_VIOLATION',
      'SCHEMA_VIOLATION',
      'ORPHAN_REFERENCE',
    ]);
    expect(result.json?.['accepted']).toBe(1);
  });

  it('CLD-R-008 caps chunked ingress and pages pull by serialized bytes', async () => {
    const token = await mint(U1);
    const oversized = JSON.stringify({ ...pushBody([]), ignored: 'x'.repeat(2_000_000) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(oversized);
        controller.enqueue(bytes.slice(0, 900_000));
        controller.enqueue(bytes.slice(900_000));
        controller.close();
      },
    });
    const rejected = await mf.dispatchFetch(`${URL_BASE}/v1/sync/push`, {
      method: 'POST',
      headers: {
        ...(await protectedHeaders('POST', '/v1/sync/push', token)),
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
    } as never);
    expect(rejected.status).toBe(413);

    const reader = 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0';
    await seed(reader, { role: 'owner' });
    const readerToken = await mint(reader);
    for (let i = 0; i < 6; i += 1) {
      const result = await call(
        'POST',
        '/v1/sync/push',
        readerToken,
        pushBody([
          task(uuid(420 + i), {
            fields: { description: { value: 'x'.repeat(700_000), hlc: hlc(Date.now()), baseHlc: null } },
          }),
        ]),
      );
      expect(result.json?.['accepted']).toBe(1);
    }
    const page = await mf.dispatchFetch(
      `${URL_BASE}/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1`,
      {
        headers: await protectedHeaders(
          'GET',
          '/v1/sync/pull?protocolVersion=1&schemaVersion=cloud-sync-v1',
          readerToken,
        ),
      },
    );
    const raw = await page.text();
    const parsed = JSON.parse(raw) as Record<string, any>;
    expect(raw.length).toBeLessThan(4_100_000);
    expect(parsed['more']).toBe(true);
    const next = await call('GET', `/v1/sync/pull?cursor=${parsed['cursor']}`, readerToken);
    expect(next.json?.['changes'].length).toBeGreaterThan(0);
  }, 30_000);

  it('CLD-R-009 negotiates versions on push and pull with HTTP 426', async () => {
    const token = await mint(U1);
    expect(
      await call('POST', '/v1/sync/push', token, { ...pushBody([]), protocolVersion: 99 }),
    ).toMatchObject({
      status: 426,
      json: { code: 'UPDATE_REQUIRED', protocolVersion: 1, schemaVersion: 'cloud-sync-v1' },
    });
    const incompatible = await mf.dispatchFetch(
      `${URL_BASE}/v1/sync/pull?protocolVersion=99&schemaVersion=old`,
      {
        headers: await protectedHeaders('GET', '/v1/sync/pull?protocolVersion=99&schemaVersion=old', token),
      },
    );
    expect(incompatible.status).toBe(426);
    const missing = await mf.dispatchFetch(`${URL_BASE}/v1/sync/pull`, {
      headers: await protectedHeaders('GET', '/v1/sync/pull', token),
    });
    expect(missing.status).toBe(426);
    const supported = await call('GET', '/v1/sync/pull', token);
    expect(supported.json).toMatchObject({ protocolVersion: 1, schemaVersion: 'cloud-sync-v1' });
  });

  it('CLD-R-010 rejects a signed JWT before nbf while retaining bounded leeway', async () => {
    const now = Math.floor(Date.now() / 1000);
    const future = await mint(U1, { nbf: now + 600 });
    expect((await call('GET', '/v1/sync/pull', future)).status).toBe(401);
    const slight = await mint(U1, { nbf: now + 30 });
    expect((await call('GET', '/v1/sync/pull', slight)).status).toBe(200);
  });

  it('CLD-R-011 closes an expired socket before later protected broadcasts', async () => {
    await setKill(false);
    const id = '12121212-1212-4121-8121-121212121212';
    await seed(id);
    const expires = Math.floor(Date.now() / 1000) + 2;
    const token = await mint(id, { exp: expires });
    const response = await mf.dispatchFetch(`${URL_BASE}/v1/workspace/events`, {
      headers: { upgrade: 'websocket', ...(await protectedHeaders('GET', '/v1/workspace/events', token)) },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('missing websocket');
    const messages: unknown[] = [];
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    socket.accept();
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect((await call('GET', '/v1/sync/pull', token)).status).toBe(401);
    const before = messages.length;
    await setKill(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages.length).toBe(before);
    await setKill(false);
  }, 8_000);

  it('CLD-R-012 refuses inherited property names as tables', async () => {
    const principal = '15151515-1515-4151-8151-151515151515';
    await seed(principal, { role: 'owner' });
    const token = await mint(principal);
    const candidate = { ...task(uuid(440)), table: 'constructor', op: 'delete', fields: {} };
    const result = await call('POST', '/v1/sync/push', token, pushBody([candidate]));
    expect(result.json?.['rejected'][0]).toMatchObject({ code: 'UNKNOWN_TABLE' });
    expect(result.json?.['accepted']).toBe(0);
  });

  it('CLD-R-013 stamps immutable receipt time independently of client event time', async () => {
    const principal = '13131313-1313-4131-8131-131313131313';
    await seed(principal, { role: 'owner' });
    const token = await mint(principal);
    const before = Date.now();
    const stamp = hlc(before);
    const id = uuid(441);
    const w = (value: unknown) => ({ value, hlc: stamp, baseHlc: null });
    const audit = {
      table: 'audit_events',
      id,
      tenantId: T1,
      workspaceId: W1,
      op: 'append',
      hlc: stamp,
      fields: { action: w('review'), target_type: w('workspace'), occurred_at: w('2020-01-01T00:00:00Z') },
    };
    expect((await call('POST', '/v1/sync/push', token, pushBody([audit]))).json?.['accepted']).toBe(1);
    const forged = {
      ...audit,
      id: uuid(442),
      fields: { ...audit.fields, received_at: w('2020-01-01T00:00:00Z') },
    };
    expect((await call('POST', '/v1/sync/push', token, pushBody([forged]))).json?.['rejected'][0].code).toBe(
      'IMMUTABLE_FIELD',
    );
    const stored = (await findPulled(token, id))?.change.fields;
    expect(stored?.occurred_at.value).toBe('2020-01-01T00:00:00Z');
    expect(Date.parse(stored?.received_at.value)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored?.received_at.value)).toBeLessThanOrEqual(Date.now());
  });

  it('CLD-R-014 applies principal rate quota and compacts superseded log while retaining conflicts', async () => {
    const limited = '45454545-4545-4454-8454-454545454545';
    await seed(limited);
    const limitedToken = await mint(limited);
    let throttled = false;
    for (let i = 0; i < 105; i += 1) {
      const result = await call('GET', '/v1/sync/pull', limitedToken);
      if (result.status === 429) {
        throttled = true;
        break;
      }
      expect(result.status).toBe(200);
    }
    expect(throttled).toBe(true);

    const byteLimited = '46464646-4646-4464-8464-464646464646';
    await seed(byteLimited, { role: 'owner' });
    const byteToken = await mint(byteLimited);
    let byteThrottled = false;
    for (let i = 0; i < 7; i += 1) {
      const result = await call(
        'POST',
        '/v1/sync/push',
        byteToken,
        pushBody([
          task(uuid(460 + i), {
            fields: { description: { value: 'q'.repeat(900_000), hlc: hlc(Date.now()), baseHlc: null } },
          }),
        ]),
      );
      if (result.status === 429) {
        byteThrottled = true;
        break;
      }
      expect(result.json?.['accepted']).toBe(1);
    }
    expect(byteThrottled).toBe(true);

    const writer = '14141414-1414-4141-8141-141414141414';
    await seed(writer, { role: 'owner' });
    const token = await mint(writer);
    const id = uuid(443);
    const now = Date.now();
    const first = hlc(now, 1),
      second = hlc(now, 2),
      third = hlc(now, 3);
    const initial = task(id, {
      hlc: first,
      fields: {
        project_id: { value: PROJECT, hlc: first, baseHlc: null },
        title: { value: 'v1', hlc: first, baseHlc: null },
      },
    });
    expect((await call('POST', '/v1/sync/push', token, pushBody([initial]))).json?.['accepted']).toBe(1);
    for (const [value, stamp] of [
      ['v2', second],
      ['v3', third],
    ] as const) {
      const update = { ...task(id), hlc: stamp, fields: { title: { value, hlc: stamp, baseHlc: null } } };
      expect((await call('POST', '/v1/sync/push', token, pushBody([update]))).json?.['accepted']).toBe(1);
    }
    const latest = await findPulled(token, id, 'title');
    expect(latest.change.fields.title.value).toBe('v3');
    const history = await call('GET', '/v1/sync/conflicts', token);
    expect(
      history.json?.['items'].some((c: any) => c.record.rowId === id && c.record.losingValue === 'v1'),
    ).toBe(true);
  }, 30_000);

  it('CLD-R-014 removes expired lease rows without resetting fences', async () => {
    const principal = '47474747-4747-4474-8474-474747474747';
    await seed(principal, { role: 'owner' });
    const token = await mint(principal, { device_id: DEVICE_A });
    const key = 'review:lease-cleanup';
    const first = await call('POST', '/v1/leases/acquire', token, { key, ttlMs: 5_000 });
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const maintained = await hub('/internal/maintenance', {});
    const body = (await maintained.json()) as Record<string, any>;
    expect(body['expiredLeases']).toBeGreaterThanOrEqual(1);
    const next = await call('POST', '/v1/leases/acquire', token, { key, ttlMs: 5_000 });
    expect(next.json?.['lease'].fence).toBeGreaterThan(first.json?.['lease'].fence);
  }, 12_000);
});
