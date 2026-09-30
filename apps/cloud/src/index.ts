import { Hono } from 'hono';
import { signBlobAccess, tenantWorkspaceKey, verifyBlobAccess } from './blobs';
import { verifyAccessToken } from './auth';
import { MAX_PUSH_BYTES, PullRequest, SYNC_PROTOCOL_VERSION, SYNC_SCHEMA_VERSION } from '@xyra/contracts';
import type { WorkspaceHub } from './hub';
import { parseLeaseInput } from './leases';

export { WorkspaceHub } from './hub';
import { MAX_BLOB_BYTES, MAX_BLOB_TTL_SEC, type CandidateClaims } from './model';

export interface Env {
  /** Runtime app credential only; migrations use a separately held owner credential. */
  readonly NEON_DATABASE_URL?: string;
  readonly BLOBS: R2Bucket;
  readonly JOBS: Queue;
  readonly HUB: DurableObjectNamespace<WorkspaceHub>;
  readonly CACHE: KVNamespace;
  readonly AUTH_JWT_JWK?: string;
  readonly AUTH_JWT_AUDIENCE?: string;
  readonly AUTH_JWT_ISSUER?: string;
  readonly BLOB_ACCESS_SECRET?: string;
  /** Service-to-DO credential, never exposed by a public route. */
  readonly HUB_INTERNAL_TOKEN?: string;
  readonly BLOB_MAX_BYTES?: string;
  readonly QUOTA_PRINCIPAL_RPM?: string;
  readonly QUOTA_PRINCIPAL_BYTES?: string;
  readonly QUOTA_ENDPOINT_RPM?: string;
}

const app = new Hono<{ Bindings: Env }>();

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
): Promise<{ value: unknown; bytes: number } | Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap))
    return Response.json({ code: 'PUSH_TOO_LARGE' }, { status: 413 });
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
        return Response.json({ code: 'PUSH_TOO_LARGE' }, { status: 413 });
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

/** Passkey enrolment and refresh-family persistence require the Neon auth schema and scoped grants. */
app.post('/v1/auth/refresh', (c) => c.json({ code: 'AUTH_REFRESH_STORE_UNAVAILABLE' }, 503));
app.all('/v1/*', (c) => c.json({ code: 'CLOUD_CAPABILITY_NOT_READY' }, 503));

export default {
  fetch: app.fetch,
  async queue(batch): Promise<void> {
    // No job is acknowledged until an idempotent consumer exists; Queue retries are intentional.
    console.warn('CLOUD_QUEUE_HANDLER_NOT_READY', { messages: batch.messages.length });
    batch.retryAll();
  },
  async scheduled(): Promise<void> {
    // Deliberately no work: Cron wiring is present but has no invented maintenance behavior.
    console.warn('CLOUD_CRON_HANDLER_NOT_READY');
  },
} satisfies ExportedHandler<Env>;
