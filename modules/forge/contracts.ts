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
export const ForgeProject = z.object({ id: UUID, workspaceId: UUID, name: z.string().min(1).max(200), description: z.string().max(20_000), status: EpicState, requirements: z.array(RequirementRef), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) });
export const ForgeProjectCreate = z.object({ name: z.string().min(1).max(200), description: z.string().max(20_000).default(''), requirements: z.array(RequirementRef).max(500).default([]) });
export const ForgeProjectUpdate = z.object({ projectId: UUID, name: z.string().min(1).max(200).optional(), description: z.string().max(20_000).optional(), requirements: z.array(RequirementRef).max(500).optional() }).refine((value) => Object.keys(value).some((key) => key !== 'projectId'), 'At least one project field is required');
export const HierarchyNode = z.object({
  id: UUID, tenantId: UUID, workspaceId: UUID, projectId: UUID,
  parentId: UUID.nullable(), kind: NodeKind, title: z.string().min(1).max(500),
  description: z.string().max(20_000), state: z.string().min(1),
  priority: ForgePriority, dependencies: z.array(UUID).max(500),
  requirements: z.array(RequirementRef).max(500), acceptanceCriteria: z.array(z.string().min(1).max(2000)).max(100), evidenceIds: z.array(UUID).max(500).default([]),
  ownerId: UUID.nullable(), createdBy: UUID, createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export type HierarchyNode = z.infer<typeof HierarchyNode>;
export const ForgeNodeCreate = HierarchyNode.omit({ id: true, tenantId: true, workspaceId: true, projectId: true, createdBy: true, createdAt: true, updatedAt: true });
export const ForgeNodeUpdate = z.object({ nodeId: UUID, title: z.string().min(1).max(500).optional(), description: z.string().max(20_000).optional(), state: z.string().min(1).optional(), priority: ForgePriority.optional(), dependencies: z.array(UUID).max(500).optional(), requirements: z.array(RequirementRef).max(500).optional(), acceptanceCriteria: z.array(z.string().min(1).max(2000)).max(100).optional(), ownerId: UUID.nullable().optional() }).refine((value) => Object.keys(value).some((key) => key !== 'nodeId'), 'At least one node field is required');

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
export type ContextElementType = z.infer<typeof ContextElementType>;
export const ContextCandidate = z.object({
  id: z.string().min(1).max(256), type: ContextElementType, text: z.string().min(1).max(100_000),
  source: z.string().min(1).max(500), authority: z.enum(['user', 'contract', 'architecture', 'system', 'reference']),
  status: z.string().min(1).max(64), dependencyIds: z.array(z.string().max(256)).max(100),
  relevance: z.number().min(0).max(1), estimatedTokens: z.number().int().positive(),
});
export const SourceRecord = z.object({ id: UUID, label: z.string().min(1).max(300), locator: z.string().min(1).max(1000), authority: z.enum(['user', 'contract', 'architecture', 'system', 'reference']), status: z.enum(['approved', 'draft', 'rejected']), sha256: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.iso.datetime({ offset: true }) });
export const SourceRecordCreate = SourceRecord.pick({ label: true, locator: true, sha256: true });
export const ContextManifest = z.object({ ticketId: UUID, budgetTokens: z.number().int().min(9).max(100_000), usedTokens: z.number().int().nonnegative(), items: z.array(ContextCandidate), omittedIds: z.array(z.string()), compiledAt: z.iso.datetime({ offset: true }) });

export const SchedulerConfig = z.object({ maxConcurrency: z.number().int().min(1).max(2), maxBudgetUsd: z.number().nonnegative(), resourceLocks: z.array(z.string().min(1)).max(100), substrateVerified: z.boolean(), externalAdaptersEnabled: z.boolean() }).superRefine((config, ctx) => {
  if (config.substrateVerified || config.externalAdaptersEnabled) ctx.addIssue({ code: 'custom', message: 'C1 keeps execution substrate and external adapters disabled' });
});
export const ApprovalRecord = z.object({ id: UUID, epicId: UUID, workspaceId: UUID, scopeHash: z.string().length(64), status: ApprovalStatus, approvedBy: UUID.nullable(), createdAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }) });
export const ApprovalRequestCreate = z.object({ epicId: UUID });
export const ApprovalDecisionCreate = z.object({ approvalId: UUID, decision: z.enum(['approved', 'rejected']), reason: z.string().min(1).max(4000) });
export const ScheduleRequest = z.object({ epicId: UUID, approval: ApprovalRecord, config: SchedulerConfig, tickets: z.array(HierarchyNode), spentUsd: z.number().nonnegative(), killSwitchEngaged: z.boolean() });
export const ScheduleCommand = z.object({ epicId: UUID, approvalId: UUID, config: SchedulerConfig, spentUsd: z.number().nonnegative() });
export const ScheduleResult = z.object({ runId: UUID, state: z.enum(['queued', 'stopped', 'blocked']), runnableTicketIds: z.array(UUID), blockedTicketIds: z.array(UUID), reason: z.string().nullable(), externalExecution: z.literal(false) });

export const Discovery = z.object({ id: UUID, workspaceId: UUID, ticketId: UUID, classification: z.enum(['informational', 'material', 'critical']), summary: z.string().min(1).max(4000), evidenceIds: z.array(UUID), affectedTicketIds: z.array(UUID), escalated: z.boolean(), createdAt: z.iso.datetime({ offset: true }) });
export const DiscoveryRequest = z.object({ ticketId: UUID, summary: z.string().min(1).max(4000), evidenceIds: z.array(UUID), affectedTicketIds: z.array(UUID) });
export const DiscoveryResult = z.object({ discovery: Discovery, blockedTicketIds: z.array(UUID) });
export const ClassifyDiscoveryRequest = z.object({ ticket: HierarchyNode, summary: z.string().min(1).max(4000), evidenceIds: z.array(UUID), affectedTicketIds: z.array(UUID) });
export const REVIEW_ROLES = ['architect', 'security', 'data', 'compliance', 'ai-safety', 'accessibility', 'performance', 'license-provenance', 'adversarial-user'] as const;
export const ReviewRole = z.enum(REVIEW_ROLES);
export const Finding = z.object({ id: UUID, workspaceId: UUID, role: ReviewRole, state: FindingState, severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), title: z.string().min(1).max(500), evidenceIds: z.array(UUID).min(1), affectedRequirements: z.array(z.string()), confidence: z.number().min(0).max(1), reproduction: z.string().min(1).max(8000), remediation: z.string().min(1).max(8000), revalidation: z.string().min(1).max(8000), createdAt: z.iso.datetime({ offset: true }) });
export type Finding = z.infer<typeof Finding>;
export const CreateFindingRequest = Finding.omit({ id: true, createdAt: true, workspaceId: true });
export const ChaosRequest = z.object({ target: z.enum(['sandbox', 'staging', 'develop', 'main', 'production']), authorizedTargets: z.array(z.enum(['sandbox', 'staging', 'develop', 'main', 'production'])) });
export const Evidence = z.object({ id: UUID, workspaceId: UUID, requirementId: z.string().min(1), kind: z.enum(['test', 'review', 'artifact', 'approval', 'migration', 'performance', 'security']), source: z.string().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/), verifiedAt: z.iso.datetime({ offset: true }), deterministic: z.boolean(), result: z.enum(['pass', 'fail', 'partial']) });
export const CreateEvidenceRequest = Evidence.omit({ id: true, workspaceId: true, verifiedAt: true, sha256: true }).extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), payload: z.unknown().optional(), ticketId: UUID.optional() });
export const Gate = z.object({ id: z.string(), requirementId: z.string(), kind: z.enum(['deterministic', 'human', 'ai-judgment']), evidenceIds: z.array(UUID), status: z.enum(['pass', 'fail', 'pending', 'blocked']), hard: z.boolean() });
export const RiskAcceptance = z.object({ gateId: z.string(), reason: z.string().min(1), impact: z.string().min(1), mitigation: z.string().min(1), reviewAt: z.iso.datetime({ offset: true }), approvedBy: UUID, approval: ApprovalRecord });
export const GateEvaluation = z.object({ gates: z.array(Gate), overall: z.enum(['pass', 'fail', 'blocked']), aiJudgmentAllowed: z.literal(false), deterministicBeforeJudgment: z.literal(true) });
export const Promotion = z.object({ id: UUID, workspaceId: UUID, commitSha: z.string().regex(/^[0-9a-f]{40,64}$/), from: z.enum(['develop', 'staging', 'main']), to: z.enum(['develop', 'staging', 'main']), state: PromotionState, evidenceIds: z.array(UUID), missingGateIds: z.array(z.string()), approvalId: UUID.nullable(), rollbackOf: UUID.nullable(), createdAt: z.iso.datetime({ offset: true }) });
export const RollbackPromotionRequest = z.object({ promotion: Promotion, rollbackEvidence: Evidence });
export const ForgeSchedule = z.object({ id: UUID, epicId: UUID, approvalId: UUID, state: z.enum(['queued', 'stopped', 'blocked', 'complete', 'failed', 'canceled']), maxConcurrency: z.number().int(), maxBudgetUsd: z.number(), spentUsd: z.number(), resourceLocks: z.array(z.string()), runnableTicketIds: z.array(UUID), blockedTicketIds: z.array(UUID), reason: z.string().nullable(), createdAt: z.iso.datetime({ offset: true }) });
export const ForgeRunEvent = z.object({ id: UUID, scheduleId: UUID, ticketId: UUID, state: z.enum(['queued', 'stopped', 'blocked', 'complete', 'failed', 'canceled']), externalExecution: z.literal(false), detail: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime({ offset: true }) });
export const CancelScheduleRequest = z.object({ scheduleId: UUID, reason: z.string().min(1).max(1000) });
export const GateRequirementInput = z.object({ requirementId: z.string().min(1).max(128), risk: z.enum(['low', 'medium', 'high', 'critical']), evidenceIds: z.array(UUID).max(100) });
export const GateMatrixRequest = z.object({ requirements: z.array(GateRequirementInput).min(1).max(500) });
export const GateMatrixResult = z.object({ gates: z.array(Gate), overall: z.enum(['pass', 'fail', 'blocked']), aiJudgmentAllowed: z.literal(false), deterministicBeforeJudgment: z.literal(true) });
export const FindingStateUpdate = z.object({ findingId: UUID, state: FindingState, detail: z.string().min(1).max(4000) });
export const AdapterConfig = z.object({ id: z.string().min(1), enabled: z.literal(false), endpoint: z.string().nullable(), lastStatus: z.enum(['disabled', 'unavailable']) });

export const forgeCapabilities = {
  schedule: defineCapability({ id: 'forge.schedule.plan', title: 'Plan bounded schedule', description: 'Persist an approved bounded schedule simulation; never starts host processes', kind: 'write', permission: 'forge:schedule:approve', input: ScheduleCommand, output: ScheduleResult }),
  gates: defineCapability({ id: 'forge.gates.evaluate', title: 'Evaluate evidence gates', description: 'Evaluate deterministic evidence before reviewer judgment', kind: 'read', permission: 'forge:gate:read', input: z.object({ gates: z.array(Gate), riskAcceptances: z.array(RiskAcceptance) }), output: GateEvaluation }),
  promotion: defineCapability({ id: 'forge.promotions.request', title: 'Request promotion', description: 'Record evidence-gated promotion intent without deploying or promoting refs', kind: 'consequential', permission: 'forge:promotion:request', approvalPolicy: 'forge.promotion', input: z.object({ promotion: Promotion, gates: z.array(Gate), productionApproval: ApprovalRecord.nullable() }), output: Promotion }),
  evidence: defineCapability({ id: 'forge.evidence.create', title: 'Create evidence record', description: 'Append a provenance hashed evidence record', kind: 'write', permission: 'forge:evidence:append', input: CreateEvidenceRequest, output: Evidence }),
  finding: defineCapability({ id: 'forge.findings.create', title: 'Create reviewer finding', description: 'Persist structured reviewer finding', kind: 'write', permission: 'forge:review:append', input: CreateFindingRequest, output: Finding }),
  discovery: defineCapability({ id: 'forge.discoveries.classify', title: 'Classify and escalate discovery', description: 'Persist classified discovery and block impacted dependency chain', kind: 'write', permission: 'forge:review:append', input: DiscoveryRequest, output: DiscoveryResult }),
  rollback: defineCapability({ id: 'forge.promotions.rollback-record', title: 'Record promotion rollback', description: 'Append a rollback record requiring passing evidence; performs no ref movement', kind: 'consequential', permission: 'forge:promotion:request', approvalPolicy: 'forge.promotion', input: RollbackPromotionRequest, output: Promotion }),
  projects: defineCapability({ id: 'forge.projects.list', title: 'List Forge projects', description: 'List projects in the authenticated workspace', kind: 'read', permission: 'forge:project:read', input: z.object({}), output: z.array(ForgeProject) }),
  createProject: defineCapability({ id: 'forge.projects.create', title: 'Create Forge project', description: 'Create a workspace project', kind: 'write', permission: 'forge:project:write', input: ForgeProjectCreate, output: ForgeProject }),
  updateProject: defineCapability({ id: 'forge.projects.update', title: 'Update Forge project', description: 'Update project metadata', kind: 'write', permission: 'forge:project:write', input: ForgeProjectUpdate, output: ForgeProject }),
  nodes: defineCapability({ id: 'forge.nodes.list', title: 'List project hierarchy', description: 'List hierarchy nodes in a project', kind: 'read', permission: 'forge:project:read', input: z.object({ projectId: UUID }), output: z.array(HierarchyNode) }),
  createNode: defineCapability({ id: 'forge.nodes.create', title: 'Create hierarchy node', description: 'Create a hierarchy node', kind: 'write', permission: 'forge:project:write', input: z.object({ projectId: UUID, node: ForgeNodeCreate }), output: HierarchyNode }),
  updateNode: defineCapability({ id: 'forge.nodes.update', title: 'Update hierarchy node', description: 'Update hierarchy metadata and state', kind: 'write', permission: 'forge:project:write', input: ForgeNodeUpdate, output: HierarchyNode }),
  approvalRequest: defineCapability({ id: 'forge.approvals.request', title: 'Request project approval', description: 'Append approval request for an epic scope', kind: 'write', permission: 'forge:plan:approve', input: ApprovalRequestCreate, output: ApprovalRecord }),
  approvals: defineCapability({ id: 'forge.approvals.list', title: 'List project approvals', description: 'List approvals in the authenticated workspace', kind: 'read', permission: 'forge:project:read', input: z.object({}), output: z.array(ApprovalRecord) }),
  approvalDecision: defineCapability({ id: 'forge.approvals.decide', title: 'Decide project approval', description: 'Append an approval decision', kind: 'write', permission: 'forge:promotion:approve', input: ApprovalDecisionCreate, output: ApprovalRecord }),
  sources: defineCapability({ id: 'forge.sources.list', title: 'List source provenance', description: 'List source provenance in the authenticated workspace', kind: 'read', permission: 'forge:project:read', input: z.object({}), output: z.array(SourceRecord) }),
  createSource: defineCapability({ id: 'forge.sources.create', title: 'Register source provenance', description: 'Append source provenance metadata', kind: 'write', permission: 'forge:project:write', input: SourceRecordCreate, output: SourceRecord }),
  schedules: defineCapability({ id: 'forge.schedules.list', title: 'List schedule simulations', description: 'List durable bounded scheduler plans', kind: 'read', permission: 'forge:run:read', input: z.object({}), output: z.array(ForgeSchedule) }),
  runs: defineCapability({ id: 'forge.runs.list', title: 'List simulated ticket runs', description: 'List immutable simulation events; no process executes', kind: 'read', permission: 'forge:run:read', input: z.object({}), output: z.array(ForgeRunEvent) }),
  cancelSchedule: defineCapability({ id: 'forge.schedules.cancel', title: 'Cancel queued schedule plan', description: 'Cancel a queued plan and append canceled ticket events without running processes', kind: 'write', permission: 'forge:run:cancel', input: CancelScheduleRequest, output: ForgeSchedule }),
  evidenceList: defineCapability({ id: 'forge.evidence.list', title: 'List evidence records', description: 'List immutable workspace evidence records', kind: 'read', permission: 'forge:gate:read', input: z.object({}), output: z.array(Evidence) }),
  findings: defineCapability({ id: 'forge.findings.list', title: 'List review findings', description: 'List workspace reviewer findings with current lifecycle state', kind: 'read', permission: 'forge:project:read', input: z.object({}), output: z.array(Finding) }),
  updateFinding: defineCapability({ id: 'forge.findings.transition', title: 'Transition reviewer finding', description: 'Append a legal finding lifecycle event', kind: 'write', permission: 'forge:review:append', input: FindingStateUpdate, output: Finding }),
  gateMatrix: defineCapability({ id: 'forge.gates.matrix', title: 'Build evidence gate matrix', description: 'Derive deterministic gates from requirement risk and stored evidence', kind: 'read', permission: 'forge:gate:read', input: GateMatrixRequest, output: GateMatrixResult }),
} as const;
