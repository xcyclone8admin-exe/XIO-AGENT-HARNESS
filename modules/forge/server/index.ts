export * from './adapters';
export * from './compiler';
export * from './engine';
export * from './specs';
export * from './state-machine';
export * from './repository';

import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import type { ForgeRepository } from './repository';
import { forgeCapabilities } from '../contracts';
import { classifyDiscovery, createEvidence, createFinding, evaluateGates, planSchedule, requestPromotion, rollbackPromotion } from './engine';

interface ForgeBus {
  register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call?: ForgeCall) => Promise<unknown>): void;
}
export interface ForgeCall { readonly principal: Pick<Principal, 'id' | 'tenantId'>; readonly workspaceId: string }
const actor = (call?: ForgeCall) => {
  if (!call) throw new Error('FORGE_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
};
const requireRepository = (repository?: ForgeRepository) => {
  if (!repository) throw new Error('FORGE_REPOSITORY_NOT_CONFIGURED');
  return repository;
};

export function registerForge(bus: ForgeBus, manifest: ModuleManifest, repository?: ForgeRepository) {
  ForgeServer.register(bus, manifest, repository);
}

const ForgeServer = {
  id: 'forge',
  capabilities: Object.values(forgeCapabilities),
  register(bus: ForgeBus, manifest: ModuleManifest, repository?: ForgeRepository) {
    bus.register(manifest, forgeCapabilities.schedule, async (input, call) => {
      const request = forgeCapabilities.schedule.input.parse(input);
      const trusted = await requireRepository(repository).approvedPlanData(actor(call), request.approval.id);
      if (trusted.approval.epicId !== request.epicId || trusted.approval.workspaceId !== actor(call).workspaceId) throw new Error('FORGE_APPROVAL_SCOPE_MISMATCH');
      return planSchedule({ ...request, approval: trusted.approval, tickets: trusted.tickets });
    });
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
    bus.register(manifest, forgeCapabilities.projects, (_input, call) => requireRepository(repository).projects(actor(call)));
    bus.register(manifest, forgeCapabilities.createProject, (input, call) => requireRepository(repository).createProject(actor(call), forgeCapabilities.createProject.input.parse(input)));
    bus.register(manifest, forgeCapabilities.updateProject, (input, call) => requireRepository(repository).updateProject(actor(call), forgeCapabilities.updateProject.input.parse(input)));
    bus.register(manifest, forgeCapabilities.nodes, (input, call) => {
      const request = forgeCapabilities.nodes.input.parse(input); return requireRepository(repository).nodes(actor(call), request.projectId);
    });
    bus.register(manifest, forgeCapabilities.createNode, (input, call) => {
      const request = forgeCapabilities.createNode.input.parse(input); return requireRepository(repository).createNode(actor(call), request.projectId, request.node);
    });
    bus.register(manifest, forgeCapabilities.updateNode, (input, call) => requireRepository(repository).updateNode(actor(call), forgeCapabilities.updateNode.input.parse(input)));
    bus.register(manifest, forgeCapabilities.approvalRequest, (input, call) => requireRepository(repository).requestApproval(actor(call), forgeCapabilities.approvalRequest.input.parse(input)));
    bus.register(manifest, forgeCapabilities.approvals, (_input, call) => requireRepository(repository).approvals(actor(call)));
    bus.register(manifest, forgeCapabilities.approvalDecision, (input, call) => requireRepository(repository).decideApproval(actor(call), forgeCapabilities.approvalDecision.input.parse(input)));
    bus.register(manifest, forgeCapabilities.sources, (_input, call) => requireRepository(repository).sources(actor(call)));
    bus.register(manifest, forgeCapabilities.createSource, (input, call) => requireRepository(repository).createSource(actor(call), forgeCapabilities.createSource.input.parse(input)));
  },
};

export default ForgeServer;
