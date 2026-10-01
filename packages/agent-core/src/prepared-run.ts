import { Principal as PrincipalSchema, VerifiedCapabilityApproval, type Principal as PrincipalType, type VerifiedCapabilityApproval as VerifiedApproval } from '@xyra/contracts';
import { z } from 'zod';
import { AgentProfile as AgentProfileSchema, SpawnContract as SpawnContractSchema, type AgentRunInput as AgentRunInputType, type AgentProfile as AgentProfileType, type RouteRequest, type SpawnContract as SpawnContractType } from './contracts';

const Route = z.object({
  preferred: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  fallbacks: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })),
  requiredCapabilities: z.array(z.enum(['text', 'reasoning', 'code', 'tools', 'structured-output', 'embeddings', 'vision', 'audio'])),
  qualityFloor: z.enum(['basic', 'standard', 'high']),
  privacyCeiling: z.enum(['local', 'contractual', 'external']),
});
const RunInput = z.object({
  runId: z.uuid(), workspaceId: z.uuid(), principal: PrincipalSchema, profile: AgentProfileSchema, prompt: z.string().min(1),
  spawn: SpawnContractSchema, route: Route, signal: z.custom<AbortSignal>().optional(),
  leaseScope: z.object({ jobId: z.string().min(1), window: z.string().min(1) }).optional(),
});

/** Immutable review subject resolved by the trusted host from a Forge council assignment. */
export const PreparedReviewBinding = z.strictObject({
  councilId: z.uuid(),
  assignmentId: z.uuid(),
  targetId: z.uuid(),
  repositoryId: z.string().trim().min(1).max(300),
  reviewContractId: z.string().trim().min(1).max(200),
  reviewContractSha256: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.string().trim().min(1).max(100),
  reviewerPrincipalId: z.uuid(),
  subjectCommitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  artifacts: z.array(z.strictObject({ id: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(100),
});
export type PreparedReviewBinding = z.infer<typeof PreparedReviewBinding>;

/** Public run intent covered by the CapabilityBus approval digest. */
export const AgentRunAdmissionRequest = z.strictObject({
  runId: z.uuid(),
  profileId: z.uuid(),
  prompt: z.string().trim().min(1).max(100_000),
  review: z.strictObject({ councilId: z.uuid(), assignmentId: z.uuid(), role: z.string().trim().min(1).max(100) }).optional(),
});
export type AgentRunAdmissionRequest = z.infer<typeof AgentRunAdmissionRequest>;

/** Inputs only a trusted host may resolve. Do not construct this from a WebView payload. */
export interface TrustedAgentRunPreparation {
  readonly runId: string;
  readonly workspaceId: string;
  readonly principal: PrincipalType;
  readonly verifiedApproval: VerifiedApproval | null;
  readonly profile: AgentProfileType;
  readonly prompt: string;
  readonly spawn: SpawnContractType;
  readonly route: RouteRequest;
  readonly signal?: AbortSignal;
  readonly leaseScope?: AgentRunInputType['leaseScope'];
  /** Resolved from the immutable server-side council assignment; never copied from public input. */
  readonly reviewBinding?: PreparedReviewBinding;
  /** Exact parsed bus input whose digest is bound by verifiedApproval. */
  readonly approvedInput?: AgentRunAdmissionRequest;
}

/** Capability-bus authority retained with the prepared input for the host queue/audit boundary. */
export interface PreparedRunAuthority {
  readonly principalId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly verifiedApproval: VerifiedApproval | null;
  readonly reviewBinding?: PreparedReviewBinding;
  readonly approvedInput?: AgentRunAdmissionRequest;
}

export class PreparedAgentRun {
  private constructor(
    readonly input: AgentRunInputType,
    readonly authority: PreparedRunAuthority,
  ) {}

  static fromTrustedHost(context: TrustedAgentRunPreparation): PreparedAgentRun {
    const runId = z.uuid().parse(context.runId);
    const workspaceId = z.uuid().parse(context.workspaceId);
    const principal = PrincipalSchema.parse(context.principal);
    if (!principal.workspaces.some((workspace) => workspace.id === workspaceId)) throw new Error('RUN_WORKSPACE_OUT_OF_SCOPE');
    if (typeof context.prompt !== 'string' || !context.prompt.trim()) throw new Error('RUN_PROMPT_REQUIRED');

    const profile = AgentProfileSchema.parse(context.profile);
    if (principal.kind === 'agent' && principal.runId !== undefined && principal.runId !== runId) throw new Error('RUN_PRINCIPAL_MISMATCH');
    if (principal.autonomy !== undefined && principal.autonomy > profile.autonomyLevel) throw new Error('RUN_AUTONOMY_ESCALATION');
    const spawn = SpawnContractSchema.parse(context.spawn);
    const route = Route.parse(context.route) as RouteRequest;
    if (spawn.charter !== profile.charter) throw new Error('RUN_SPAWN_CHARTER_MISMATCH');
    if (JSON.stringify(spawn.memoryScope) !== JSON.stringify(profile.memoryScope)) throw new Error('RUN_SPAWN_MEMORY_SCOPE_MISMATCH');
    if (!spawn.capabilityGrants.every((grant) => profile.capabilityGrants.includes(grant))) throw new Error('RUN_CAPABILITY_ESCALATION');
    if (!withinBudget(spawn, profile)) throw new Error('RUN_BUDGET_ESCALATION');
    if (spawn.delegation.depth > spawn.delegation.maxDepth) throw new Error('RUN_DELEGATION_DEPTH_INVALID');
    if (profile.networkPolicy.mode === 'none' && route.privacyCeiling !== 'local') throw new Error('RUN_NETWORK_POLICY_EXCEEDED');

    const approval = context.verifiedApproval === null ? null : VerifiedCapabilityApproval.parse(context.verifiedApproval);
    if (approval && (approval.tenantId !== principal.tenantId || approval.workspaceId !== workspaceId || approval.principalId !== principal.id)) {
      throw new Error('RUN_APPROVAL_SCOPE_MISMATCH');
    }
    const reviewBinding = context.reviewBinding === undefined ? undefined : PreparedReviewBinding.parse(context.reviewBinding);
    if (reviewBinding && reviewBinding.reviewerPrincipalId !== principal.id) throw new Error('REVIEW_REVIEWER_PRINCIPAL_MISMATCH');
    const approvedInput = context.approvedInput === undefined ? undefined : AgentRunAdmissionRequest.parse(context.approvedInput);
    if ((approval === null) !== (approvedInput === undefined)) throw new Error('RUN_APPROVAL_INPUT_REQUIRED');
    if (approvedInput && (
      approvedInput.runId !== runId || approvedInput.profileId !== profile.id || approvedInput.prompt !== context.prompt
    )) throw new Error('RUN_APPROVED_INPUT_MISMATCH');
    if (reviewBinding) {
      if (!approvedInput?.review || approvedInput.review.councilId !== reviewBinding.councilId ||
        approvedInput.review.assignmentId !== reviewBinding.assignmentId || approvedInput.review.role !== reviewBinding.role) {
        throw new Error('RUN_REVIEW_BINDING_MISMATCH');
      }
    } else if (approvedInput?.review) {
      throw new Error('RUN_REVIEW_BINDING_REQUIRED');
    }
    const input = RunInput.parse({
      runId, workspaceId, principal, profile, prompt: context.prompt, spawn, route,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.leaseScope === undefined ? {} : { leaseScope: context.leaseScope }),
    }) as AgentRunInputType;
    const authority: PreparedRunAuthority = {
      principalId: principal.id,
      tenantId: principal.tenantId,
      workspaceId,
      verifiedApproval: approval,
      ...(reviewBinding === undefined ? {} : { reviewBinding }),
      ...(approvedInput === undefined ? {} : { approvedInput }),
    };
    return new PreparedAgentRun(freezePlain(input), freezePlain(authority));
  }
}

function freezePlain<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezePlain(child);
  return Object.freeze(value);
}

function withinBudget(spawn: SpawnContractType, profile: AgentProfileType): boolean {
  const requested = spawn.budgets; const allowed = profile.budgets;
  return requested.maxDurationMs <= allowed.maxDurationMs && requested.maxCostUsd <= allowed.maxCostUsd &&
    requested.maxActions <= allowed.maxActions && requested.maxFailures <= allowed.maxFailures &&
    requested.maxIterations <= allowed.maxIterations;
}
