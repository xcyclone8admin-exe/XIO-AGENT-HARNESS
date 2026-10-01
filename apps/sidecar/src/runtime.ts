import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { PGliteLedgerWriter } from '@xyra/ledger';
import { bootstrapLocalIdentity, CoreService } from '@xyra/mod-core/server';
import { MoneyService } from '@xyra/mod-money/server';
import { OpsService } from '@xyra/mod-ops/server';
import { BrainService } from '@xyra/mod-brain/server';
import { MIGRATIONS } from './generated/migrations';
import { MANIFESTS } from './generated/modules';
import { CapabilityBus } from './bus';
import { DurableBusApproval, DurableBusAudit, DurableBusIdempotency } from './durable';
import { registerBrainCapabilities } from './brain';
import { registerFoundationCapabilities } from './foundation';
import { createSidecarApp } from './http';
import type { PushRequest as PushRequestValue, PushResponse as PushResponseValue } from '@xyra/contracts';

export interface LocalSidecarOptions {
  readonly dataDir: string;
  readonly port: number;
  /** Native host supplies this from a trusted OS identity source, never the WebView. */
  readonly osSubject: string;
  readonly displayName: string;
  readonly allowedOrigins: readonly string[];
  /** Native host may generate it; otherwise a 256-bit token is made here. */
  readonly launchToken?: string;
  /** Private native→sidecar callback token; must never be returned through LocalSidecarSession. */
  readonly nativeSyncToken?: string;
  /** Trusted host adapter; leave unset until BRAIN's durable acknowledgement handler is available. */
  readonly acceptCloudSyncPush?: (request: PushRequestValue, response: PushResponseValue) => Promise<void>;
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
      new DurableBusApproval(scoped),
      () => false,
      async () => new Set(),
    );
    registerFoundationCapabilities(bus, new CoreService(scoped), new OpsService(scoped));
    new MoneyService(new PGliteLedgerWriter(db)).register(bus);
    registerBrainCapabilities(bus, new BrainService(scoped));
    const launchToken = options.launchToken ?? randomBytes(32).toString('base64url');
    const app = createSidecarApp({
      port: options.port,
      launchToken,
      allowedOrigins: options.allowedOrigins,
      resolvePrincipal: async () => principal,
      bus,
      ...(options.nativeSyncToken === undefined ? {} : { nativeSyncToken: options.nativeSyncToken }),
      ...(options.acceptCloudSyncPush === undefined
        ? {}
        : { acceptCloudSyncPush: options.acceptCloudSyncPush }),
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
