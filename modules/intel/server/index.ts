export * from './repository';
export * from './relevance';
export * from './change-detection';

import type { AnyCapability, CapabilityBusLike, ModuleManifest, ModuleServer } from '@xyra/contracts';
import { intelCapabilities } from '../contracts';
import type { IntelRepository } from './repository';
import { type IntelActor } from './repository';

export interface IntelCall {
  readonly principal: Pick<IntelActor, 'id' | 'tenantId'>;
  readonly workspaceId: string;
}

const actor = (call?: IntelCall): IntelActor => {
  if (!call) throw new Error('INTEL_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
};

export function registerIntel(bus: CapabilityBusLike, manifest: ModuleManifest, repository: IntelRepository): void {
  bus.register(manifest, intelCapabilities.watchlistCreate, (input, call) => repository.createWatchlist(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.watchlistList, (input, call) => repository.watchlists(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.sourceAdd, (input, call) => repository.addSource(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.sourceList, (input, call) => repository.sources(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.changeDetect, (input, call) => repository.detectChanges(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.changeEventsList, (input, call) => repository.changeEvents(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.briefGenerate, (input, call) => repository.generateBrief(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.briefList, (input, call) => repository.briefs(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.briefGet, (input, call) => repository.brief(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.relevanceScore, (input, call) => Promise.resolve(repository.scoreRelevance(actor(call as unknown as IntelCall), input)));
  bus.register(manifest, intelCapabilities.recommendationCreate, (input, call) => repository.createRecommendation(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.recommendationList, (input, call) => repository.recommendations(actor(call as unknown as IntelCall), input));
  bus.register(manifest, intelCapabilities.scheduleDescribe, (input, call) => repository.scheduleDescribe(actor(call as unknown as IntelCall), input));
}

export function createIntelServer(repository: IntelRepository): ModuleServer {
  return {
    id: 'intel',
    capabilities: Object.values(intelCapabilities) as readonly AnyCapability[],
    register: (bus, manifest) => registerIntel(bus, manifest, repository),
  };
}

const IntelServer: ModuleServer = {
  id: 'intel',
  capabilities: Object.values(intelCapabilities) as readonly AnyCapability[],
  register: () => { throw new Error('INTEL_SCOPED_REPOSITORY_FACTORY_REQUIRED'); },
};

export default IntelServer;
