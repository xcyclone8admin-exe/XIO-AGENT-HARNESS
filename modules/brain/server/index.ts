import type { AnyCapability } from '@xyra/contracts';
import { brainCapabilities } from '../contracts';

/** The current host registration interface does not yet supply a service context. */
const BrainServer = {
  id: 'brain',
  capabilities: Object.values(brainCapabilities) as AnyCapability[],
  register(): never {
    throw new Error('BRAIN_SERVICE_CONTEXT_REQUIRED');
  },
};

export { BrainService } from './brain-service';
export default BrainServer;
