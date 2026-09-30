import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from '@xyra/contracts';
import { BusFault, type CapabilityBus } from './bus';

const CallBody = z.object({ workspaceId: z.uuid(), input: z.unknown(), approvalId: z.uuid().optional() });

export interface SidecarHttpOptions {
  readonly port: number;
  /** 256-bit per-launch token handed to the WebView through native IPC. */
  readonly launchToken: string;
  readonly allowedOrigins: readonly string[];
  readonly resolvePrincipal: () => Promise<Principal>;
  readonly bus: CapabilityBus;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(candidate.slice(7));
  const reference = Buffer.from(expected);
  return provided.length === reference.length && timingSafeEqual(provided, reference);
}

export function createSidecarApp(options: SidecarHttpOptions): Hono {
  if (options.port < 1 || options.port > 65535 || Buffer.from(options.launchToken).length < 32) {
    throw new Error('Sidecar requires a bound port and a 256-bit launch token');
  }
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('host') !== `127.0.0.1:${options.port}`) return c.json({ code: 'HOST_REJECTED' }, 403);
    const origin = c.req.header('origin');
    if (origin && !options.allowedOrigins.includes(origin)) return c.json({ code: 'ORIGIN_REJECTED' }, 403);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (c.req.path !== '/api/health' && !tokenMatches(c.req.header('authorization'), options.launchToken)) {
      return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
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
