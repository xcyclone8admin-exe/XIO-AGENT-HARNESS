export * from './repository';
export * from './handlers';
export * from './dag';
export * from './missed-job';

import type { CapabilityBusLike, CapabilityCallContext, ModuleManifest, ModuleServer } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { flowCapabilities } from '../contracts';
import { FlowRepository, type FlowActor } from './repository';
import { StepHandlerRegistry } from './handlers';

function scope(call: CapabilityCallContext): FlowActor {
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
}

export function registerFlow(repository: FlowRepository, bus: CapabilityBusLike, manifest: ModuleManifest): void {
  const c = flowCapabilities;
  bus.register(manifest, c.listWorkflows, async (_input, call) => repository.listWorkflows(scope(call)));
  bus.register(manifest, c.createWorkflow, async (input, call) => repository.createWorkflow(scope(call), c.createWorkflow.input.parse(input)));
  bus.register(manifest, c.trigger, async (input, call) => {
    const request = c.trigger.input.parse(input);
    return repository.triggerRun(scope(call), request.workflowId, request.trigger);
  });
  bus.register(manifest, c.advance, async (input, call) => repository.advanceRun(scope(call), c.advance.input.parse(input).runId));
  bus.register(manifest, c.cancel, async (input, call) => repository.cancelRun(scope(call), c.cancel.input.parse(input).runId));
  bus.register(manifest, c.decideApproval, async (input, call) => {
    const request = c.decideApproval.input.parse(input);
    return repository.decideApproval(scope(call), request.runId, request.decision, request.reason);
  });
  bus.register(manifest, c.listRuns, async (input, call) => repository.listRuns(scope(call), c.listRuns.input.parse(input).workflowId));
}

export type ModuleServerFactory = (store: LocalScopedStore) => ModuleServer;

export function createFlowServer(store: LocalScopedStore): ModuleServer {
  const repository = new FlowRepository(store, new StepHandlerRegistry());
  return {
    id: 'flow',
    capabilities: Object.values(flowCapabilities),
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      registerFlow(repository, bus, manifest);
    },
  };
}

export default createFlowServer;
