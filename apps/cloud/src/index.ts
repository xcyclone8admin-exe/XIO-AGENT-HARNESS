import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

export interface Env {
  readonly NEON_DATABASE_URL: string;
  readonly BLOBS: R2Bucket;
  readonly JOBS: Queue;
  readonly HUB: DurableObjectNamespace<WorkspaceHub>;
  readonly CACHE: KVNamespace;
}

/** The hub will own per-workspace leases and kill-switch broadcast in WP-CLOUD. */
export class WorkspaceHub extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return Response.json({ code: 'HUB_NOT_READY' }, { status: 503 });
  }
}

const app = new Hono<{ Bindings: Env }>();
app.get('/v1/health', (c) => c.json({ status: 'ok' }));
app.all('/v1/*', (c) => c.json({ code: 'CLOUD_CAPABILITY_NOT_READY' }, 503));

export default {
  fetch: app.fetch,
  async queue(): Promise<void> {
    // Never acknowledge jobs while the handler is absent; Queues will retry.
    throw new Error('CLOUD_QUEUE_HANDLER_NOT_READY');
  },
  async scheduled(): Promise<void> {
    throw new Error('CLOUD_CRON_HANDLER_NOT_READY');
  },
} satisfies ExportedHandler<Env>;
