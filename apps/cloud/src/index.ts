import { Hono } from 'hono';
import { signBlobAccess, tenantWorkspaceKey, verifyBlobAccess } from './blobs';
import { verifyAccessToken } from './auth';
import { MAX_PUSH_BYTES, PullRequest, SYNC_PROTOCOL_VERSION, SYNC_SCHEMA_VERSION } from '@xyra/contracts';
import type { WorkspaceHub } from './hub';
import { parseLeaseInput } from './leases';
import { databaseUrl, recordDpopReplay, resolveCurrentAuthority } from './neon';
import { verifyDpopProof } from './dpop';
import { consumeQueueBatch } from './jobs';
import { runScheduledMaintenance } from './cron';
import { acceptMembershipRevokedWebhook, parseAndVerifyMembershipWebhook, WebhookError } from './webhooks';
import {
  AuthFlowError,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  exchangeAuthorizationCode,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  rotateRefreshToken,
  type WebAuthnConfig,
} from './auth-flow';

export { WorkspaceHub } from './hub';
import { MAX_BLOB_BYTES, MAX_BLOB_TTL_SEC, type CandidateClaims } from './model';

export interface Env {
  /** Runtime app credential only; migrations use a separately held owner credential. */
  readonly NEON_DATABASE_URL?: string;
  readonly WEBHOOK_SECRET?: string;
  readonly BLOBS: R2Bucket;
  readonly JOBS: Queue;
  readonly HUB: DurableObjectNamespace<WorkspaceHub>;
  readonly CACHE: KVNamespace;
  readonly AUTH_JWT_JWK?: string;
  readonly AUTH_JWT_AUDIENCE?: string;
  readonly AUTH_JWT_ISSUER?: string;
  readonly AUTH_SIGNING_JWK?: string;
  readonly AUTH_ORIGIN?: string;
  readonly AUTH_RP_ID?: string;
  readonly AUTH_RP_NAME?: string;
  readonly BLOB_ACCESS_SECRET?: string;
  /** Service-to-DO credential, never exposed by a public route. */
  readonly HUB_INTERNAL_TOKEN?: string;
  /** Miniflare-only fixture service; never configure this binding in Wrangler environments. */
  readonly CLOUD_TEST_AUTHORITY?: Fetcher;
  readonly BLOB_MAX_BYTES?: string;
  readonly QUOTA_PRINCIPAL_RPM?: string;
  readonly QUOTA_PRINCIPAL_BYTES?: string;
  readonly QUOTA_ENDPOINT_RPM?: string;
}

const app = new Hono<{ Bindings: Env }>();
const MAX_AUTH_BODY_BYTES = 512 * 1024;

function webAuthnConfig(env: Env): WebAuthnConfig | undefined {
  if (!env.AUTH_ORIGIN || !env.AUTH_RP_ID || !env.AUTH_RP_NAME) return undefined;
  return { origin: env.AUTH_ORIGIN, rpId: env.AUTH_RP_ID, rpName: env.AUTH_RP_NAME };
}

function authFailure(c: { json: (body: object, status: number) => Response }, error: unknown): Response {
  if (error instanceof AuthFlowError) return c.json({ code: error.code }, error.status);
  return c.json({ code: 'AUTH_UNAVAILABLE' }, 503);
}

function error(code: string, status: 400 | 401 | 403 | 503): Response {
  return Response.json({ code }, { status });
}

async function currentHub(
  c: { env: Env; req: { raw: Request } },
  bytes = 0,
): Promise<
  | { readonly response: Response }
  | {
      readonly claims: CandidateClaims;
      readonly hub: DurableObjectStub<WorkspaceHub>;
      readonly membership: {
        readonly role: 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'auditor';
        readonly permissions: readonly string[];
      };
    }
> {
  if (!c.env.HUB_INTERNAL_TOKEN) return { response: error('HUB_NOT_CONFIGURED', 503) };
  const authentication = await verifyAccessToken(c.req.raw, {
    ...(c.env.AUTH_JWT_JWK ? { verificationJwk: c.env.AUTH_JWT_JWK } : {}),
    ...(c.env.AUTH_JWT_AUDIENCE ? { audience: c.env.AUTH_JWT_AUDIENCE } : {}),
    ...(c.env.AUTH_JWT_ISSUER ? { issuer: c.env.AUTH_JWT_ISSUER } : {}),
  });
  if (!authentication.ok)
    return {
      response: error(authentication.code, authentication.code === 'AUTH_NOT_CONFIGURED' ? 503 : 401),
    };
  const hub = c.env.HUB.get(c.env.HUB.idFromName(authentication.claims.activeWorkspaceId));
  const accessToken = /^Bearer (.+)$/.exec(c.req.raw.headers.get('authorization') ?? '')?.[1];
  if (!accessToken) return { response: error('DPOP_REQUIRED', 401) };
  const proof = await verifyDpopProof(c.req.raw, accessToken, authentication.claims);
  if (!proof) return { response: error('DPOP_INVALID', 401) };
  let authority: { membership: Record<string, unknown>; delegator?: Record<string, unknown> } | null;
  const database = databaseUrl(c.env);
  if (database) {
    try {
      authority = (await resolveCurrentAuthority(database, authentication.claims)) as typeof authority;
    } catch {
      return { response: error('AUTHORITY_UNAVAILABLE', 503) };
    }
  } else if (c.env.CLOUD_TEST_AUTHORITY) {
    const result = await c.env.CLOUD_TEST_AUTHORITY.fetch('https://authority.test/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: authentication.claims }),
    });
    if (result.status === 404) authority = null;
    else if (!result.ok) return { response: error('AUTHORITY_UNAVAILABLE', 503) };
    else authority = (await result.json()) as typeof authority;
  } else {
    return { response: error('AUTHORITY_UNAVAILABLE', 503) };
  }
  if (!authority || !authority.membership || typeof authority.membership !== 'object') {
    await hub.fetch('https://workspace-hub/internal/membership/revoke', {
      method: 'POST',
      body: JSON.stringify({ principalId: authentication.claims.principalId }),
      headers: { 'content-type': 'application/json', 'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN },
    });
    return { response: error('CURRENT_MEMBERSHIP_REQUIRED', 403) };
  }
  let proofRecorded: boolean;
  if (database) {
    try {
      proofRecorded = await recordDpopReplay(database, authentication.claims, proof);
    } catch {
      return { response: error('AUTHORITY_UNAVAILABLE', 503) };
    }
  } else if (c.env.CLOUD_TEST_AUTHORITY) {
    const recorded = await c.env.CLOUD_TEST_AUTHORITY.fetch('https://authority.test/dpop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: authentication.claims.tenantId,
        deviceId: authentication.claims.deviceId,
        ...proof,
      }),
    });
    proofRecorded = recorded.ok;
    if (recorded.status >= 500) return { response: error('AUTHORITY_UNAVAILABLE', 503) };
  } else {
    return { response: error('AUTHORITY_UNAVAILABLE', 503) };
  }
  if (!proofRecorded) return { response: error('DPOP_REPLAYED', 401) };
  for (const membership of [authority.membership, authority.delegator].filter(
    (value): value is Record<string, unknown> => !!value,
  )) {
    const refreshed = await hub.fetch('https://workspace-hub/internal/membership/upsert', {
      method: 'POST',
      body: JSON.stringify({ membership }),
      headers: { 'content-type': 'application/json', 'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN },
    });
    if (!refreshed.ok) return { response: error('AUTHORITY_UNAVAILABLE', 503) };
  }
  const authorization = await hub.fetch('https://workspace-hub/internal/authorize', {
    method: 'POST',
    body: JSON.stringify({ claims: authentication.claims, bytes, endpoint: new URL(c.req.raw.url).pathname }),
    headers: { 'content-type': 'application/json', 'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN ?? '' },
  });
  if (authorization.status === 429) return { response: authorization };
  if (!authorization.ok) return { response: error('CURRENT_MEMBERSHIP_REQUIRED', 403) };
  const body = (await authorization.json()) as { membership?: unknown };
  if (!body.membership || typeof body.membership !== 'object')
    return { response: error('CURRENT_MEMBERSHIP_REQUIRED', 403) };
  const membership = body.membership as { role?: unknown; permissions?: unknown };
  if (
    !['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'].includes(membership.role as string) ||
    !Array.isArray(membership.permissions) ||
    !membership.permissions.every((permission) => typeof permission === 'string')
  ) {
    return { response: error('CURRENT_MEMBERSHIP_REQUIRED', 403) };
  }
  return {
    claims: authentication.claims,
    hub,
    membership: {
      role: membership.role as 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'auditor',
      permissions: membership.permissions,
    },
  };
}

async function forwardHub(
  hub: DurableObjectStub<WorkspaceHub>,
  path: string,
  payload: object,
  token: string | undefined,
): Promise<Response> {
  return hub.fetch(`https://workspace-hub${path}`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', 'x-hub-internal-token': token ?? '' },
  });
}

/** Counts actual streamed transport bytes, including properties later discarded by parsing. */
async function boundedJson(
  request: Request,
  cap: number,
  tooLargeCode = 'PUSH_TOO_LARGE',
): Promise<{ value: unknown; bytes: number } | Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap))
    return Response.json({ code: tooLargeCode }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ code: 'INVALID_JSON' }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        await reader.cancel();
        return Response.json({ code: tooLargeCode }, { status: 413 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown, bytes };
  } catch {
    return Response.json({ code: 'INVALID_JSON' }, { status: 400 });
  }
}

async function boundedAuthJson(request: Request): Promise<{ value: unknown } | Response> {
  const parsed = await boundedJson(request, MAX_AUTH_BODY_BYTES, 'AUTH_BODY_TOO_LARGE');
  return parsed instanceof Response ? parsed : { value: parsed.value };
}

app.get('/v1/health', (c) =>
  c.json({
    status: 'ok',
    neon: c.env.NEON_DATABASE_URL ? 'configured_unverified' : 'blocked_credentials',
    r2: 'binding_configured_unverified',
    auth: c.env.AUTH_JWT_JWK ? 'verification_configured' : 'blocked_credentials',
  }),
);

app.post('/v1/sync/push', async (c) => {
  const incoming = await boundedJson(c.req.raw, MAX_PUSH_BYTES);
  if (incoming instanceof Response) return incoming;
  const current = await currentHub(c, incoming.bytes);
  if ('response' in current) return current.response;
  return forwardHub(
    current.hub,
    '/internal/sync/push',
    { claims: current.claims, request: incoming.value },
    c.env.HUB_INTERNAL_TOKEN,
  );
});

app.get('/v1/sync/pull', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const cursor = c.req.query('cursor');
  if (
    c.req.query('protocolVersion') !== String(SYNC_PROTOCOL_VERSION) ||
    c.req.query('schemaVersion') !== SYNC_SCHEMA_VERSION
  )
    return c.json(
      { code: 'UPDATE_REQUIRED', protocolVersion: SYNC_PROTOCOL_VERSION, schemaVersion: SYNC_SCHEMA_VERSION },
      426,
    );
  const versions = PullRequest.safeParse({
    protocolVersion: c.req.query('protocolVersion'),
    schemaVersion: c.req.query('schemaVersion'),
    ...(cursor ? { cursor } : {}),
    ...(c.req.query('limit') ? { limit: c.req.query('limit') } : {}),
  });
  if (!versions.success) return c.json({ code: 'INVALID_CURSOR' }, 400);
  return forwardHub(
    current.hub,
    '/internal/sync/pull',
    {
      claims: current.claims,
      ...versions.data,
    },
    c.env.HUB_INTERNAL_TOKEN,
  );
});

for (const route of ['acquire', 'renew'] as const) {
  app.post(`/v1/leases/${route}`, async (c) => {
    const current = await currentHub(c);
    if ('response' in current) return current.response;
    let request: unknown;
    try {
      request = await c.req.json();
    } catch {
      return c.json({ code: 'INVALID_JSON' }, 400);
    }
    const body = parseLeaseInput(request, route === 'renew');
    if (!body) return c.json({ code: 'INVALID_LEASE_REQUEST' }, 400);
    return forwardHub(
      current.hub,
      `/internal/lease/${route}`,
      {
        claims: current.claims,
        lease: body,
      },
      c.env.HUB_INTERNAL_TOKEN,
    );
  });
}

app.get('/v1/sync/conflicts', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const after = Number(c.req.query('after') ?? '0');
  const limit = Number(c.req.query('limit') ?? '50');
  return forwardHub(
    current.hub,
    '/internal/sync/conflicts',
    { claims: current.claims, after, limit },
    c.env.HUB_INTERNAL_TOKEN,
  );
});

/** Kill-switch fan-out channel. Clients send the bearer JWT in the Authorization header. */
app.get('/v1/workspace/events', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.json({ code: 'UPGRADE_REQUIRED' }, 426);
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  return current.hub.fetch('https://workspace-hub/internal/events', {
    headers: {
      upgrade: 'websocket',
      'x-hub-claims': JSON.stringify(current.claims),
      'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN ?? '',
    },
  });
});

app.get('/v1/kill-switch', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  return forwardHub(
    current.hub,
    '/internal/kill-switch/get',
    { claims: current.claims },
    c.env.HUB_INTERNAL_TOKEN,
  );
});

app.post('/v1/blobs/ref', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  if (!c.env.BLOB_ACCESS_SECRET) return c.json({ code: 'BLOB_SIGNER_UNAVAILABLE' }, 503);
  let request: unknown;
  try {
    request = await c.req.json();
  } catch {
    return c.json({ code: 'INVALID_JSON' }, 400);
  }
  if (!request || typeof request !== 'object') return c.json({ code: 'INVALID_BLOB_REQUEST' }, 400);
  const body = request as Record<string, unknown>;
  const mode = body.mode === 'GET' || body.mode === 'PUT' ? body.mode : null;
  const name = typeof body.name === 'string' ? body.name : null;
  const expiresInSec = typeof body.expiresInSec === 'number' ? body.expiresInSec : 0;
  if (
    !mode ||
    !name ||
    !Number.isInteger(expiresInSec) ||
    expiresInSec < 30 ||
    expiresInSec > MAX_BLOB_TTL_SEC
  ) {
    return c.json({ code: 'BLOB_ACCESS_DENIED' }, 403);
  }
  const allowed = await forwardHub(
    current.hub,
    '/internal/blob/authorize',
    { claims: current.claims, mode },
    c.env.HUB_INTERNAL_TOKEN,
  );
  if (!allowed.ok) return c.json({ code: 'BLOB_ACCESS_DENIED' }, 403);
  const key = tenantWorkspaceKey(current.claims.tenantId, current.claims.activeWorkspaceId, name);
  if (!key) return c.json({ code: 'INVALID_BLOB_NAME' }, 400);
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  const token = await signBlobAccess(
    { key, principalId: current.claims.principalId, mode, expiresAtMs },
    c.env.BLOB_ACCESS_SECRET,
  );
  return c.json({ key, mode, expiresAtMs, url: `/v1/blobs/access/${token}` });
});

app.all('/v1/blobs/access/:token', async (c) => {
  if (!c.env.BLOB_ACCESS_SECRET) return c.json({ code: 'BLOB_SIGNER_UNAVAILABLE' }, 503);
  const access = await verifyBlobAccess(c.req.param('token'), c.env.BLOB_ACCESS_SECRET);
  if (!access || access.mode !== c.req.method) return c.json({ code: 'INVALID_BLOB_REFERENCE' }, 403);
  if (!c.env.HUB_INTERNAL_TOKEN) return c.json({ code: 'BLOB_RECHECK_UNAVAILABLE' }, 503);
  let declaredBytes = 0;
  if (access.mode === 'PUT') {
    const length = c.req.header('content-length');
    if (!length || !/^[0-9]+$/.test(length)) return c.json({ code: 'LENGTH_REQUIRED' }, 411);
    declaredBytes = Number(length);
    const cap = Math.min(MAX_BLOB_BYTES, Number(c.env.BLOB_MAX_BYTES) || MAX_BLOB_BYTES);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > cap)
      return c.json({ code: 'BLOB_TOO_LARGE' }, 413);
  }
  // Redemption rechecks current membership and the kill switch; a bearer ref alone is not enough.
  const workspaceId = access.key.split('/')[1] ?? '';
  const recheck = await c.env.HUB.get(c.env.HUB.idFromName(workspaceId)).fetch(
    'https://workspace-hub/internal/blob/check',
    {
      method: 'POST',
      body: JSON.stringify({
        principalId: access.principalId,
        key: access.key,
        mode: access.mode,
        bytes: declaredBytes,
      }),
      headers: { 'content-type': 'application/json', 'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN },
    },
  );
  if (!recheck.ok)
    return c.json(
      { code: recheck.status === 423 ? 'KILL_SWITCH_ENGAGED' : 'BLOB_ACCESS_DENIED' },
      recheck.status === 423 ? 423 : 403,
    );
  if (access.mode === 'PUT') {
    await c.env.BLOBS.put(access.key, c.req.raw.body ?? new Uint8Array(), {
      httpMetadata: { contentType: c.req.header('content-type') ?? 'application/octet-stream' },
    });
    return new Response(null, { status: 204 });
  }
  const object = await c.env.BLOBS.get(access.key);
  if (!object) return c.json({ code: 'BLOB_NOT_FOUND' }, 404);
  return new Response(object.body, {
    headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
  });
});

app.post('/v1/auth/passkey/begin', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  const rp = webAuthnConfig(c.env);
  if (!database || !rp) return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  try {
    return c.json(await beginPasskeyAuthentication(database, rp, parsed.value));
  } catch (failure) {
    return authFailure(c, failure);
  }
});

app.post('/v1/auth/passkey/complete', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  const rp = webAuthnConfig(c.env);
  if (!database || !rp) return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const input = parsed.value;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  const body = input as Record<string, unknown>;
  if (typeof body['transactionId'] !== 'string' || typeof body['state'] !== 'string')
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  try {
    const callback = await finishPasskeyAuthentication(
      database,
      rp,
      body['transactionId'],
      body['state'],
      body['credential'],
    );
    return Response.redirect(callback, 303);
  } catch (failure) {
    return authFailure(c, failure);
  }
});

app.post('/v1/auth/passkey/register/begin', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  const rp = webAuthnConfig(c.env);
  if (!database || !rp) return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  try {
    return c.json(await beginPasskeyRegistration(database, rp, current.claims));
  } catch (failure) {
    return authFailure(c, failure);
  }
});

app.post('/v1/auth/passkey/register/complete', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  const rp = webAuthnConfig(c.env);
  if (!database || !rp) return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const input = parsed.value;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  const body = input as Record<string, unknown>;
  if (typeof body['transactionId'] !== 'string' || typeof body['state'] !== 'string')
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  try {
    return c.json(
      await finishPasskeyRegistration(
        database,
        rp,
        current.claims,
        body['transactionId'],
        body['state'],
        body['credential'],
      ),
    );
  } catch (failure) {
    return authFailure(c, failure);
  }
});

app.post('/v1/auth/token', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  if (
    !database ||
    !c.env.AUTH_SIGNING_JWK ||
    !c.env.AUTH_JWT_JWK ||
    !c.env.AUTH_JWT_AUDIENCE ||
    !c.env.AUTH_JWT_ISSUER
  )
    return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const input = parsed.value;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  const body = input as Record<string, unknown>;
  if (
    typeof body['transactionId'] !== 'string' ||
    typeof body['code'] !== 'string' ||
    typeof body['verifier'] !== 'string'
  )
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  try {
    return c.json(
      await exchangeAuthorizationCode(
        database,
        c.req.raw,
        { transactionId: body['transactionId'], code: body['code'], verifier: body['verifier'] },
        {
          privateJwk: c.env.AUTH_SIGNING_JWK,
          publicJwk: c.env.AUTH_JWT_JWK,
          audience: c.env.AUTH_JWT_AUDIENCE,
          issuer: c.env.AUTH_JWT_ISSUER,
        },
      ),
    );
  } catch (failure) {
    return authFailure(c, failure);
  }
});

app.post('/v1/auth/refresh', async (c) => {
  const parsed = await boundedAuthJson(c.req.raw);
  if (parsed instanceof Response) return parsed;
  const database = databaseUrl(c.env);
  if (
    !database ||
    !c.env.AUTH_SIGNING_JWK ||
    !c.env.AUTH_JWT_JWK ||
    !c.env.AUTH_JWT_AUDIENCE ||
    !c.env.AUTH_JWT_ISSUER
  )
    return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const input = parsed.value;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof (input as Record<string, unknown>)['refreshToken'] !== 'string'
  )
    return c.json({ code: 'INVALID_AUTH_REQUEST' }, 400);
  try {
    return c.json(
      await rotateRefreshToken(
        database,
        c.req.raw,
        (input as Record<string, string>)['refreshToken'] as string,
        {
          privateJwk: c.env.AUTH_SIGNING_JWK,
          publicJwk: c.env.AUTH_JWT_JWK,
          audience: c.env.AUTH_JWT_AUDIENCE,
          issuer: c.env.AUTH_JWT_ISSUER,
        },
      ),
    );
  } catch (failure) {
    return authFailure(c, failure);
  }
});
app.post('/v1/webhooks/membership', async (c) => {
  const database = databaseUrl(c.env);
  if (!database) return c.json({ code: 'WEBHOOK_UNAVAILABLE' }, 503);
  try {
    const verified = await parseAndVerifyMembershipWebhook(c.req.raw, c.env.WEBHOOK_SECRET ?? '');
    const jobId = await acceptMembershipRevokedWebhook(database, verified.event, verified.bodyHash);
    // Sending after the durable outbox commit is safe: a provider retry resends the same job id.
    await c.env.JOBS.send({
      jobId,
      tenantId: verified.event.tenantId,
      workspaceId: verified.event.workspaceId,
    });
    return c.json({ accepted: true }, 202);
  } catch (failure) {
    if (failure instanceof WebhookError) return c.json({ code: failure.code }, failure.status);
    return c.json({ code: 'WEBHOOK_UNAVAILABLE' }, 503);
  }
});
app.all('/v1/*', (c) => c.json({ code: 'CLOUD_CAPABILITY_NOT_READY' }, 503));

export default {
  fetch: app.fetch,
  async queue(batch, env): Promise<void> {
    await consumeQueueBatch(batch, env, (workspaceId) => {
      return env.HUB.get(env.HUB.idFromName(workspaceId));
    });
  },
  async scheduled(event, env): Promise<void> {
    const database = databaseUrl(env);
    if (!database) throw new Error('CRON_DATABASE_UNAVAILABLE');
    await runScheduledMaintenance(database, event.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
