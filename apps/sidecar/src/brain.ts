import brainManifest from '@xyra/mod-brain/manifest';
import { brainCapabilities } from '@xyra/mod-brain/contracts';
import type { BrainService } from '@xyra/mod-brain/server';
import type { CapabilityBus, CapabilityExecutionContext } from './bus';

const scopeOf = (context: CapabilityExecutionContext) => ({
  tenantId: context.tenantId,
  workspaceId: context.workspaceId,
});

function requireApproval(context: CapabilityExecutionContext) {
  const proof = context.approval;
  if (
    !proof || proof.tenantId !== context.tenantId || proof.workspaceId !== context.workspaceId ||
    proof.principalId !== context.principal.id || proof.capabilityId !== context.capabilityId
  ) throw new Error('VERIFIED_APPROVAL_REQUIRED');
  return proof;
}

/** Lead-owned host adapter: scope, actor, and approval evidence come only from CapabilityBus. */
export function registerBrainCapabilities(bus: CapabilityBus, service: BrainService): void {
  bus.register(brainManifest, brainCapabilities.ingest, (input, _call, context) =>
    service.ingest(scopeOf(context), context.actorId, input));
  bus.register(brainManifest, brainCapabilities.search, (input, _call, context) =>
    service.search(scopeOf(context), input));
  bus.register(brainManifest, brainCapabilities.memories, (input, _call, context) =>
    service.listMemories(scopeOf(context), input));
  bus.register(brainManifest, brainCapabilities.createClaim, (input, _call, context) =>
    service.createClaim(scopeOf(context), context.actorId, input));
  bus.register(brainManifest, brainCapabilities.createSignal, (input, _call, context) => {
    const parsed = brainCapabilities.createSignal.input.parse(input);
    return service.createSignal(scopeOf(context), context.actorId, parsed.sourceId,
      parsed.sourceVersionId, parsed.chunkId ?? null, parsed.signalType, parsed.payload)
      .then((signalId) => ({ signalId }));
  });
  bus.register(brainManifest, brainCapabilities.promoteClaim, (input, _call, context) => {
    const parsed = brainCapabilities.promoteClaim.input.parse(input);
    if (parsed.authorityType !== 'reviewer' || context.principal.kind !== 'user')
      throw new Error('REVIEWER_AUTHORITY_REQUIRED');
    return service.promoteClaim(scopeOf(context), context.actorId, parsed.claimId, {
      type: 'reviewer',
      reference: parsed.authorityReference,
      reason: parsed.reason,
      reviewerId: context.actorId,
      authorized: true,
    }, parsed.supersedesId);
  });
  bus.register(brainManifest, brainCapabilities.proposeProcedure, (input, _call, context) => {
    const parsed = brainCapabilities.proposeProcedure.input.parse(input);
    return service.proposeProcedure(scopeOf(context), context.actorId, {
      title: parsed.title,
      type: parsed.type,
      body: parsed.body,
      ...(parsed.successfulRunId === undefined ? {} : { successfulRunId: parsed.successfulRunId }),
    });
  });
  bus.register(brainManifest, brainCapabilities.reviewProcedure, (input, _call, context) => {
    const parsed = brainCapabilities.reviewProcedure.input.parse(input);
    if (context.principal.kind !== 'user') throw new Error('HUMAN_REVIEWER_REQUIRED');
    return service.reviewProcedure(scopeOf(context), context.actorId, parsed.procedureId, parsed.decision);
  });
  bus.register(brainManifest, brainCapabilities.procedures, (input, _call, context) =>
    service.listProcedures(scopeOf(context), input));
  bus.register(brainManifest, brainCapabilities.requestErasure, (input, _call, context) => {
    const approval = requireApproval(context);
    return service.requestSourceErasure(scopeOf(context), context.actorId, approval.approvalId, input);
  });
  bus.register(brainManifest, brainCapabilities.retryErasure, (input, _call, context) => {
    const approval = requireApproval(context);
    return service.retrySourceErasure(scopeOf(context), context.actorId, approval.approvalId, input);
  });
  bus.register(brainManifest, brainCapabilities.erasureStatus, (input, _call, context) =>
    service.sourceErasureStatus(scopeOf(context), input));
}
