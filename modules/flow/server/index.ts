export * from './repository';
export * from './handlers';

import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import { flowCapabilities } from '../contracts';
import { FlowRepository, type FlowActor } from './repository';

export interface FlowCall {
  readonly principal: Pick<Principal, 'id' | 'tenantId'>;
  readonly workspaceId: string;
  readonly capabilityId?: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}
export interface FlowBus {
  register(
    manifest: ModuleManifest,
    descriptor: AnyCapability,
    handler: (input: unknown, call?: FlowCall) => Promise<unknown>,
  ): void;
}

function actor(call: FlowCall | undefined): FlowActor {
  if (!call) throw new Error('FLOW_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function registerFlow(bus: FlowBus, manifest: ModuleManifest, repository: FlowRepository): void {
  bus.register(manifest, flowCapabilities.listWorkflows, async (_input, call) => repository.listWorkflows(actor(call)));
  bus.register(manifest, flowCapabilities.createWorkflow, async (input, call) =>
    repository.createWorkflow(actor(call), flowCapabilities.createWorkflow.input.parse(input)),
  );
  bus.register(manifest, flowCapabilities.trigger, async (input, call) => {
    const request = flowCapabilities.trigger.input.parse(input);
    return repository.triggerRun(actor(call), request.workflowId, request.trigger);
  });
  bus.register(manifest, flowCapabilities.advance, async (input, call) => {
    const request = flowCapabilities.advance.input.parse(input);
    return repository.advanceRun(actor(call), request.runId);
  });
  bus.register(manifest, flowCapabilities.cancel, async (input, call) => {
    const request = flowCapabilities.cancel.input.parse(input);
    return repository.cancelRun(actor(call), request.runId);
  });
  bus.register(manifest, flowCapabilities.listRuns, async (input, call) => {
    const request = flowCapabilities.listRuns.input.parse(input);
    return repository.listRuns(actor(call), request.workflowId);
  });
}

export const flowModuleServer = {
  id: 'flow',
  capabilities: Object.values(flowCapabilities),
  register: registerFlow,
};
