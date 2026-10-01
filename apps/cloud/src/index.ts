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
import {
  blobReferenceSnapshotDigest,
  CloudIngestionBeginResult,
  CloudIngestionFinalizeRequest,
  CloudIngestionFinalizationReceipt,
  CloudIngestionStatus,
  CloudIngestionStartRequest,
  hasErasureFence,
  erasureSourceSnapshotVersion,
  sourceVersionDigest,
  sourceVersionSnapshotFromSyncedRows,
} from './erasures';
import { acceptMembershipRevokedWebhook, parseAndVerifyMembershipWebhook, WebhookError } from './webhooks';
import {
  AuthFlowError,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  exchangeAuthorizationCode,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  revokeCurrentRefreshFamily,
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
          await client.query(`UPDATE cloud_source_ingestions SET status='invalidated',updated_at=now(),invalidated_at=now()
            WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=ANY($3::uuid[]) AND status='finalized'`,
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

app.post('/v2/brain/ingestions', async (c) => {
  const incoming = await boundedJson(c.req.raw, 32 * 1024, 'INGESTION_BODY_TOO_LARGE');
  if (incoming instanceof Response) return incoming;
  const parsed = CloudIngestionStartRequest.safeParse(incoming.value);
  if (!parsed.success) return c.json({ code: 'INVALID_INGESTION_REQUEST' }, 400);
  const current = await currentHub(c, incoming.bytes);
  if ('response' in current) return current.response;
  if (current.claims.kind !== 'user') return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const rule = TABLE_RULES.get('brain_sources');
  if (!rule || !decideAccess(accessContext(current), rule.manifest, 'brain:source:write', 'write').ok)
    return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  try {
    const result = await withNeonTransaction(connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted || !decideAccess(trusted, rule.manifest, 'brain:source:write', 'write').ok) return null;
        await lockWorkspaceSequence(client, current.claims.tenantId, current.claims.activeWorkspaceId);
        const existing = await client.query<{ id: string; mode: string; created_at: string | Date }>(
          `SELECT id,mode,created_at FROM cloud_source_ingestions WHERE tenant_id=$1 AND workspace_id=$2
            AND source_id=$3 AND actor_id=$4 AND status='collecting' FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, parsed.data.sourceId, current.claims.principalId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].mode !== parsed.data.mode) return { error: 'INGESTION_ALREADY_OPEN' as const };
          return { ingestionId: existing.rows[0].id, mode: existing.rows[0].mode,
            startedAt: new Date(existing.rows[0].created_at).toISOString() };
        }
        const created = await client.query<{ id: string; created_at: string | Date }>(
          `INSERT INTO cloud_source_ingestions(tenant_id,workspace_id,id,source_id,actor_id,mode)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, crypto.randomUUID(), parsed.data.sourceId,
            current.claims.principalId, parsed.data.mode],
        );
        if (!created.rows[0]) return { error: 'INGESTION_STORAGE_UNAVAILABLE' as const };
        return { ingestionId: created.rows[0].id, mode: parsed.data.mode,
          startedAt: new Date(created.rows[0].created_at).toISOString() };
      });
    if (!result) return c.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if ('error' in result) return c.json({ code: result.error }, result.error === 'INGESTION_STORAGE_UNAVAILABLE' ? 503 : 409);
    return c.json(CloudIngestionBeginResult.parse({ protocolVersion: 'cloud-ingest-v2', ingestionId: result.ingestionId,
      tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId,
      sourceId: parsed.data.sourceId, mode: result.mode, startedAt: result.startedAt }));
  } catch {
    return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  }
});

app.post('/v2/brain/ingestions/:ingestionId/finalize', async (c) => {
  const incoming = await boundedJson(c.req.raw, 32 * 1024, 'INGESTION_BODY_TOO_LARGE');
  if (incoming instanceof Response) return incoming;
  const parsed = CloudIngestionFinalizeRequest.safeParse(incoming.value);
  if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(c.req.param('ingestionId')))
    return c.json({ code: 'INVALID_INGESTION_FINALIZATION' }, 400);
  const current = await currentHub(c, incoming.bytes);
  if ('response' in current) return current.response;
  if (current.claims.kind !== 'user') return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const rule = TABLE_RULES.get('brain_sources');
  if (!rule || !decideAccess(accessContext(current), rule.manifest, 'brain:source:write', 'write').ok)
    return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  try {
    const receipt = await withNeonTransaction(connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted || !decideAccess(trusted, rule.manifest, 'brain:source:write', 'write').ok) return { error: 'CURRENT_MEMBERSHIP_REQUIRED' as const };
        await lockWorkspaceSequence(client, current.claims.tenantId, current.claims.activeWorkspaceId);
        const ingestions = await client.query<{
          id: string; source_id: string; actor_id: string; mode: string; status: string; created_at: string | Date;
          content_version: string | null; source_version: string | null; source_version_id: string | null;
          content_digest: string | null; reference_state_version: string | number | null; snapshot_digest: string | null;
          reference_state: string | null; object_ref_ids: unknown; finalized_at: string | Date | null;
        }>(`SELECT * FROM cloud_source_ingestions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, c.req.param('ingestionId')]);
        const ingestion = ingestions.rows[0];
        if (!ingestion || ingestion.actor_id !== current.claims.principalId) return { error: 'INGESTION_NOT_FOUND' as const };
        if (ingestion.status === 'finalized') {
          const currentSnapshot = await client.query<{ current: boolean }>(
            `SELECT current FROM cloud_erasure_reference_sets WHERE tenant_id=$1 AND workspace_id=$2 AND ingestion_id=$3`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.id]);
          if (!currentSnapshot.rows[0]?.current) return { error: 'INGESTION_FINALIZATION_INVALIDATED' as const };
          return {
            protocolVersion: 'cloud-ingest-v2', ingestionId: ingestion.id, tenantId: current.claims.tenantId,
            workspaceId: current.claims.activeWorkspaceId, sourceId: ingestion.source_id, sourceVersionId: ingestion.source_version_id!,
            contentDigest: ingestion.content_digest!, sourceVersion: ingestion.source_version!,
            referenceState: ingestion.reference_state!, objectRefIds: ingestion.object_ref_ids as string[],
            referenceSetDigest: ingestion.snapshot_digest!, referenceStateVersion: Number(ingestion.reference_state_version),
            finalizedAt: new Date(ingestion.finalized_at!).toISOString(), status: 'finalized' as const,
          };
        }
        if (ingestion.status !== 'collecting') return { error: 'INGESTION_NOT_FINALIZABLE' as const };
        const activeClaim = await client.query(
          `SELECT 1 FROM cloud_erasure_operations WHERE tenant_id=$1 AND workspace_id=$2
            AND source_kind='brain_source' AND source_id=$3
            AND status IN ('purge_claimed','local_purge_acknowledged','delete_pending') LIMIT 1`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        if (activeClaim.rows.length) return { error: 'ERASURE_CLAIM_ACTIVE' as const };
        const source = await client.query<{ fields: unknown; deleted_hlc: string | null }>(
          `SELECT fields,deleted_hlc FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
            AND table_name='brain_sources' AND row_id=$3 FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        const versions = await client.query<{ row_id: string; fields: unknown; deleted_hlc: string | null; updated_at: string | Date }>(
          `SELECT row_id,fields,deleted_hlc,updated_at FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
            AND table_name='brain_source_versions' AND fields->'source_id'->>'value'=$3
            ORDER BY row_id FOR UPDATE`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        const parseFields = (value: unknown): Record<string, { value: unknown }> =>
          typeof value === 'string' ? JSON.parse(value) as Record<string, { value: unknown }> : value as Record<string, { value: unknown }>;
        let snapshot;
        try {
          snapshot = sourceVersionSnapshotFromSyncedRows(ingestion.source_id,
            source.rows[0] ? { fields: parseFields(source.rows[0].fields), deleted: !!source.rows[0].deleted_hlc } : undefined,
            versions.rows.map((row) => ({ id: row.row_id, fields: parseFields(row.fields), deleted: !!row.deleted_hlc })));
        } catch { return { error: 'SOURCE_STATE_UNAVAILABLE' as const }; }
        const target = versions.rows.find((row) => row.row_id === parsed.data.sourceVersionId);
        if (!target) return { error: 'SOURCE_VERSION_UNAVAILABLE' as const };
        const targetFields = parseFields(target.fields);
        const digest = targetFields['content_hash']?.value;
        if (typeof digest !== 'string' || digest !== parsed.data.contentDigest)
          return { error: 'SOURCE_CONTENT_DIGEST_MISMATCH' as const };
        const versionValue = targetFields['version']?.value;
        const maxVersion = Math.max(...snapshot.versions.map(({ version }) => version));
        if (versionValue !== maxVersion || new Date(target.updated_at).getTime() < new Date(ingestion.created_at).getTime())
          return { error: 'SOURCE_VERSION_STALE' as const };
        const sourceFields = parseFields(source.rows[0]!.fields);
        const syncedRefs = sourceFields['cloud_object_ref_ids']?.value;
        if (!Array.isArray(syncedRefs) || !syncedRefs.every((value) => typeof value === 'string'))
          return { error: 'SOURCE_REFERENCES_UNAVAILABLE' as const };
        const syncedObjectIds = syncedRefs as string[];
        if (syncedObjectIds.some((id) => id !== id.toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) ||
            new Set(syncedObjectIds).size !== syncedObjectIds.length)
          return { error: 'SOURCE_REFERENCES_UNAVAILABLE' as const };
        const issued = await client.query<{ object_id: string; uploaded_at: string | Date | null; storage_state: string }>(
          `SELECT i.object_id,i.uploaded_at,o.storage_state FROM cloud_source_ingestion_objects i
            JOIN cloud_erasure_objects o ON (o.tenant_id,o.workspace_id,o.id)=(i.tenant_id,i.workspace_id,i.object_id)
            WHERE i.tenant_id=$1 AND i.workspace_id=$2 AND i.ingestion_id=$3 ORDER BY i.object_id FOR UPDATE OF i,o`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.id]);
        const objectRefIds = issued.rows.map(({ object_id }) => object_id);
        if ((ingestion.mode === 'text_only' && objectRefIds.length !== 0) ||
            (ingestion.mode === 'with_objects' && objectRefIds.length === 0) ||
            issued.rows.some((row) => !row.uploaded_at || row.storage_state !== 'available') ||
            [...syncedObjectIds].sort().join(',') !== [...objectRefIds].sort().join(','))
          return { error: 'SOURCE_REFERENCES_UNAVAILABLE' as const };
        const contentVersion = await sourceVersionDigest(snapshot);
        if (objectRefIds.some((id, i) => id !== [...new Set(objectRefIds)].sort()[i]))
          return { error: 'DUPLICATE_OBJECT_REFERENCE' as const };
        const next = await client.query<{ version: string | number }>(
          `SELECT COALESCE(MAX(reference_state_version),0)+1 AS version FROM cloud_erasure_reference_sets
            WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        const referenceStateVersion = Number(next.rows[0]?.version ?? 1);
        const sourceVersion = await erasureSourceSnapshotVersion(ingestion.source_id, parsed.data.sourceVersionId,
          current.claims.tenantId, current.claims.activeWorkspaceId, digest, objectRefIds, referenceStateVersion);
        const referenceSetDigest = await blobReferenceSnapshotDigest(ingestion.source_id, parsed.data.sourceVersionId, objectRefIds);
        const old = await client.query(`UPDATE cloud_erasure_reference_sets SET current=false,invalidated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3 AND current=true`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        await client.query(`UPDATE cloud_erasure_refs SET active=false,retired_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND source_kind='brain_source' AND source_id=$3 AND active=true`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        for (const objectId of objectRefIds) {
          await client.query(`INSERT INTO cloud_erasure_refs(tenant_id,workspace_id,object_id,source_kind,source_id)
            VALUES ($1,$2,$3,'brain_source',$4) ON CONFLICT (tenant_id,workspace_id,object_id,source_kind,source_id)
            DO UPDATE SET active=true,retired_at=NULL`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, objectId, ingestion.source_id]);
          await client.query(`UPDATE cloud_erasure_objects SET reference_state_version=reference_state_version+1
            WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, objectId]);
        }
        const snapshotId = crypto.randomUUID();
        const referenceState = objectRefIds.length ? 'verified_nonempty' : 'verified_empty';
        await client.query(`INSERT INTO cloud_erasure_reference_sets
          (tenant_id,workspace_id,snapshot_id,source_kind,source_id,source_version,snapshot_digest,reference_state_version,object_ids,ingestion_id,content_version,completeness)
          VALUES ($1,$2,$3,'brain_source',$4,$5,$6,$7,$8::uuid[],$9,$10,$11)`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, snapshotId, ingestion.source_id,
            sourceVersion, referenceSetDigest, referenceStateVersion, objectRefIds, ingestion.id, contentVersion, referenceState]);
        const finalizedAt = new Date().toISOString();
        await client.query(`UPDATE cloud_source_ingestions SET status='finalized',content_version=$4,source_version=$5,
          source_version_id=$6,content_digest=$7,reference_state_version=$8,snapshot_digest=$9,
          reference_state=$10,object_ref_ids=$11::uuid[],updated_at=now(),finalized_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.id, contentVersion, sourceVersion,
            parsed.data.sourceVersionId, digest, referenceStateVersion, referenceSetDigest, referenceState, objectRefIds]);
        const invalidated = await client.query<{ id: string }>(
          `UPDATE cloud_erasure_operations SET status='eligibility_invalidated',reservation_id=NULL,
            reservation_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2
            AND source_kind='brain_source' AND source_id=$3 AND status='eligible' RETURNING id`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, ingestion.source_id]);
        for (const operation of invalidated.rows) await client.query(
          `INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
           VALUES ($1,$2,$3,$4,'eligibility_invalidated','{"reason":"reference_finalized"}'::jsonb)`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, operation.id, crypto.randomUUID()]);
        void old;
        return { protocolVersion: 'cloud-ingest-v2' as const, ingestionId: ingestion.id,
          tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId,
          sourceId: ingestion.source_id, sourceVersionId: parsed.data.sourceVersionId,
          contentDigest: digest, sourceVersion, referenceState, objectRefIds,
          referenceSetDigest, referenceStateVersion, finalizedAt, status: 'finalized' as const };
      });
    if ('error' in receipt) return c.json({ code: receipt.error }, receipt.error === 'CURRENT_MEMBERSHIP_REQUIRED' ? 403 : receipt.error === 'ERASURE_CLAIM_ACTIVE' ? 423 : 409);
    return c.json(CloudIngestionFinalizationReceipt.parse(receipt));
  } catch {
    return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  }
});

app.get('/v2/brain/ingestions/:ingestionId', async (c) => {
  if (!/^[0-9a-f-]{36}$/i.test(c.req.param('ingestionId'))) return c.json({ code: 'INVALID_INGESTION_ID' }, 400);
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  const rule = TABLE_RULES.get('brain_sources');
  if (!rule || !decideAccess(accessContext(current), rule.manifest, 'brain:source:read', 'read').ok)
    return c.json({ code: 'PERMISSION_DENIED' }, 403);
  const connectionString = databaseUrl(c.env);
  if (!connectionString) return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  try {
    const receipt = await withNeonTransaction(connectionString,
      { tenantId: current.claims.tenantId, workspaceId: current.claims.activeWorkspaceId },
      async (client) => {
        const trusted = await recheckedAccess(client, current);
        if (!trusted || !decideAccess(trusted, rule.manifest, 'brain:source:read', 'read').ok) return null;
        const found = await client.query<Record<string, unknown>>(
          `SELECT i.*, (r.current AND i.status='finalized') AS snapshot_current
             FROM cloud_source_ingestions i LEFT JOIN cloud_erasure_reference_sets r
               ON (r.tenant_id,r.workspace_id,r.ingestion_id)=(i.tenant_id,i.workspace_id,i.id)
            WHERE i.tenant_id=$1 AND i.workspace_id=$2 AND i.id=$3`,
          [current.claims.tenantId, current.claims.activeWorkspaceId, c.req.param('ingestionId')]);
        const row = found.rows[0];
        if (!row) return { error: 'INGESTION_NOT_FOUND' as const };
        const wasInvalidated = row['status'] === 'invalidated' ||
          (row['status'] === 'finalized' && row['snapshot_current'] !== true);
        if (wasInvalidated) return { protocolVersion: 'cloud-ingest-v2' as const, status: 'invalidated' as const, ingestionId: row['id'],
          sourceId: row['source_id'], sourceVersionId: row['source_version_id'],
          invalidatedAt: new Date(String(row['invalidated_at'] ?? row['updated_at'])).toISOString() };
        if (row['status'] === 'finalized') return { protocolVersion: 'cloud-ingest-v2' as const, status: 'finalized' as const, receipt: CloudIngestionFinalizationReceipt.parse({
          protocolVersion: 'cloud-ingest-v2' as const, ingestionId: row['id'], tenantId: row['tenant_id'],
          workspaceId: row['workspace_id'], sourceId: row['source_id'], sourceVersionId: row['source_version_id'],
          contentDigest: row['content_digest'], sourceVersion: row['source_version'],
          referenceState: row['reference_state'], objectRefIds: row['object_ref_ids'],
          referenceSetDigest: row['snapshot_digest'], referenceStateVersion: Number(row['reference_state_version']),
          finalizedAt: new Date(String(row['finalized_at'])).toISOString(), status: 'finalized' as const,
        }) };
        return { protocolVersion: 'cloud-ingest-v2' as const, status: 'pending' as const,
          ingestionId: row['id'], sourceId: row['source_id'], tenantId: row['tenant_id'], workspaceId: row['workspace_id'],
          mode: row['mode'], startedAt: new Date(String(row['created_at'])).toISOString() };
      });
    if (!receipt) return c.json({ code: 'CURRENT_MEMBERSHIP_REQUIRED' }, 403);
    if ('error' in receipt) return c.json({ code: receipt.error }, 404);
    return c.json(CloudIngestionStatus.parse(receipt));
  } catch {
    return c.json({ code: 'INGESTION_STORAGE_UNAVAILABLE' }, 503);
  }
});

app.post('/v1/blob-reference-sets', (c) => c.json({ code: 'UPDATE_REQUIRED', protocolVersion: 'cloud-ingest-v2' }, 426));

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
  const ingestionId = typeof body.ingestionId === 'string' ? body.ingestionId : undefined;
  if (
    !mode ||
    !name ||
    (body.ingestionId !== undefined && (!ingestionId || !/^[0-9a-f-]{36}$/i.test(ingestionId) || mode !== 'PUT')) ||
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
              await client.query(`UPDATE cloud_source_ingestions SET status='invalidated',updated_at=now(),invalidated_at=now()
                WHERE tenant_id=$1 AND workspace_id=$2 AND id IN
                  (SELECT ingestion_id FROM cloud_source_ingestion_objects WHERE tenant_id=$1 AND workspace_id=$2 AND object_id=$3)
                  AND status='finalized'`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, objectId]);
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
            if (ingestionId) {
              const ingest = await client.query(
                `SELECT 1 FROM cloud_source_ingestions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
                  AND actor_id=$4 AND mode='with_objects' AND status='collecting' FOR UPDATE`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, ingestionId, current.claims.principalId]);
              if (!ingest.rows.length) return { error: 'INGESTION_NOT_FOUND' as const };
              await client.query(`INSERT INTO cloud_source_ingestion_objects(tenant_id,workspace_id,ingestion_id,object_id)
                VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
                [current.claims.tenantId, current.claims.activeWorkspaceId, ingestionId, objectId]);
            }
            return { id: objectId };
          }
          const result = await client.query<{ id: string }>(
            `INSERT INTO cloud_erasure_objects(tenant_id,workspace_id,id,storage_key,storage_state)
             VALUES ($1,$2,$3,$4,'unknown') RETURNING id`,
            [current.claims.tenantId, current.claims.activeWorkspaceId, crypto.randomUUID(), key],
          );
          const id = result.rows[0]?.id ?? null;
          if (ingestionId) {
            const ingest = await client.query(
              `SELECT 1 FROM cloud_source_ingestions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
                AND actor_id=$4 AND mode='with_objects' AND status='collecting' FOR UPDATE`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, ingestionId, current.claims.principalId]);
            if (!ingest.rows.length) return { error: 'INGESTION_NOT_FOUND' as const };
            if (id) await client.query(`INSERT INTO cloud_source_ingestion_objects(tenant_id,workspace_id,ingestion_id,object_id)
              VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [current.claims.tenantId, current.claims.activeWorkspaceId, ingestionId, id]);
          }
          return { id };
        });
      if ('error' in registration) return c.json({ code: registration.error }, registration.error === 'ERASURE_CLAIM_ACTIVE' ? 423 : 409);
      objectRefId = registration.id;
    } catch {
      return c.json({ code: 'BLOB_REFERENCE_REGISTRY_UNAVAILABLE' }, 503);
    }
  }
  const expiresAtMs = Date.now() + expiresInSec * 1000;
  const token = await signBlobAccess(
    { key, principalId: current.claims.principalId, mode, expiresAtMs, ...(ingestionId ? { ingestionId } : {}) },
    c.env.BLOB_ACCESS_SECRET,
  );
  // The storage key is an internal locator. Callers need only the opaque reference ID
  // (when durably registered) and the signed relative access path.
  return c.json({ mode, expiresAtMs, url: `/v1/blobs/access/${token}`,
    ...(mode === 'PUT' ? { objectRefId, referenceStatus: objectRefId ? (ingestionId ? 'tracked' : 'registration_required') : 'references_unknown' } : {}) });
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
            if (access.ingestionId) await client.query(`UPDATE cloud_source_ingestion_objects SET uploaded_at=COALESCE(uploaded_at,now())
              WHERE tenant_id=$1 AND workspace_id=$2 AND ingestion_id=$3 AND object_id=(
                SELECT id FROM cloud_erasure_objects WHERE tenant_id=$1 AND workspace_id=$2 AND storage_key=$4)`,
              [tenantId, workspaceId, access.ingestionId, access.key]);
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
app.post('/v1/auth/logout', async (c) => {
  const current = await currentHub(c);
  if ('response' in current) return current.response;
  if (current.claims.kind !== 'user') return c.json({ code: 'PERMISSION_DENIED' }, 403);
  if (!current.claims.sessionFamilyId) return c.json({ code: 'SESSION_NOT_FOUND' }, 409);
  const database = databaseUrl(c.env);
  if (!database) return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  try {
    const revoked = await revokeCurrentRefreshFamily(database, current.claims);
    if (!revoked) return c.json({ code: 'SESSION_NOT_FOUND' }, 404);
    return c.json({ status: 'revoked' });
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
