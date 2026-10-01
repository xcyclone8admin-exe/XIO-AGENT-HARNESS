import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
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
  readonly acceptCloudSyncPush?: (request: PushRequestValue, response: PushResponseValue) => Promise<void>;
}

const NATIVE_SYNC_PATH = '/internal/native/cloud-sync/push';
const MAX_NATIVE_SYNC_BODY_BYTES = 2_100_000;

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
    if (c.req.path === NATIVE_SYNC_PATH && (origin || c.req.method !== 'POST')) {
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
    if (c.req.path === NATIVE_SYNC_PATH) {
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
    if (
      principal.kind !== 'user' ||
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
      await options.acceptCloudSyncPush(envelope.data.request, envelope.data.response);
      return c.json({ status: 'recorded' });
    } catch {
      return c.json({ code: 'SYNC_ACK_REJECTED' }, 409);
    }
  });
  app.get('/api/v1/session', async (c) => {
    const principal = await options.resolvePrincipal();
    return c.json({
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
