import type { AnyCapability, ModuleManifest } from '@xyra/contracts';
import type { CapabilityBus } from '../bus';

/** Module registration is explicit and side effect free until the sidecar starts. */
export interface ModuleServer {
  readonly id: string;
  register(bus: CapabilityBus, manifest: ModuleManifest): void;
  readonly capabilities?: readonly AnyCapability[];
}
