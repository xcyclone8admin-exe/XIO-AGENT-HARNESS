export * from './adapters';
export * from './compiler';
export * from './engine';
export * from './specs';
export * from './state-machine';
export * from './repository';

import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import type { ForgeRepository } from './repository';
import { forgeCapabilities } from '../contracts';
import { evaluateGates, planSchedule, rollbackPromotion } from './engine';
import { compileSpecCorpus } from './compiler';

export interface ForgeCall {
  readonly principal: Pick<Principal, 'id' | 'tenantId'>;
  readonly workspaceId: string;
  readonly capabilityId?: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}
export interface ForgeModuleServer { readonly id: string; readonly capabilities: readonly AnyCapability[]; register(bus: ForgeBus, manifest: ModuleManifest): void }
export interface ForgeBus { register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call?: ForgeCall) => Promise<unknown>): void }
const actor = (call?: ForgeCall) => {
  if (!call) throw new Error('FORGE_TRUSTED_CALL_CONTEXT_REQUIRED');
  return { id: call.principal.id, tenantId: call.principal.tenantId, workspaceId: call.workspaceId };
};
const requireRepository = (repository?: ForgeRepository) => {
  if (!repository) throw new Error('FORGE_REPOSITORY_NOT_CONFIGURED');
  return repository;
};

export function registerForge(bus: ForgeBus, manifest: ModuleManifest, repository: ForgeRepository) {
  ForgeRegistration.register(bus, manifest, repository);
}

const ForgeRegistration = {
  id: 'forge',
  capabilities: Object.values(forgeCapabilities),
  register(bus: ForgeBus, manifest: ModuleManifest, repository: ForgeRepository) {
    bus.register(manifest, forgeCapabilities.schedule, async (input, call) => {
      const request = forgeCapabilities.schedule.input.parse(input);
      const trusted = await requireRepository(repository).approvedPlanData(actor(call), request.approvalId);
      if (trusted.approval.epicId !== request.epicId || trusted.approval.workspaceId !== actor(call).workspaceId) throw new Error('FORGE_APPROVAL_SCOPE_MISMATCH');
      const plannerRequest = { ...request, approval: trusted.approval, tickets: trusted.tickets, reservedTicketIds: trusted.reservedTicketIds, activeResourceLocks: trusted.activeResourceLocks, killSwitchEngaged: false };
      const result = planSchedule(plannerRequest);
      return requireRepository(repository).persistSchedule(actor(call), plannerRequest, result);
    });
    bus.register(manifest, forgeCapabilities.gates, async (input, call) => {
      const request = forgeCapabilities.gates.input.parse(input);
      const result = evaluateGates(request.gates, []);
      return repository.recordGateEvaluation(actor(call), result);
    });
    bus.register(manifest, forgeCapabilities.promotion, async (input, call) => repository.requestPromotionRecord(actor(call), forgeCapabilities.promotion.input.parse(input)));
    bus.register(manifest, forgeCapabilities.evidence, async (input, call) => requireRepository(repository).createEvidence(actor(call), forgeCapabilities.evidence.input.parse(input)));
    bus.register(manifest, forgeCapabilities.finding, async (input, call) => requireRepository(repository).createFindingRecord(actor(call), forgeCapabilities.finding.input.parse(input)));
    bus.register(manifest, forgeCapabilities.discovery, async (input, call) => {
      const request = forgeCapabilities.discovery.input.parse(input);
      if (!repository) throw new Error('FORGE_REPOSITORY_NOT_CONFIGURED');
      return repository.recordDiscovery(actor(call), request);
    });
    bus.register(manifest, forgeCapabilities.rollback, async (input, call) => {
      const request = forgeCapabilities.rollback.input.parse(input);
      const promotion = rollbackPromotion(request.promotion, request.rollbackEvidence);
      return repository.recordPromotion(actor(call), promotion);
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
    bus.register(manifest, forgeCapabilities.archiveNode, (input, call) => requireRepository(repository).archiveNode(actor(call), forgeCapabilities.archiveNode.input.parse(input)));
    bus.register(manifest, forgeCapabilities.approvalRequest, (input, call) => requireRepository(repository).requestApproval(actor(call), forgeCapabilities.approvalRequest.input.parse(input)));
    bus.register(manifest, forgeCapabilities.approvals, (_input, call) => requireRepository(repository).approvals(actor(call)));
    bus.register(manifest, forgeCapabilities.approvalDecision, (input, call) => requireRepository(repository).decideApproval(actor(call), forgeCapabilities.approvalDecision.input.parse(input)));
    bus.register(manifest, forgeCapabilities.sources, (_input, call) => requireRepository(repository).sources(actor(call)));
    bus.register(manifest, forgeCapabilities.createSource, (input, call) => requireRepository(repository).createSource(actor(call), forgeCapabilities.createSource.input.parse(input)));
    bus.register(manifest, forgeCapabilities.ingestSource, (input, call) => requireRepository(repository).ingestSource(actor(call), forgeCapabilities.ingestSource.input.parse(input)));
    bus.register(manifest, forgeCapabilities.decideSource, (input, call) => requireRepository(repository).decideSource(actor(call), forgeCapabilities.decideSource.input.parse(input)));
    bus.register(manifest, forgeCapabilities.compileTicketContext, (input, call) => requireRepository(repository).compileTicketContext(actor(call), forgeCapabilities.compileTicketContext.input.parse(input)));
    bus.register(manifest, forgeCapabilities.schedules, (_input, call) => requireRepository(repository).schedules(actor(call)));
    bus.register(manifest, forgeCapabilities.runs, (_input, call) => requireRepository(repository).runs(actor(call)));
    bus.register(manifest, forgeCapabilities.cancelSchedule, (input, call) => {
      const request = forgeCapabilities.cancelSchedule.input.parse(input); return requireRepository(repository).cancelSchedule(actor(call), request.scheduleId, request.reason);
    });
    bus.register(manifest, forgeCapabilities.evidenceList, (_input, call) => requireRepository(repository).evidence(actor(call)));
    bus.register(manifest, forgeCapabilities.findings, (_input, call) => requireRepository(repository).findings(actor(call)));
    bus.register(manifest, forgeCapabilities.updateFinding, (input, call) => requireRepository(repository).transitionFindingRecord(actor(call), forgeCapabilities.updateFinding.input.parse(input)));
    bus.register(manifest, forgeCapabilities.gateMatrix, (input, call) => requireRepository(repository).gateMatrix(actor(call), forgeCapabilities.gateMatrix.input.parse(input)));
    bus.register(manifest, forgeCapabilities.riskAcceptances, (_input, call) => requireRepository(repository).riskAcceptances(actor(call)));
    bus.register(manifest, forgeCapabilities.requestRiskAcceptance, (input, call) => requireRepository(repository).requestRiskAcceptance(actor(call), forgeCapabilities.requestRiskAcceptance.input.parse(input)));
    bus.register(manifest, forgeCapabilities.decideRiskAcceptance, (input, call) => requireRepository(repository).decideRiskAcceptance(actor(call), forgeCapabilities.decideRiskAcceptance.input.parse(input)));
    bus.register(manifest, forgeCapabilities.promotionList, (_input, call) => requireRepository(repository).promotions(actor(call)));
    bus.register(manifest, forgeCapabilities.promotionApprovalList, (_input, call) => requireRepository(repository).promotionApprovalRequests(actor(call)));
    bus.register(manifest, forgeCapabilities.requestPromotionApproval, (input, call) => requireRepository(repository).requestPromotionApproval(actor(call), forgeCapabilities.requestPromotionApproval.input.parse(input)));
    bus.register(manifest, forgeCapabilities.decidePromotionApproval, (input, call) => requireRepository(repository).decidePromotionApproval(actor(call), forgeCapabilities.decidePromotionApproval.input.parse(input)));
    bus.register(manifest, forgeCapabilities.specs, (input, call) => { const request = forgeCapabilities.specs.input.parse(input); return requireRepository(repository).specs(actor(call), request.projectId); });
    bus.register(manifest, forgeCapabilities.specLifecycle, (input, call) => requireRepository(repository).transitionSpec(actor(call), forgeCapabilities.specLifecycle.input.parse(input)));
    bus.register(manifest, forgeCapabilities.saveSpecs, (input, call) => { const request = forgeCapabilities.saveSpecs.input.parse(input); return requireRepository(repository).saveSpecs(actor(call), request.projectId, request.documents); });
    bus.register(manifest, forgeCapabilities.compileSpecs, (input, call) => { const request = forgeCapabilities.compileSpecs.input.parse(input); const corpus = compileSpecCorpus(request); return requireRepository(repository).saveSpecs(actor(call), request.projectId, corpus.documents); });
    bus.register(manifest, forgeCapabilities.startCouncil, (input, call) => requireRepository(repository).startCouncil(actor(call), forgeCapabilities.startCouncil.input.parse(input)));
    bus.register(manifest, forgeCapabilities.assignCouncilReviewer, (input, call) => requireRepository(repository).assignCouncilReviewer(actor(call), forgeCapabilities.assignCouncilReviewer.input.parse(input)));
    bus.register(manifest, forgeCapabilities.councils, (_input, call) => requireRepository(repository).councils(actor(call)));
    bus.register(manifest, forgeCapabilities.submitCouncilDecision, (input, call) => requireRepository(repository).submitCouncilDecision(actor(call), forgeCapabilities.submitCouncilDecision.input.parse(input)));
    bus.register(manifest, forgeCapabilities.escalations, (_input, call) => requireRepository(repository).escalations(actor(call)));
    bus.register(manifest, forgeCapabilities.resolveEscalation, (input, call) => requireRepository(repository).resolveEscalation(actor(call), forgeCapabilities.resolveEscalation.input.parse(input)));
  },
};

export function createForgeServer(repository: ForgeRepository): ForgeModuleServer {
  return { id: ForgeRegistration.id, capabilities: ForgeRegistration.capabilities, register: (bus, manifest) => registerForge(bus, manifest, repository) };
}

const ForgeServer: ForgeModuleServer = {
  id: ForgeRegistration.id,
  capabilities: ForgeRegistration.capabilities,
  register: () => { throw new Error('FORGE_SCOPED_REPOSITORY_FACTORY_REQUIRED'); },
};

export default ForgeServer;
