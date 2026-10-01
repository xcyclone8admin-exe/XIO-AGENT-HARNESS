export * from './adapters';
export * from './compiler';
export * from './engine';
export * from './specs';
export * from './state-machine';

import type { AnyCapability, ModuleManifest } from '@xyra/contracts';
import { forgeCapabilities } from '../contracts';
import { evaluateGates, planSchedule, requestPromotion } from './engine';

interface ForgeBus {
  register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown) => Promise<unknown>): void;
}

const ForgeServer = {
  id: 'forge',
  capabilities: Object.values(forgeCapabilities),
  register(bus: ForgeBus, manifest: ModuleManifest) {
    bus.register(manifest, forgeCapabilities.schedule, async (input) => planSchedule(input));
    bus.register(manifest, forgeCapabilities.gates, async (input) => {
      const request = input as { gates: unknown[]; riskAcceptances: unknown[] };
      return evaluateGates(request.gates, request.riskAcceptances);
    });
    bus.register(manifest, forgeCapabilities.promotion, async (input) => requestPromotion(input));
  },
};

export default ForgeServer;
