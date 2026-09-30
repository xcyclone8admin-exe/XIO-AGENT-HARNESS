import { AutonomyLevel, type Principal } from '@xyra/contracts';
import { z } from 'zod';

/** Stable built-in SWARM roles. Profiles remain data-driven and may define additional roles. */
export const BUILT_IN_AGENT_ROLES = [
  'CHIEF_OF_STAFF',
  'STRATEGIST',
  'OPERATIONS',
  'RESEARCHER',
  'ANALYST',
  'FINANCE',
  'INVESTMENT',
  'LEGAL',
  'COMPLIANCE',
  'GROWTH',
  'SALES',
  'MARKETING',
  'CONTENT',
  'ENGINEERING',
  'DESIGN',
  'REVIEWER',
  'ADVERSARY',
] as const;
export type BuiltInAgentRole = (typeof BUILT_IN_AGENT_ROLES)[number];

const NonNegativeFinite = z.number().finite().nonnegative();
const PositiveInt = z.number().int().positive();

export const RunBudget = z.object({
  maxDurationMs: PositiveInt,
  maxCostUsd: NonNegativeFinite,
  maxActions: PositiveInt,
  maxFailures: PositiveInt,
  maxIterations: PositiveInt,
});
export type RunBudget = z.infer<typeof RunBudget>;

export const NetworkPolicy = z.object({
  mode: z.enum(['none', 'allow-list']),
  allowedHosts: z.array(z.string().min(1)),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const FilesystemPolicy = z.object({
  mode: z.enum(['none', 'outbox-only', 'leased-worktree']),
  allowedPaths: z.array(z.string().min(1)),
});
export type FilesystemPolicy = z.infer<typeof FilesystemPolicy>;

export const EvalHistoryEntry = z.object({
  evalId: z.string().min(1),
  modelId: z.string().min(1),
  completedAt: z.iso.datetime({ offset: true }),
  score: z.number().finite().min(0).max(1),
  fallbackRate: z.number().finite().min(0).max(1),
});
export type EvalHistoryEntry = z.infer<typeof EvalHistoryEntry>;

/**
 * The XIO 16-field profile record. All fields are intentionally required: a profile cannot
 * silently inherit a secret, network, filesystem, budget, approval, or autonomy setting.
 */
export const AGENT_PROFILE_REQUIRED_FIELDS = [
  'id',
  'roleId',
  'charter',
  'defaultProvider',
  'defaultModel',
  'fallbacks',
  'capabilityGrants',
  'secretScopes',
  'networkPolicy',
  'filesystemPolicy',
  'budgets',
  'approvalPolicy',
  'memoryScope',
  'outputSchema',
  'autonomyLevel',
  'evalHistory',
] as const;

export const AgentProfile = z.object({
  id: z.uuid(),
  roleId: z.string().trim().min(1).max(100),
  charter: z.string().trim().min(1).max(100_000),
  defaultProvider: z.string().trim().min(1),
  defaultModel: z.string().trim().min(1),
  fallbacks: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })),
  capabilityGrants: z.array(z.string().min(1)),
  secretScopes: z.array(z.string().min(1)),
  networkPolicy: NetworkPolicy,
  filesystemPolicy: FilesystemPolicy,
  budgets: RunBudget,
  approvalPolicy: z.string().min(1),
  memoryScope: z.object({ tenant: z.boolean(), workspace: z.boolean(), project: z.boolean(), run: z.boolean() }),
  outputSchema: z.unknown(),
  autonomyLevel: AutonomyLevel,
  evalHistory: z.array(EvalHistoryEntry),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const MODEL_CAPABILITIES = [
  'text',
  'reasoning',
  'code',
  'tools',
  'structured-output',
  'embeddings',
  'vision',
  'audio',
] as const;
export const ModelCapability = z.enum(MODEL_CAPABILITIES);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const ModelDescriptor = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  capabilities: z.array(ModelCapability),
  contextWindow: PositiveInt,
  qualityTier: z.enum(['basic', 'standard', 'high']),
  latencyTier: z.enum(['fast', 'standard', 'slow']),
  costTier: z.enum(['low', 'medium', 'high']),
  privacyTier: z.enum(['local', 'contractual', 'external']),
  status: z.enum(['available', 'degraded', 'disabled']),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

export const ProviderUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: NonNegativeFinite,
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

export const AgentToolCall = z.object({
  id: z.string().min(1),
  capabilityId: z.string().min(1),
  input: z.unknown(),
});
export type AgentToolCall = z.infer<typeof AgentToolCall>;

export const ProviderResponse = z.object({
  output: z.string(),
  toolCalls: z.array(AgentToolCall),
  usage: ProviderUsage,
  finishReason: z.enum(['complete', 'tool_calls', 'length', 'refusal']),
});
export type ProviderResponse = z.infer<typeof ProviderResponse>;

export interface ProviderRequest {
  readonly runId: string;
  readonly model: ModelDescriptor;
  readonly prompt: string;
  readonly toolResults: readonly ToolResult[];
  readonly signal: AbortSignal;
}

export interface AiProvider {
  readonly id: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'CONTEXT_OVERFLOW',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface RouteRequest {
  readonly preferred: { readonly provider: string; readonly model: string };
  readonly fallbacks: readonly { readonly provider: string; readonly model: string }[];
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly qualityFloor: ModelDescriptor['qualityTier'];
  readonly privacyCeiling: ModelDescriptor['privacyTier'];
}

export interface ToolResult {
  readonly callId: string;
  readonly capabilityId: string;
  readonly status: 'ok' | 'denied' | 'failed' | 'canceled';
  readonly output?: unknown;
  readonly reason?: string;
}

export interface CapabilityCall {
  readonly principal: Principal;
  readonly capabilityId: string;
  readonly input: unknown;
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/** Tier-0 is the sole agent-core bridge into the Capability Bus. */
export interface CapabilityCaller {
  call(request: CapabilityCall): Promise<unknown>;
}

export const RunTermination = z.enum([
  'COMPLETED',
  'BUDGET_EXCEEDED',
  'TIMEOUT',
  'CANCELED',
  'KILL_SWITCH',
  'NO_PROGRESS',
  'CONCURRENCY_LIMIT',
  'FAILED',
  'DELEGATION_DENIED',
]);
export type RunTermination = z.infer<typeof RunTermination>;

export const RunCounters = z.object({
  iterations: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  costUsd: NonNegativeFinite,
});
export type RunCounters = z.infer<typeof RunCounters>;

export const SpawnContract = z.object({
  charter: z.string().min(1),
  stageProtocol: z.string().min(1),
  contextManifest: z.record(z.string(), z.unknown()),
  memoryScope: AgentProfile.shape.memoryScope,
  capabilityGrants: z.array(z.string()),
  approvals: z.array(z.string()),
  budgets: RunBudget,
  outputContract: z.unknown(),
  evidenceContract: z.object({ required: z.boolean(), artifactTypes: z.array(z.string()) }),
  delegation: z.object({ depth: z.number().int().nonnegative(), maxDepth: z.number().int().nonnegative() }),
});
export type SpawnContract = z.infer<typeof SpawnContract>;

export interface RunEvent {
  readonly type:
    | 'run.started'
    | 'run.model.called'
    | 'run.tool.called'
    | 'run.tool.denied'
    | 'run.retry'
    | 'run.provider.fallback'
    | 'run.canceled'
    | 'run.terminated';
  readonly runId: string;
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface AgentRunInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly principal: Principal;
  readonly profile: AgentProfile;
  readonly prompt: string;
  readonly spawn: SpawnContract;
  readonly route: RouteRequest;
  readonly signal?: AbortSignal;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly termination: RunTermination;
  readonly output: string | null;
  readonly counters: RunCounters;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly RunArtifact[];
}

export interface RunArtifact {
  readonly id: string;
  readonly type: 'agent.output' | 'agent.tool-result' | 'agent.evidence';
  readonly content: unknown;
}

export const NightShiftLeash = z.object({
  maxRuns: PositiveInt,
  maxSpendUsd: NonNegativeFinite,
  allowedCapabilityIds: z.array(z.string().min(1)),
  autonomyCeiling: AutonomyLevel,
});
export type NightShiftLeash = z.infer<typeof NightShiftLeash>;

export const NightShiftState = z.enum(['IDLE', 'RUNNING', 'MISSED', 'WAITING_FOR_LEASE', 'KILLED', 'COMPLETE']);
export type NightShiftState = z.infer<typeof NightShiftState>;

export const PromptVersion = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  purpose: z.string().min(1),
  template: z.string().min(1),
  requiredCapabilities: z.array(ModelCapability),
  outputContract: z.unknown(),
  retiredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PromptVersion = z.infer<typeof PromptVersion>;

export const EvalMetrics = z.object({
  taskCompletion: z.number().finite().min(0).max(1),
  toolSuccess: z.number().finite().min(0).max(1),
  schemaSuccess: z.number().finite().min(0).max(1),
  hallucinationRate: z.number().finite().min(0).max(1),
  fallbackRate: z.number().finite().min(0).max(1),
});
export type EvalMetrics = z.infer<typeof EvalMetrics>;

/** Logical credential metadata only; secret material remains in the platform secret broker. */
export const DelegatedCredential = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type DelegatedCredential = z.infer<typeof DelegatedCredential>;

export interface RuntimeConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly fallbacks: readonly { readonly provider: string; readonly model: string }[];
  readonly instructions: string;
}

export type RuntimeConfigurationOverride = Partial<RuntimeConfiguration>;

/** Reviewer payloads deliberately carry artifacts, never a builder's transcript or working context. */
export interface ReviewerAssignment {
  readonly authorRunId: string;
  readonly authorInstanceId: string;
  readonly reviewerInstanceId: string;
  readonly artifacts: readonly RunArtifact[];
}
