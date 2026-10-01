export * from './repository';
export * from './mcp-boundary';

import type { CapabilityBusLike, CapabilityCallContext, ModuleManifest, ModuleServer } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { connectCapabilities } from '../contracts';
import { ConnectRepository, type ConnectActor } from './repository';

function scope(call: CapabilityCallContext): ConnectActor {
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function registerConnect(repository: ConnectRepository, bus: CapabilityBusLike, manifest: ModuleManifest): void {
  const c = connectCapabilities;
  bus.register(manifest, c.catalog, async (_input, call) => repository.listConnectors(scope(call)));
  bus.register(manifest, c.grant, async (input, call) => repository.recordGrant(scope(call), c.grant.input.parse(input)));
}

export type ModuleServerFactory = (store: LocalScopedStore) => ModuleServer;

export function createConnectServer(store: LocalScopedStore): ModuleServer {
  const repository = new ConnectRepository(store);
  return {
    id: 'connect',
    capabilities: Object.values(connectCapabilities),
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      registerConnect(repository, bus, manifest);
    },
  };
}

export default createConnectServer;
