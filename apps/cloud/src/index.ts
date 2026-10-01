import { Hono } from 'hono';
import { signBlobAccess, tenantWorkspaceKey, verifyBlobAccess } from './blobs';
import { verifyAccessToken } from './auth';
import { MAX_PUSH_BYTES, PullRequest, SYNC_PROTOCOL_VERSION, SYNC_SCHEMA_VERSION } from '@xyra/contracts';
import type { WorkspaceHub } from './hub';
import { parseLeaseInput } from './leases';
import {
  databaseUrl,
  readCurrentAuthority,
  recordDpopReplay,
  resolveCurrentAuthority,
  withNeonTransaction,
  type CurrentAuthority,
  type NeonQueryClient,
} from './neon';
import { lockWorkspaceSequence, NeonSyncStore } from './neon-sync-store';
import { IdempotencyKeyReusedError, SyncAuthorityEngine, hashRequest, parseSyncPush } from './sync';
import { decideAccess, type AccessContext } from './access';
import { TABLE_RULES } from './tables';
import { verifyDpopProof } from './dpop';
import { consumeQueueBatch } from './jobs';
import { runScheduledMaintenance } from './cron';
import { drainSyncOutbox } from './sync-outbox';
import { blobReferenceSnapshotDigest, BlobReferenceSetRequest, hasErasureFence, sourceVersionFromSyncedRows } from './erasures';
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
  readonly BLOBS?: R2Bucket;
  readonly JOBS: Queue;
  /** Required durable terminal handoff for poison and exhausted jobs. */
  readonly DEAD_LETTER_JOBS: Queue;
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
  /** Miniflare-only sync adapter; production sync always commits to Neon. */
  readonly CLOUD_TEST_SYNC?: Fetcher;
  /** Miniflare-only durable erasure-fence fixture; never configured in Wrangler. */
  readonly CLOUD_TEST_ERASURE?: Fetcher;
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
      readonly authority: CurrentAuthority;
      readonly killSwitchEngaged: boolean;
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
  let authority: CurrentAuthority | null;
  const database = databaseUrl(c.env);
  if (database) {
    try {
      authority = await resolveCurrentAuthority(database, authentication.claims);
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
  for (const membership of [authority.membership, authority.delegator]) {
    if (!membership) continue;
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
  const body = (await authorization.json()) as { membership?: unknown; killSwitchEngaged?: unknown };
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
    authority,
    killSwitchEngaged: body['killSwitchEngaged'] === true,
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

type AuthorizedSyncRequest = {
  readonly claims: CandidateClaims;
  readonly authority: CurrentAuthority;
  readonly killSwitchEngaged: boolean;
};

function accessContext(current: AuthorizedSyncRequest): AccessContext {
  return {
    claims: current.claims,
    membership: current.authority.membership,
    ...(current.authority.delegator ? { delegator: current.authority.delegator } : {}),
    killSwitchEngaged: current.killSwitchEngaged,
  };
}

async function recheckedAccess(
  client: NeonQueryClient,
  current: AuthorizedSyncRequest,
): Promise<AccessContext | null> {
  const authority = await readCurrentAuthority(client, current.claims);
  if (!authority) return null;
  return {
    claims: current.claims,
    membership: authority.membership,
    ...(authority.delegator ? { delegator: authority.delegator } : {}),
    killSwitchEngaged: current.killSwitchEngaged,
  };
}

async function publishSyncCache(
  env: Env,
  current: AuthorizedSyncRequest & { readonly hub: DurableObjectStub<WorkspaceHub> },
  serverSeq: string,
): Promise<void> {
  const connectionString = databaseUrl(env);
  if (!connectionString || !/^\d{1,19}$/.test(serverSeq)) return;
  try {
    const advanced = await current.hub.fetch('https://workspace-hub/internal/sync/cache/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-internal-token': env.HUB_INTERNAL_TOKEN ?? '' },
      body: JSON.stringify({ serverSeq }),
    });
    if (!advanced.ok) return;
    await withNeonTransaction(
      connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      (client) =>
        client
          .query(
            `UPDATE cloud_sync_outbox SET delivered_at=COALESCE(delivered_at,now()),attempts=attempts+1
          WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq <= $3 AND delivered_at IS NULL`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, serverSeq],
          )
          .then(() => undefined),
    );
  } catch {
    // Neon committed already. Pending outbox rows are retried by the scheduled dispatcher.
  }
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
    r2: c.env.BLOBS ? 'binding_configured_unverified' : 'unconfigured',
    auth: c.env.AUTH_JWT_JWK ? 'verification_configured' : 'blocked_credentials',
  }),
);

app.post('/v1/sync/push', async (c) => {
  const incoming = await boundedJson(c.req.raw, MAX_PUSH_BYTES);
  if (incoming instanceof Response) return incoming;
  const current = await currentHub(c, incoming.bytes);
  if ('response' in current) return current.response;
  if (
    !incoming.value ||
    typeof incoming.value !== 'object' ||
    (incoming.value as Record<string, unknown>)['protocolVersion'] !== SYNC_PROTOCOL_VERSION ||
    (incoming.value as Record<string, unknown>)['schemaVersion'] !== SYNC_SCHEMA_VERSION
  )
    return c.json(
      { code: 'UPDATE_REQUIRED', protocolVersion: SYNC_PROTOCOL_VERSION, schemaVersion: SYNC_SCHEMA_VERSION },
      426,
    );
  const request = parseSyncPush(incoming.value);
  if (!request) return c.json({ code: 'INVALID_SYNC_REQUEST' }, 400);
  if (current.claims.kind === 'agent' && current.killSwitchEngaged)
    return c.json({ code: 'KILL_SWITCH_ENGAGED' }, 423);
  const access = accessContext(current);
  try {
    if (c.env.CLOUD_TEST_SYNC) {
      if (c.env.CLOUD_TEST_ERASURE) {
        const fence = await c.env.CLOUD_TEST_ERASURE.fetch('https://erasure.test/fence/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenantId: current.claims.tenantId,
            workspaceId: current.claims.activeWorkspaceId,
            changes: request.changes.map(({ table, id }) => ({ table, id })),
          }),
        });
        if (!fence.ok) return c.json({ code: 'ERASURE_FENCE_UNAVAILABLE' }, 503);
        const result = (await fence.json()) as { fenced?: unknown };
        if (result.fenced === true) return c.json({ code: 'ERASURE_SOURCE_FENCED' }, 409);
      }
      return c.env.CLOUD_TEST_SYNC.fetch('https://sync.test/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access, request, nowMs: Date.now(), requestHash: await hashRequest(request) }),
      });
    }
    const connectionString = databaseUrl(c.env);
    if (!connectionString) return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
    const outcome = await withNeonTransaction(
      connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted) return null;
        await lockWorkspaceSequence(client, current.claims.tenantId, current.claims.activeWorkspaceId);
        if (await hasErasureFence(client, current.claims.tenantId, current.claims.activeWorkspaceId, request.changes))
          return { kind: 'fenced' as const };
        const brainChanges = request.changes.filter((change) =>
          change.table === 'brain_sources' || change.table === 'brain_source_versions');
        const touchedSources = new Set<string>();
        for (const change of brainChanges) {
          if (change.table === 'brain_sources') touchedSources.add(change.id);
          else {
            const sourceId = change.op === 'delete' ? undefined : change.fields['source_id']?.value;
            if (typeof sourceId === 'string') touchedSources.add(sourceId);
            else {
              const existing = await client.query<{ source_id: string | undefined }>(
                `SELECT fields->'source_id'->>'value' AS source_id FROM cloud_sync_rows
                  WHERE tenant_id=$1 AND workspace_id=$2 AND table_name='brain_source_versions' AND row_id=$3`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, change.id],
              );
              if (existing.rows[0]?.source_id) touchedSources.add(existing.rows[0].source_id);
            }
          }
        }
        const sourceIds = [...touchedSources];
        if (sourceIds.length) {
          const claimed = await client.query(
            `SELECT 1 FROM cloud_erasure_operations WHERE tenant_id=$1 AND workspace_id=$2
              AND source_kind='brain_source' AND source_id=ANY($3::uuid[])
              AND status IN ('purge_claimed','local_purge_acknowledged','delete_pending') LIMIT 1`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, sourceIds],
          );
          if (claimed.rows.length) return { kind: 'claim-active' as const };
        }
        const engine = new SyncAuthorityEngine(
          new NeonSyncStore(client, current.claims.tenantId, current.claims.activeWorkspaceId),
        );
        const response = await engine.push(trusted, request, Date.now(), await hashRequest(request));
        if (sourceIds.length && response.accepted > 0 && !response.replayed) {
          await client.query(`UPDATE cloud_erasure_reference_sets SET current=false,invalidated_at=now()
            WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source'
              AND source_id=ANY($3::uuid[]) AND current=true`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, sourceIds]);
          const invalidated = await client.query<{ id: string }>(
            `UPDATE cloud_erasure_operations SET status='eligibility_invalidated',reservation_id=NULL,
                reservation_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source'
                AND source_id=ANY($3::uuid[]) AND status='eligible' RETURNING id`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, sourceIds],
          );
          for (const operation of invalidated.rows) {
            await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
              VALUES ($1,$2,$3,$4,'eligibility_invalidated','{"reason":"source_state_changed"}'::jsonb)`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, operation.id, crypto.randomUUID()]);
          }
        }
        return { kind: 'accepted' as const, response };
      },
    );
    if (!outcome) return c.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (outcome.kind === 'fenced') return c.json({ code: 'ERASURE_SOURCE_FENCED' }, 409);
    if (outcome.kind === 'claim-active') return c.json({ code: 'ERASURE_CLAIM_ACTIVE' }, 423);
    await publishSyncCache(c.env, current, outcome.response.serverSeq);
    return c.json(outcome.response);
  } catch (cause) {
    if (cause instanceof IdempotencyKeyReusedError) return c.json({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
  }
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
  const access = accessContext(current);
  if (c.env.CLOUD_TEST_SYNC)
    return c.env.CLOUD_TEST_SYNC.fetch('https://sync.test/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access, cursor: versions.data.cursor, limit: versions.data.limit }),
    });
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
  try {
    const result = await withNeonTransaction(
      connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted) return null;
        return new SyncAuthorityEngine(
          new NeonSyncStore(client, current.claims.tenantId, current.claims.activeWorkspaceId),
        ).pull(trusted, versions.data.cursor, versions.data.limit);
      },
    );
    if (!result) return c.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (!result.ok) return c.json({ code: result.code }, result.code === 'INVALID_CURSOR' ? 400 : 409);
    await publishSyncCache(c.env, current, result.response.serverSeq);
    return c.json(result.response);
  } catch {
    return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
  }
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
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
    return c.json({ code: 'INVALID_PAGE' }, 400);
  const access = accessContext(current);
  if (c.env.CLOUD_TEST_SYNC)
    return c.env.CLOUD_TEST_SYNC.fetch('https://sync.test/conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access, after, limit }),
    });
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
  try {
    const page = await withNeonTransaction(
      connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted) return null;
        return new SyncAuthorityEngine(
          new NeonSyncStore(client, current.claims.tenantId, current.claims.activeWorkspaceId),
        ).conflictPage(trusted, after, limit);
      },
    );
    if (page === null) return c.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if (!page) return c.json({ code: 'INVALID_PAGE' }, 400);
    return c.json(page);
  } catch {
    return c.json({ code: 'SYNC_STORAGE_UNAVAILABLE' }, 503);
  }
});

app.post('/v1/blob-reference-sets', async (c) => {
  const incoming = await boundedJson(c.req.raw, 256 * 1024, 'BLOB_REFERENCE_SET_TOO_LARGE');
  if (incoming instanceof Response) return incoming;
  const parsed = BlobReferenceSetRequest.safeParse(incoming.value);
  if (!parsed.success && incoming.value && typeof incoming.value === 'object' &&
      Array.isArray((incoming.value as Record<string, unknown>)['objectRefIds']) &&
      ((incoming.value as Record<string, unknown>)['objectRefIds'] as unknown[]).length === 0)
    return c.json({ code: 'SOURCE_REFERENCES_UNAVAILABLE' }, 409);
  if (!parsed.success) return c.json({ code: 'INVALID_BLOB_REFERENCE_SET' }, 400);
  const current = await currentHub(c, incoming.bytes);
  if ('response' in current) return current.response;
  if (current.claims.kind !== 'user') return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const rule = TABLE_RULES.get('brain_sources');
  if (!rule || !decideAccess(accessContext(current), rule.manifest, 'brain:source:write', 'write').ok)
    return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'BLOB_REFERENCE_REGISTRY_UNAVAILABLE' }, 503);
  const { sourceId, sourceVersion, objectRefIds } = parsed.data;
  try {
    const result = await withNeonTransaction(connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted || !decideAccess(trusted, rule.manifest, 'brain:source:write', 'write').ok) return { error: 'CURRENT_MEMBERSHIP_REQUIRED' as const };
        await lockWorkspaceSequence(client, current.claims.tenantId, current.claims.activeWorkspaceId);
        const activeClaim = await client.query(
          `SELECT 1 FROM cloud_erasure_operations WHERE tenant_id=$1 AND workspace_id=$2
            AND source_kind='brain_source' AND source_id=$3
            AND status IN ('purge_claimed','local_purge_acknowledged','delete_pending') LIMIT 1`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId],
        );
        if (activeClaim.rows.length) return { error: 'ERASURE_CLAIM_ACTIVE' as const };
        const source = await client.query<{ fields: unknown; deleted_hlc: string | null }>(
          `SELECT fields,deleted_hlc FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
            AND table_name='brain_sources' AND row_id=$3 FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId],
        );
        const versions = await client.query<{ row_id: string; fields: unknown; deleted_hlc: string | null }>(
          `SELECT row_id,fields,deleted_hlc FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
            AND table_name='brain_source_versions' AND fields->'source_id'->>'value'=$3
            ORDER BY row_id FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId],
        );
        let actual: string;
        try {
          actual = await sourceVersionFromSyncedRows(sourceId,
            source.rows[0] ? { fields: typeof source.rows[0].fields === 'string' ? JSON.parse(source.rows[0].fields) : source.rows[0].fields as any, deleted: !!source.rows[0].deleted_hlc } : undefined,
            versions.rows.map((row) => ({ id: row.row_id, fields: typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields as any, deleted: !!row.deleted_hlc })),
          );
        } catch { return { error: 'SOURCE_STATE_UNAVAILABLE' as const }; }
        if (actual !== sourceVersion) return { error: 'SOURCE_VERSION_STALE' as const };
        const sourceFields = source.rows[0]?.fields;
        const parsedSourceFields = typeof sourceFields === 'string' ? JSON.parse(sourceFields) as Record<string, unknown> : sourceFields as Record<string, unknown> | undefined;
        const syncedRefs = (parsedSourceFields?.['cloud_object_ref_ids'] as { value?: unknown } | undefined)?.value;
        if (!Array.isArray(syncedRefs) || syncedRefs.length === 0 ||
            !syncedRefs.every((value) => typeof value === 'string') ||
            [...syncedRefs as string[]].sort().join(',') !== [...objectRefIds].sort().join(','))
          return { error: 'SOURCE_REFERENCES_UNAVAILABLE' as const };
        const objects = await client.query<{ id: string; storage_state: string }>(
          `SELECT id,storage_state FROM cloud_erasure_objects WHERE tenant_id=$1 AND workspace_id=$2
            AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, objectRefIds],
        );
        if (objects.rows.length !== objectRefIds.length || objects.rows.some((o) => o.storage_state !== 'available'))
          return { error: 'OBJECT_REFERENCE_UNAVAILABLE' as const };
        const digest = await blobReferenceSnapshotDigest(sourceId, sourceVersion, objectRefIds);
        const replay = await client.query<{ snapshot_id: string; reference_state_version: string }>(
          `SELECT snapshot_id,reference_state_version FROM cloud_erasure_reference_sets
            WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3
              AND source_version=$4 AND snapshot_digest=$5 AND current=true`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId, sourceVersion, digest],
        );
        if (replay.rows[0]) return { snapshotId: replay.rows[0].snapshot_id, digest, version: Number(replay.rows[0].reference_state_version), replay: true };
        const nextVersion = await client.query<{ version: string | number }>(
          `SELECT COALESCE(MAX(reference_state_version),0)+1 AS version FROM cloud_erasure_reference_sets
            WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId],
        );
        await client.query(`UPDATE cloud_erasure_reference_sets SET current=false,invalidated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3 AND current=true`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId]);
        await client.query(`UPDATE cloud_erasure_refs SET active=false,retired_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3 AND active=true`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, sourceId]);
        for (const objectId of objectRefIds) {
          await client.query(`INSERT INTO cloud_erasure_refs(tenant_id,workspace_id,object_id,source_kind,source_id)
            VALUES ($1,$2,$3,'brain_source',$4) ON CONFLICT (tenant_id,workspace_id,object_id,source_kind,source_id)
            DO UPDATE SET active=true,retired_at=NULL`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, objectId, sourceId]);
          await client.query(`UPDATE cloud_erasure_objects SET reference_state_version=reference_state_version+1
            WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, objectId]);
        }
        const snapshotId = crypto.randomUUID();
        const version = Number(nextVersion.rows[0]?.version ?? 1);
        await client.query(`INSERT INTO cloud_erasure_reference_sets
          (tenant_id,workspace_id,snapshot_id,source_kind,source_id,source_version,snapshot_digest,reference_state_version,object_ids)
          VALUES ($1,$2,$3,'brain_source',$4,$5,$6,$7,$8::uuid[])`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, snapshotId, sourceId, sourceVersion, digest, version, objectRefIds]);
        return { snapshotId, digest, version, replay: false };
      });
    if ('error' in result) return c.json({ code: result.error }, result.error === 'ERASURE_CLAIM_ACTIVE' ? 423 : result.error === 'CURRENT_MEMBERSHIP_REQUIRED' ? 403 : 409);
    return c.json({ protocolVersion: 'cloud-erasure-v1', snapshotId: result.snapshotId, sourceId, sourceVersion,
      referenceStateVersion: result.version, snapshotDigest: result.digest, status: 'registered', replay: result.replay });
  } catch {
    return c.json({ code: 'BLOB_REFERENCE_REGISTRY_UNAVAILABLE' }, 503);
  }
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
  if (!c.env.BLOBS) return c.json({ code: 'BLOB_STORAGE_UNAVAILABLE' }, 503);
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
  let objectRefId: string | null = null;
  const registryDatabase = databaseUrl(c.env);
  if (mode === 'PUT' && registryDatabase) {
    try {
      const registration = await withNeonTransaction(registryDatabase,
        { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
        async (client) => {
          await lockWorkspaceSequence(client, current.claims.tenantId, current.claims.activeWorkspaceId);
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM cloud_erasure_objects WHERE tenant_id=$1 AND workspace_id=$2 AND storage_key=$3 FOR UPDATE`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, key],
          );
          if (existing.rows[0]) {
            const objectId = existing.rows[0].id;
            const claimed = await client.query(
              `SELECT 1 FROM cloud_erasure_refs r JOIN cloud_erasure_operations o
                ON (o.tenant_id,o.workspace_id,o.source_kind,o.source_id)=(r.tenant_id,r.workspace_id,r.source_kind,r.source_id)
                WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.object_id=$3 AND r.active=true
                  AND o.status IN ('purge_claimed','local_purge_acknowledged','delete_pending') LIMIT 1`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, objectId],
            );
            if (claimed.rows.length) return { error: 'ERASURE_CLAIM_ACTIVE' as const };
            await client.query(`UPDATE cloud_erasure_objects SET storage_state='unknown',size_bytes=NULL,
                reference_state_version=reference_state_version+1 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, objectId]);
            const stale = await client.query<{ snapshot_id: string; source_id: string }>(
              `UPDATE cloud_erasure_reference_sets SET current=false,invalidated_at=now()
                WHERE tenant_id=$1 AND workspace_id=$2 AND current=true AND object_ids @> ARRAY[$3::uuid]
                RETURNING snapshot_id,source_id`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, objectId],
            );
            for (const snapshot of stale.rows) {
              const operations = await client.query<{ id: string }>(
                `UPDATE cloud_erasure_operations SET status='eligibility_invalidated',reservation_id=NULL,
                    reservation_expires_at=NULL,updated_at=now()
                  WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 AND status='eligible' RETURNING id`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, snapshot.source_id],
              );
              for (const operation of operations.rows) await client.query(
                `INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
                  VALUES ($1,$2,$3,$4,'eligibility_invalidated','{"reason":"object_reissued"}'::jsonb)`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, operation.id, crypto.randomUUID()],
              );
            }
            return { id: objectId };
          }
          const result = await client.query<{ id: string }>(
            `INSERT INTO cloud_erasure_objects(tenant_id,workspace_id,id,storage_key,storage_state)
             VALUES ($1,$2,$3,$4,'unknown') RETURNING id`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, crypto.randomUUID(), key],
          );
          return { id: result.rows[0]?.id ?? null };
        });
      if ('error' in registration) return c.json({ code: registration.error }, 423);
      objectRefId = registration.id;
    } catch {
      return c.json({ code: 'BLOB_REFERENCE_REGISTRY_UNAVAILABLE' }, 503);
    }
  }
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  const token = await signBlobAccess(
    { key, principalId: current.claims.principalId, mode, expiresAtMs },
    c.env.BLOB_ACCESS_SECRET,
  );
  return c.json({ key, mode, expiresAtMs, url: `/v1/blobs/access/${token}`,
    ...(mode === 'PUT' ? { objectRefId, referenceStatus: objectRefId ? 'registration_required' : 'references_unknown' } : {}) });
});

app.all('/v1/blobs/access/:token', async (c) => {
  if (!c.env.BLOB_ACCESS_SECRET) return c.json({ code: 'BLOB_SIGNER_UNAVAILABLE' }, 503);
  const access = await verifyBlobAccess(c.req.param('token'), c.env.BLOB_ACCESS_SECRET);
  if (!access || access.mode !== c.req.method) return c.json({ code: 'INVALID_BLOB_REFERENCE' }, 403);
  if (!c.env.BLOBS) return c.json({ code: 'BLOB_STORAGE_UNAVAILABLE' }, 503);
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
    const connectionString = databaseUrl(c.env);
    if (connectionString) {
      try {
        const [tenantId, workspaceId] = access.key.split('/');
        if (!tenantId || !workspaceId) throw new Error('INVALID_SIGNED_BLOB_SCOPE');
        await withNeonTransaction(connectionString,
          { tenantId, workspaceId },
          async (client) => {
            await lockWorkspaceSequence(client, tenantId, workspaceId);
            const updated = await client.query(`UPDATE cloud_erasure_objects SET storage_state='available',size_bytes=$4
              WHERE tenant_id=$1 AND workspace_id=$2 AND storage_key=$3 RETURNING id`,
              [tenantId, workspaceId, access.key, declaredBytes]);
            if (updated.rows.length !== 1) throw new Error('BLOB_REGISTRY_ROW_MISSING');
          },
        );
      } catch {
        // R2 has accepted the body but durable registry state did not commit. Force the uploader
        // to retry; the object remains unknown and cannot enter a reference snapshot meanwhile.
        return c.json({ code: 'BLOB_REGISTRY_UPDATE_FAILED' }, 503);
      }
    }
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
    if (!env.HUB_INTERNAL_TOKEN) throw new Error('SYNC_OUTBOX_HUB_AUTH_UNAVAILABLE');
    await drainSyncOutbox(database, async (workspaceId, serverSeq) => {
      const hub = env.HUB.get(env.HUB.idFromName(workspaceId));
      const result = await hub.fetch('https://workspace-hub/internal/sync/cache/advance', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-internal-token': env.HUB_INTERNAL_TOKEN ?? '' },
        body: JSON.stringify({ serverSeq }),
      });
      return result.ok;
    });
  },
} satisfies ExportedHandler<Env>;
