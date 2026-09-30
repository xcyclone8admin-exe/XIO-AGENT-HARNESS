import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

export const UUID = z.uuid();
export const ForgePriority = z.enum(['critical', 'high', 'normal', 'low']);
export const NodeKind = z.enum(['epic', 'spec', 'plan', 'wave', 'ticket', 'subtask']);
export const EpicState = z.enum(['draft', 'proposed', 'approved', 'active', 'blocked', 'review', 'complete', 'canceled']);
export const TicketState = z.enum(['ready', 'queued', 'running', 'blocked', 'review', 'done', 'failed', 'canceled']);
export const FindingState = z.enum(['open', 'triaged', 'accepted', 'fixed', 'verified', 'waived']);
export const PromotionState = z.enum(['proposed', 'gates-passed', 'approved', 'promoted', 'rolled-back', 'rejected']);
export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const RequirementRef = z.object({ id: z.string().min(1).max(128), statement: z.string().min(1).max(4000) });
export const HierarchyNode = z.object({
  id: UUID, tenantId: UUID, workspaceId: UUID, projectId: UUID,
  parentId: UUID.nullable(), kind: NodeKind, title: z.string().min(1).max(500),
  description: z.string().max(20_000), state: z.string().min(1),
  priority: ForgePriority, dependencies: z.array(UUID).max(500),
  requirements: z.array(RequirementRef).max(500), acceptanceCriteria: z.array(z.string().min(1).max(2000)).max(100),
  ownerId: UUID.nullable(), createdBy: UUID, createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export type HierarchyNode = z.infer<typeof HierarchyNode>;

export const SpecDocument = z.object({
  id: z.string().regex(/^spec_[a-z0-9][a-z0-9-]{2,120}$/), template: z.string().min(1),
  version: z.literal(1), title: z.string().min(1).max(300), status: z.enum(['draft', 'approved', 'superseded']),
  authority: z.enum(['user', 'contract', 'architecture', 'system']), dependencies: z.array(z.string()),
  supersedes: z.array(z.string()), requirementIds: z.array(z.string()), frontmatter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  body: z.string().min(1).max(100_000), contentHash: z.string().length(64),
});
export type SpecDocument = z.infer<typeof SpecDocument>;

export const SPEC_TEMPLATES = [
  'product-brief', 'requirements', 'architecture', 'data-model', 'api-contract', 'security-threat-model',
  'ux-flow', 'implementation-plan', 'test-plan', 'risk-register', 'release-plan', 'decision-record',
] as const;
export type SpecTemplate = (typeof SPEC_TEMPLATES)[number];

export const ContextElementType = z.enum(['objective', 'requirement', 'architecture', 'decision', 'dependency', 'source', 'constraint', 'acceptance', 'prior-evidence']);
export const ContextCandidate = z.object({
  id: z.string().min(1).max(256), type: ContextElementType, text: z.string().min(1).max(100_000),
  source: z.string().min(1).max(500), authority: z.enum(['user', 'contract', 'architecture', 'system', 'reference']),
  status: z.string().min(1).max(64), dependencyIds: z.array(z.string().max(256)).max(100),
  relevance: z.number().min(0).max(1), estimatedTokens: z.number().int().positive(),
});
export const ContextManifest = z.object({ ticketId: UUID, budgetTokens: z.number().int().min(9).max(100_000), usedTokens: z.number().int().nonnegative(), items: z.array(ContextCandidate), omittedIds: z.array(z.string()), compiledAt: z.iso.datetime({ offset: true }) });

export const SchedulerConfig = z.object({ maxConcurrency: z.number().int().min(1).max(2), maxBudgetUsd: z.number().nonnegative(), resourceLocks: z.array(z.string().min(1)).max(100), substrateVerified: z.boolean(), externalAdaptersEnabled: z.boolean() }).superRefine((config, ctx) => {
  if (config.substrateVerified || config.externalAdaptersEnabled) ctx.addIssue({ code: 'custom', message: 'C1 keeps execution substrate and external adapters disabled' });
});
export const ApprovalRecord = z.object({ id: UUID, epicId: UUID, workspaceId: UUID, scopeHash: z.string().length(64), status: ApprovalStatus, approvedBy: UUID.nullable(), createdAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }) });
export const ScheduleRequest = z.object({ epicId: UUID, approval: ApprovalRecord, config: SchedulerConfig, tickets: z.array(HierarchyNode), spentUsd: z.number().nonnegative(), killSwitchEngaged: z.boolean() });
export const ScheduleResult = z.object({ runId: UUID, state: z.enum(['queued', 'stopped', 'blocked']), runnableTicketIds: z.array(UUID), blockedTicketIds: z.array(UUID), reason: z.string().nullable(), externalExecution: z.literal(false) });

export const Discovery = z.object({ id: UUID, workspaceId: UUID, ticketId: UUID, classification: z.enum(['informational', 'material', 'critical']), summary: z.string().min(1).max(4000), evidenceIds: z.array(UUID), affectedTicketIds: z.array(UUID), escalated: z.boolean(), createdAt: z.iso.datetime({ offset: true }) });
export const REVIEW_ROLES = ['architect', 'security', 'data', 'compliance', 'ai-safety', 'accessibility', 'performance', 'license-provenance', 'adversarial-user'] as const;
export const ReviewRole = z.enum(REVIEW_ROLES);
export const Finding = z.object({ id: UUID, workspaceId: UUID, role: ReviewRole, state: FindingState, severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), title: z.string().min(1).max(500), evidenceIds: z.array(UUID).min(1), affectedRequirements: z.array(z.string()), confidence: z.number().min(0).max(1), reproduction: z.string().min(1).max(8000), remediation: z.string().min(1).max(8000), revalidation: z.string().min(1).max(8000), createdAt: z.iso.datetime({ offset: true }) });
export const ChaosRequest = z.object({ target: z.enum(['sandbox', 'staging', 'develop', 'main', 'production']), authorizedTargets: z.array(z.enum(['sandbox', 'staging', 'develop', 'main', 'production'])) });
export const Evidence = z.object({ id: UUID, workspaceId: UUID, requirementId: z.string().min(1), kind: z.enum(['test', 'review', 'artifact', 'approval', 'migration', 'performance', 'security']), source: z.string().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/), verifiedAt: z.iso.datetime({ offset: true }), deterministic: z.boolean(), result: z.enum(['pass', 'fail', 'partial']) });
export const Gate = z.object({ id: z.string(), requirementId: z.string(), kind: z.enum(['deterministic', 'human', 'ai-judgment']), evidenceIds: z.array(UUID), status: z.enum(['pass', 'fail', 'pending', 'blocked']), hard: z.boolean() });
export const RiskAcceptance = z.object({ gateId: z.string(), reason: z.string().min(1), impact: z.string().min(1), mitigation: z.string().min(1), reviewAt: z.iso.datetime({ offset: true }), approvedBy: UUID, approval: ApprovalRecord });
export const GateEvaluation = z.object({ gates: z.array(Gate), overall: z.enum(['pass', 'fail', 'blocked']), aiJudgmentAllowed: z.literal(false), deterministicBeforeJudgment: z.literal(true) });
export const Promotion = z.object({ id: UUID, workspaceId: UUID, commitSha: z.string().regex(/^[0-9a-f]{40,64}$/), from: z.enum(['develop', 'staging', 'main']), to: z.enum(['develop', 'staging', 'main']), state: PromotionState, evidenceIds: z.array(UUID), missingGateIds: z.array(z.string()), approvalId: UUID.nullable(), rollbackOf: UUID.nullable(), createdAt: z.iso.datetime({ offset: true }) });
export const AdapterConfig = z.object({ id: z.string().min(1), enabled: z.literal(false), endpoint: z.string().nullable(), lastStatus: z.enum(['disabled', 'unavailable']) });

export const forgeCapabilities = {
  hierarchy: defineCapability({ id: 'forge.hierarchy.list', title: 'List project hierarchy', description: 'List hierarchy items for current workspace', kind: 'read', permission: 'forge:project:read', input: z.object({ projectId: UUID }), output: z.array(HierarchyNode) }),
  schedule: defineCapability({ id: 'forge.schedule.plan', title: 'Plan bounded schedule', description: 'Compute a read-only runnable ticket plan; never starts host processes', kind: 'write', permission: 'forge:schedule:approve', input: ScheduleRequest, output: ScheduleResult }),
  gates: defineCapability({ id: 'forge.gates.evaluate', title: 'Evaluate evidence gates', description: 'Evaluate deterministic evidence before reviewer judgment', kind: 'read', permission: 'forge:gate:read', input: z.object({ gates: z.array(Gate), riskAcceptances: z.array(RiskAcceptance) }), output: GateEvaluation }),
  promotion: defineCapability({ id: 'forge.promotions.request', title: 'Request promotion', description: 'Record evidence-gated promotion intent without deploying or promoting refs', kind: 'consequential', permission: 'forge:promotion:request', approvalPolicy: 'forge.promotion', input: z.object({ promotion: Promotion, gates: z.array(Gate), productionApproval: ApprovalRecord.nullable() }), output: Promotion }),
} as const;
