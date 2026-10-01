import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  CloudInvestSignalEnvelopeDigestAlgorithm,
  CloudInvestSignalEnvelopeDigestVersion,
  cloudInvestSignalEnvelopeDigest,
} from '@xyra/contracts';
import {
  assertPushResponseBoundToRequest,
  PushRequest,
  PushResponse,
  type Principal,
  type PushRequest as PushRequestValue,
  type PushResponse as PushResponseValue,
} from '@xyra/contracts';
import { BusFault, type CapabilityBus } from './bus';

const CallBody = z.object({ workspaceId: z.uuid(), input: z.unknown(), approvalId: z.uuid().optional() });

export interface SidecarHttpOptions {
  readonly port: number;
  /** 256-bit per-launch token handed to the WebView through native IPC. */
  readonly launchToken: string;
  /** Separate native-only token; never returned by sidecar_endpoint or exposed to WebView. */
  readonly nativeSyncToken?: string;
  readonly allowedOrigins: readonly string[];
  readonly resolvePrincipal: () => Promise<Principal>;
  readonly bus: CapabilityBus;
  /** Records a validated Cloud response. Must be wired to a trusted server-side service only. */
  readonly acceptCloudSyncPush?: (
    scope: { readonly tenantId: string; readonly workspaceId: string },
    request: PushRequestValue,
    response: PushResponseValue,
  ) => Promise<void>;
  /** Persists a Cloud-verified signal as a scoped advisory decision before native ACKs Cloud. */
  readonly acceptCloudInvestSignal?: (
    scope: { readonly tenantId: string; readonly workspaceId: string },
    claim: CloudInvestSignalClaim,
    actorId: string,
  ) => Promise<{ readonly decisionId: string }>;
}

const NATIVE_SYNC_PATH = '/internal/native/cloud-sync/push';
const NATIVE_INVEST_SIGNAL_PATH = '/internal/native/invest/signals/consume';
const NATIVE_ONLY_PATHS = new Set([NATIVE_SYNC_PATH, NATIVE_INVEST_SIGNAL_PATH]);
const MAX_NATIVE_SYNC_BODY_BYTES = 2_100_000;
const MAX_NATIVE_INVEST_SIGNAL_BODY_BYTES = 40_000;
const INVEST_SIGNAL_PROTOCOL = 'xyra.invest.signal.v1';

const Uuid = z.uuid().refine((value) => value === value.toLowerCase());
const CloudInvestSignalEnvelope = z.strictObject({
  protocol: z.literal(INVEST_SIGNAL_PROTOCOL),
  eventId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  sourceId: Uuid,
  tenantId: Uuid,
  workspaceId: Uuid,
  receivedAt: z.iso.datetime({ offset: true }),
  occurredAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  algorithmId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/),
  signalId: Uuid,
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/),
  side: z.enum(['buy', 'sell']),
  quantity: z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  verification: z.strictObject({
    signature: z.literal('verified'),
    keyId: Uuid,
    signingAlg: z.enum(['ES256', 'EdDSA']),
  }),
  envelopeDigestVersion: z.literal(CloudInvestSignalEnvelopeDigestVersion),
  envelopeDigestAlgorithm: z.literal(CloudInvestSignalEnvelopeDigestAlgorithm),
  envelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
const CloudInvestSignalClaim = z.strictObject({
  status: z.literal('claimed'),
  lease: z.strictObject({
    leaseId: Uuid,
    fence: z.number().int().positive(),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  signal: CloudInvestSignalEnvelope,
});
export type CloudInvestSignalClaim = z.infer<typeof CloudInvestSignalClaim>;

async function boundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; code: string }> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, code: 'INVALID_JSON' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, code: 'REQUEST_TOO_LARGE' };
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, code: 'INVALID_JSON' };
  } finally {
    reader.releaseLock();
  }
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(candidate.slice(7));
  const reference = Buffer.from(expected);
  return provided.length === reference.length && timingSafeEqual(provided, reference);
}

function nativeTokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const provided = Buffer.from(candidate);
  const reference = Buffer.from(expected);
  return provided.length === reference.length && timingSafeEqual(provided, reference);
}

export function createSidecarApp(options: SidecarHttpOptions): Hono {
  if (
    options.port < 1 ||
    options.port > 65535 ||
    Buffer.from(options.launchToken).length < 32 ||
    (options.nativeSyncToken !== undefined && Buffer.from(options.nativeSyncToken).length < 32)
  ) {
    throw new Error('Sidecar requires a bound port and a 256-bit launch token');
  }
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('host') !== `127.0.0.1:${options.port}`) return c.json({ code: 'HOST_REJECTED' }, 403);
    const origin = c.req.header('origin');
    if (NATIVE_ONLY_PATHS.has(c.req.path) && (origin || c.req.method !== 'POST')) {
      return c.json({ code: 'NATIVE_SYNC_ONLY' }, 403);
    }
    if (origin && !options.allowedOrigins.includes(origin)) return c.json({ code: 'ORIGIN_REJECTED' }, 403);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (NATIVE_ONLY_PATHS.has(c.req.path)) {
      if (
        !options.nativeSyncToken ||
        !nativeTokenMatches(c.req.header('x-xyra-native-sync-token'), options.nativeSyncToken)
      ) {
        return c.json({ code: 'NATIVE_SYNC_ONLY' }, 403);
      }
    } else if (
      c.req.path !== '/api/health' &&
      !tokenMatches(c.req.header('authorization'), options.launchToken)
    ) {
      return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.post(NATIVE_SYNC_PATH, async (c) => {
    if (!options.nativeSyncToken) return c.json({ code: 'NATIVE_SYNC_UNAVAILABLE' }, 503);
    if (!options.acceptCloudSyncPush) return c.json({ code: 'NATIVE_SYNC_HANDLER_UNAVAILABLE' }, 503);
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return c.json({ code: 'CONTENT_TYPE_REQUIRED' }, 415);
    const raw = await boundedJson(c.req.raw, MAX_NATIVE_SYNC_BODY_BYTES);
    if (!raw.ok) return c.json({ code: raw.code }, raw.status);
    const envelope = z.strictObject({ request: PushRequest, response: PushResponse }).safeParse(raw.value);
    if (!envelope.success) return c.json({ code: 'SYNC_ACK_INVALID' }, 400);
    const principal = await options.resolvePrincipal();
    const allowedWorkspaces = new Set(principal.workspaces.map((workspace) => workspace.id));
    const workspaces = new Set(envelope.data.request.changes.map((change) => change.workspaceId));
    if (
      principal.kind !== 'user' ||
      workspaces.size !== 1 ||
      envelope.data.request.changes.some(
        (change) =>
          change.tenantId !== principal.tenantId ||
          change.workspaceId === null ||
          !allowedWorkspaces.has(change.workspaceId),
      )
    )
      return c.json({ code: 'SYNC_ACK_SCOPE_MISMATCH' }, 403);
    try {
      assertPushResponseBoundToRequest(envelope.data.request, envelope.data.response);
      const workspaceId = [...workspaces][0];
      if (!workspaceId) return c.json({ code: 'SYNC_ACK_SCOPE_MISMATCH' }, 403);
      await options.acceptCloudSyncPush(
        { tenantId: principal.tenantId, workspaceId },
        envelope.data.request,
        envelope.data.response,
      );
      return c.json({ status: 'recorded' });
    } catch {
      return c.json({ code: 'SYNC_ACK_REJECTED' }, 409);
    }
  });
  app.post(NATIVE_INVEST_SIGNAL_PATH, async (c) => {
    if (!options.nativeSyncToken) return c.json({ code: 'NATIVE_SYNC_UNAVAILABLE' }, 503);
    if (!options.acceptCloudInvestSignal) return c.json({ code: 'INVEST_SIGNAL_HANDLER_UNAVAILABLE' }, 503);
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return c.json({ code: 'CONTENT_TYPE_REQUIRED' }, 415);
    const raw = await boundedJson(c.req.raw, MAX_NATIVE_INVEST_SIGNAL_BODY_BYTES);
    if (!raw.ok) return c.json({ code: raw.code }, raw.status);
    const parsed = CloudInvestSignalClaim.safeParse(raw.value);
    if (!parsed.success) return c.json({ code: 'INVEST_SIGNAL_CLAIM_INVALID' }, 400);
    const { signal, lease } = parsed.data;
    const principal = await options.resolvePrincipal();
    const workspace = principal.workspaces.find((candidate) => candidate.id === signal.workspaceId);
    if (principal.kind !== 'user' || principal.tenantId !== signal.tenantId || !workspace) {
      return c.json({ code: 'INVEST_SIGNAL_SCOPE_MISMATCH' }, 403);
    }
    const now = Date.now();
    const leaseExpiry = Date.parse(lease.expiresAt);
    const signalExpiry = Date.parse(signal.expiresAt);
    const occurredAt = Date.parse(signal.occurredAt);
    if (
      leaseExpiry <= now || leaseExpiry > now + 30_000 ||
      signalExpiry <= now || occurredAt > now + 300_000
    ) return c.json({ code: 'INVEST_SIGNAL_EXPIRED' }, 409);
    const {
      envelopeDigest,
      envelopeDigestAlgorithm: _digestAlgorithm,
      envelopeDigestVersion: _digestVersion,
      ...digestInput
    } = signal;
    let expectedEnvelopeDigest: string;
    try {
      expectedEnvelopeDigest = await cloudInvestSignalEnvelopeDigest(digestInput);
    } catch {
      return c.json({ code: 'INVEST_SIGNAL_ENVELOPE_DIGEST_INVALID' }, 400);
    }
    if (expectedEnvelopeDigest !== envelopeDigest)
      return c.json({ code: 'INVEST_SIGNAL_ENVELOPE_DIGEST_MISMATCH' }, 409);
    try {
      const result = await options.acceptCloudInvestSignal(
        { tenantId: principal.tenantId, workspaceId: signal.workspaceId },
        parsed.data,
        principal.id,
      );
      const decisionId = Uuid.safeParse(result.decisionId);
      if (!decisionId.success) return c.json({ code: 'INVEST_SIGNAL_DECISION_INVALID' }, 500);
      return c.json({ decisionId: decisionId.data });
    } catch {
      return c.json({ code: 'INVEST_SIGNAL_DECISION_FAILED' }, 409);
    }
  });
  app.get('/api/v1/session', async (c) => {
    const principal = await options.resolvePrincipal();
    return c.json({
      tenantId: principal.tenantId,
      user: { id: principal.id, displayName: principal.displayName ?? 'Local user' },
      workspaces: principal.workspaces,
    });
  });
  app.get('/api/v1/catalog', async (c) => {
    const workspace = z.uuid().safeParse(c.req.query('workspaceId'));
    if (!workspace.success) return c.json({ code: 'INVALID_WORKSPACE' }, 400);
    const principal = await options.resolvePrincipal();
    return c.json(
      (await options.bus.catalog(principal, workspace.data)).map((cap) => ({
        id: cap.id,
        module: cap.module,
        title: cap.title,
        description: cap.description,
        kind: cap.kind,
        risk: cap.risk,
        agentCallable: cap.agentCallable,
        inputSchema: z.toJSONSchema(cap.input),
        outputSchema: z.toJSONSchema(cap.output),
      })),
    );
  });
  app.post('/api/v1/call/:id', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ code: 'INVALID_JSON' }, 400);
    }
    const body = CallBody.safeParse(raw);
    if (!body.success) return c.json({ code: 'INVALID_BODY' }, 400);
    try {
      const principal = await options.resolvePrincipal();
      const idempotencyKey = c.req.header('idempotency-key');
      const result = await options.bus.call({
        principal,
        workspaceId: body.data.workspaceId,
        capabilityId: c.req.param('id'),
        input: body.data.input,
        ...(body.data.approvalId === undefined ? {} : { approvalId: body.data.approvalId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      return c.json({ data: result });
    } catch (error) {
      if (error instanceof BusFault)
        return c.json({ code: error.code, detail: error.message }, error.httpStatus as 400);
      return c.json({ code: 'INTERNAL', detail: 'Capability failed' }, 500);
    }
  });
  return app;
}
