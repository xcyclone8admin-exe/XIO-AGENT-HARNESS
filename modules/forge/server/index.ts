export * from './adapters';
export * from './compiler';
export * from './engine';
export * from './specs';
export * from './state-machine';

import type { AnyCapability, ModuleManifest } from '@xyra/contracts';
import { forgeCapabilities } from '../contracts';
import { classifyDiscovery, createEvidence, createFinding, evaluateGates, planSchedule, requestPromotion, rollbackPromotion } from './engine';

interface ForgeBus {
  register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown) => Promise<unknown>): void;
}

export function registerForge(bus: ForgeBus, manifest: ModuleManifest) {
  ForgeServer.register(bus, manifest);
}

const ForgeServer = {
  id: 'forge',
  capabilities: Object.values(forgeCapabilities),
  register(bus: ForgeBus, manifest: ModuleManifest) {
    bus.register(manifest, forgeCapabilities.schedule, async (input) => planSchedule(input));
    bus.register(manifest, forgeCapabilities.gates, async (input) => {
      const request = forgeCapabilities.gates.input.parse(input);
      return evaluateGates(request.gates, request.riskAcceptances);
    });
    bus.register(manifest, forgeCapabilities.promotion, async (input) => requestPromotion(input));
    bus.register(manifest, forgeCapabilities.evidence, async (input) => createEvidence(forgeCapabilities.evidence.input.parse(input)));
    bus.register(manifest, forgeCapabilities.finding, async (input) => createFinding(forgeCapabilities.finding.input.parse(input)));
    bus.register(manifest, forgeCapabilities.discovery, async (input) => {
      const request = forgeCapabilities.discovery.input.parse(input);
      return classifyDiscovery(request.ticket, request.summary, request.evidenceIds, request.affectedTicketIds);
    });
    bus.register(manifest, forgeCapabilities.rollback, async (input) => {
      const request = forgeCapabilities.rollback.input.parse(input);
      return rollbackPromotion(request.promotion, request.rollbackEvidence);
    });
  },
};

export default ForgeServer;
