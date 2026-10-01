export * from './profile-service';
export * from './runtime-service';

import type { AnyCapability } from '@xyra/contracts';
import { swarmCapabilities } from '../contracts';

/** The current host registration interface does not yet supply a service context. */
const SwarmServer = {
  id: 'swarm',
  capabilities: Object.values(swarmCapabilities) as AnyCapability[],
  register(): never {
    throw new Error('SWARM_SERVICE_CONTEXT_REQUIRED');
  },
};

export default SwarmServer;
