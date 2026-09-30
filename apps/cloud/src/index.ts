import { Hono } from 'hono';
import { signBlobAccess, tenantWorkspaceKey, verifyBlobAccess } from './blobs';
import { verifyAccessToken } from './auth';
import type { WorkspaceHub } from './hub';

export { WorkspaceHub } from './hub';
import { MAX_BLOB_BYTES, MAX_BLOB_TTL_SEC, type CandidateClaims } from './model';
import { hasPermission } from './tables';

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
}

const app = new Hono<{ Bindings: Env }>();

function error(code: string, status: 400 | 401 | 403 | 503): Response {
  return Response.json({ code }, { status });
}

async function currentHub(c: { env: Env; req: { raw: Request } }): Promise<
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
    body: JSON.stringify({ claims: authentication.claims }),
    headers: { 'content-type': 'application/json' },
  });
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
): Promise<Response> {
  return hub.fetch(`https://workspace-hub${path}`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
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
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > 1_000_000)
    return c.json({ code: 'PUSH_TOO_LARGE' }, 413);
  let request: unknown;
  try {
    request = await c.req.json();
  } catch {
    return c.json({ code: 'INVALID_JSON' }, 400);
  }
  return forwardHub(current.hub, '/internal/sync/push', { claims: current.claims, request });
});

app.get('/v1/sync/pull', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const cursor = c.req.query('cursor');
  return forwardHub(current.hub, '/internal/sync/pull', {
    claims: current.claims,
    ...(cursor ? { cursor } : {}),
  });
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
    const body = request && typeof request === 'object' ? request : {};
    return forwardHub(current.hub, `/internal/lease/${route}`, {
      claims: current.claims,
      ...(body as object),
    });
  });
}

app.get('/v1/sync/conflicts', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const after = Number(c.req.query('after') ?? '0');
  const limit = Number(c.req.query('limit') ?? '50');
  return forwardHub(current.hub, '/internal/sync/conflicts', { claims: current.claims, after, limit });
});

/** Kill-switch fan-out channel. Clients send the bearer JWT in the Authorization header. */
app.get('/v1/workspace/events', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.json({ code: 'UPGRADE_REQUIRED' }, 426);
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  return current.hub.fetch('https://workspace-hub/internal/events', {
    headers: { upgrade: 'websocket', 'x-hub-claims': JSON.stringify(current.claims) },
  });
});

app.get('/v1/kill-switch', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  return forwardHub(current.hub, '/internal/kill-switch/get', { claims: current.claims });
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
  const permission = mode === 'GET' ? 'core:workspace:read' : 'core:workspace:write';
  const membership = {
    ...current.membership,
    principalId: current.claims.principalId,
    tenantId: current.claims.tenantId,
    workspaceId: current.claims.activeWorkspaceId,
  };
  if (
    !mode ||
    !name ||
    !Number.isInteger(expiresInSec) ||
    expiresInSec < 30 ||
    expiresInSec > MAX_BLOB_TTL_SEC ||
    !hasPermission(membership, permission)
  ) {
    return c.json({ code: 'BLOB_ACCESS_DENIED' }, 403);
  }
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
  // Redemption rechecks current membership and the kill switch; a bearer ref alone is not enough.
  const workspaceId = access.key.split('/')[1] ?? '';
  const recheck = await c.env.HUB.get(c.env.HUB.idFromName(workspaceId)).fetch(
    'https://workspace-hub/internal/blob/check',
    {
      method: 'POST',
      body: JSON.stringify({ principalId: access.principalId, key: access.key, mode: access.mode }),
      headers: { 'content-type': 'application/json', 'x-hub-internal-token': c.env.HUB_INTERNAL_TOKEN },
    },
  );
  if (!recheck.ok)
    return c.json(
      { code: recheck.status === 423 ? 'KILL_SWITCH_ENGAGED' : 'BLOB_ACCESS_DENIED' },
      recheck.status === 423 ? 423 : 403,
    );
  if (access.mode === 'PUT') {
    const length = c.req.header('content-length');
    if (!length || !/^[0-9]+$/.test(length)) return c.json({ code: 'LENGTH_REQUIRED' }, 411);
    // BLOB_MAX_BYTES may only lower the cap (used to exercise the limit cheaply).
    const cap = Math.min(MAX_BLOB_BYTES, Number(c.env.BLOB_MAX_BYTES) || MAX_BLOB_BYTES);
    if (Number(length) > cap) return c.json({ code: 'BLOB_TOO_LARGE' }, 413);
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
