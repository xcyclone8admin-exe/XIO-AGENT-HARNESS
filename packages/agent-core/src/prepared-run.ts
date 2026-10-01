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
}

/** Capability-bus authority retained with the prepared input for the host queue/audit boundary. */
export interface PreparedRunAuthority {
  readonly principalId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly verifiedApproval: VerifiedApproval | null;
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
    const input = RunInput.parse({
      runId, workspaceId, principal, profile, prompt: context.prompt, spawn, route,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.leaseScope === undefined ? {} : { leaseScope: context.leaseScope }),
    }) as AgentRunInputType;
    return new PreparedAgentRun(input, {
      principalId: principal.id,
      tenantId: principal.tenantId,
      workspaceId,
      verifiedApproval: approval,
    });
  }
}

function withinBudget(spawn: SpawnContractType, profile: AgentProfileType): boolean {
  const requested = spawn.budgets; const allowed = profile.budgets;
  return requested.maxDurationMs <= allowed.maxDurationMs && requested.maxCostUsd <= allowed.maxCostUsd &&
    requested.maxActions <= allowed.maxActions && requested.maxFailures <= allowed.maxFailures &&
    requested.maxIterations <= allowed.maxIterations;
}
