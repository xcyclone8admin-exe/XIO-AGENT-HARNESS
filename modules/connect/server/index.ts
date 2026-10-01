export * from './repository';
export * from './mcp-boundary';

import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import { connectCapabilities } from '../contracts';
import { ConnectRepository, type ConnectActor } from './repository';

export interface ConnectCall {
  readonly principal: Pick<Principal, 'id' | 'tenantId'>;
  readonly workspaceId: string;
  readonly capabilityId?: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}
export interface ConnectBus {
  register(
    manifest: ModuleManifest,
    descriptor: AnyCapability,
    handler: (input: unknown, call?: ConnectCall) => Promise<unknown>,
  ): void;
}

function actor(call: ConnectCall | undefined): ConnectActor {
  if (!call) throw new Error('CONNECT_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function registerConnect(bus: ConnectBus, manifest: ModuleManifest, repository: ConnectRepository): void {
  bus.register(manifest, connectCapabilities.catalog, async (_input, call) => repository.listConnectors(actor(call)));
  bus.register(manifest, connectCapabilities.grant, async (input, call) => {
    const request = connectCapabilities.grant.input.parse(input);
    return repository.recordGrant(actor(call), request);
  });
}

export const connectModuleServer = {
  id: 'connect',
  capabilities: Object.values(connectCapabilities),
  register: registerConnect,
};
