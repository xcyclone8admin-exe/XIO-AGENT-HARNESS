import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { PGliteLedgerWriter } from '@xyra/ledger';
import { bootstrapLocalIdentity, CoreService } from '@xyra/mod-core/server';
import { MoneyService } from '@xyra/mod-money/server';
import { InvestService } from '@xyra/mod-invest/server/service';
import investManifest from '@xyra/mod-invest/manifest';
import { OpsService } from '@xyra/mod-ops/server';
import { BrainService } from '@xyra/mod-brain/server';
import makeCommandServer from '@xyra/mod-command/server';
import commandManifest from '@xyra/mod-command/manifest';
import makeCommsServer from '@xyra/mod-comms/server';
import commsManifest from '@xyra/mod-comms/manifest';
import makeGrowthServer from '@xyra/mod-growth/server';
import growthManifest from '@xyra/mod-growth/manifest';
import { createForgeServer, ForgeRepository, type ForgeBus } from '@xyra/mod-forge/server';
import forgeManifest from '@xyra/mod-forge/manifest';
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
  /** Optional override for the trusted native acknowledgement adapter, primarily for tests. */
  readonly acceptCloudSyncPush?: (
    scope: { readonly tenantId: string; readonly workspaceId: string },
    request: PushRequestValue,
    response: PushResponseValue,
  ) => Promise<void>;
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
    makeCommandServer(scoped).register(bus, commandManifest);
    makeCommsServer(scoped).register(bus, commsManifest);
    makeGrowthServer(scoped).register(bus, growthManifest);
    const ledgerWriter = new PGliteLedgerWriter(db);
    new MoneyService(ledgerWriter).register(bus);
    new InvestService(scoped, ledgerWriter, ledgerWriter).register(bus, investManifest);
    const brain = new BrainService(scoped);
    registerBrainCapabilities(bus, brain);
    const forgeRepository = new ForgeRepository(scoped);
    const forgeBus: ForgeBus = {
      register: (manifest, descriptor, handler) =>
        bus.register(manifest, descriptor, (input, call) => handler(input, call)),
    };
    createForgeServer(forgeRepository).register(forgeBus, forgeManifest);
    const launchToken = options.launchToken ?? randomBytes(32).toString('base64url');
    const app = createSidecarApp({
      port: options.port,
      launchToken,
      allowedOrigins: options.allowedOrigins,
      resolvePrincipal: async () => principal,
      bus,
      ...(options.nativeSyncToken === undefined ? {} : { nativeSyncToken: options.nativeSyncToken }),
      acceptCloudSyncPush: options.acceptCloudSyncPush ?? ((scope, request, response) =>
        brain.acceptCloudReferenceSync(scope, request, response).then(() => undefined)),
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
