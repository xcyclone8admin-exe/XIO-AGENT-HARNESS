import type { AnyCapability, ModuleManifest } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import type { CapabilityBus } from '../bus';

/** Module registration is explicit and side effect free until the sidecar starts. */
export interface ModuleServer {
  readonly id: string;
  register(bus: CapabilityBus, manifest: ModuleManifest): void;
  readonly capabilities?: readonly AnyCapability[];
}

/**
 * Module-owned server entry point may export a factory instead of a bare ModuleServer,
 * so the runtime can inject a LocalScopedStore at startup without module code importing
 * from apps/sidecar. The runtime resolves factories before registering capabilities.
 */
export type ModuleServerFactory = (store: LocalScopedStore) => ModuleServer;
export type ModuleServerEntry = ModuleServer | ModuleServerFactory;
export function isFactory(entry: ModuleServerEntry): entry is ModuleServerFactory {
  return typeof entry === 'function';
}
