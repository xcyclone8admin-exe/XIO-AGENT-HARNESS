import type { ModuleManifest } from './manifest';
import type { AnyCapability } from './capability';

/** Structural type for the capability bus that modules receive at registration time. */
export interface CapabilityBusLike {
  register(
    manifest: ModuleManifest,
    descriptor: AnyCapability,
    handler: (input: unknown, call: CapabilityCallContext) => Promise<unknown>,
  ): void;
}

/** Trusted call context injected by the runtime — tenantId, workspaceId and actor come from here. */
export interface CapabilityCallContext {
  readonly principal: { readonly id: string; readonly tenantId: string; readonly workspaces: readonly { id: string }[] };
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}

/**
 * Module-owned server entry point. Each module's server/index.ts exports a default value
 * implementing this interface. The sidecar runtime imports and calls register() at startup.
 * Modules must NOT import from apps/; derive tenant/workspace/actor from CapabilityCallContext.
 */
export interface ModuleServer {
  readonly id: string;
  register(bus: CapabilityBusLike, manifest: ModuleManifest): void;
  readonly capabilities?: readonly AnyCapability[];
}
