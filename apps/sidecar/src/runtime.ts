import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { bootstrapLocalIdentity, CoreService } from '@xyra/mod-core/server';
import { OpsService } from '@xyra/mod-ops/server';
import { MIGRATIONS } from './generated/migrations';
import { MANIFESTS } from './generated/modules';
import { CapabilityBus } from './bus';
import { DurableBusAudit, DurableBusIdempotency } from './durable';
import { registerFoundationCapabilities } from './foundation';
import { createSidecarApp } from './http';

export interface LocalSidecarOptions {
  readonly dataDir: string;
  readonly port: number;
  /** Native host supplies this from a trusted OS identity source, never the WebView. */
  readonly osSubject: string;
  readonly displayName: string;
  readonly allowedOrigins: readonly string[];
  /** Native host may generate it; otherwise a 256-bit token is made here. */
  readonly launchToken?: string;
}

export interface LocalSidecarSession {
  readonly port: number;
  readonly launchToken: string;
  close(): Promise<void>;
}

/** Run the trusted local service on IPv4 loopback only. The caller passes the token to WebView via native IPC. */
export async function startLocalSidecar(options: LocalSidecarOptions): Promise<LocalSidecarSession> {
  if (!options.dataDir || !options.osSubject || !options.allowedOrigins.length)
    throw new Error('Data directory, native identity and origin are required');
  const db = await openLocalStore(options.dataDir);
  try {
    await applyPGliteMigrations(db, MIGRATIONS);
    await prepareLocalAppRole(
      db,
      MANIFESTS.flatMap((manifest) => manifest.tables),
    );
    const principal = await bootstrapLocalIdentity(db, options.osSubject, options.displayName);
    const scoped = new LocalScopedStore(db);
    const bus = new CapabilityBus(
      new DurableBusAudit(scoped),
      new DurableBusIdempotency(scoped),
      // Consequential capabilities stay disabled until the approval service is wired.
      { verify: async () => false },
      () => false,
      async () => new Set(),
    );
    registerFoundationCapabilities(bus, new CoreService(scoped), new OpsService(scoped));
    const launchToken = options.launchToken ?? randomBytes(32).toString('base64url');
    const app = createSidecarApp({
      port: options.port,
      launchToken,
      allowedOrigins: options.allowedOrigins,
      resolvePrincipal: async () => principal,
      bus,
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port });
    return {
      port: options.port,
      launchToken,
      close: async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
