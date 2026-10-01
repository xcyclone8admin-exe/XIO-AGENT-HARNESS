import type { AgentRunInput, AgentRunResult } from './contracts';
import { hashApprovalInput, hashApprovalScope } from '@xyra/contracts';
import type { CapabilityCaller } from './contracts';
import { BoundedRunLoop } from './loop';
import type { ModelRouter } from './router';
import { TierZeroToolExecutor } from './tier-zero';
import { PreparedAgentRun, type PreparedRunAuthority, type TrustedAgentRunPreparation } from './prepared-run';

export interface AgentRunnerOptions {
  readonly router: ModelRouter;
  readonly capabilities: ConstructorParameters<typeof TierZeroToolExecutor>[0];
  readonly capabilityCaller: CapabilityCaller;
  readonly loopOptions?: ConstructorParameters<typeof BoundedRunLoop>[2];
}

/** Result envelope used by trusted server adapters to persist output against prepared authority. */
export interface PreparedAgentRunResult {
  readonly runId: string;
  readonly authority: PreparedRunAuthority;
  /** SHA-256 of canonical JSON containing the output string; a digest, not a validated disposition. */
  readonly outputDigest: string;
  /** Canonical SHA-256 digest for each runtime-produced artifact; content remains in result.artifacts. */
  readonly artifactDigests: readonly { readonly id: string; readonly sha256: string }[];
  readonly result: AgentRunResult;
}

/** Trusted server-to-server handoff. Implementations must be idempotent on runId and recheck the assignment. */
export interface PreparedReviewResultSink {
  persist(result: PreparedAgentRunResult): Promise<{ readonly evidenceIds: readonly string[] }>;
}

/**
 * In-process bounded invocation seam for a host that already owns durable scheduling and auth.
 * It deliberately does not queue, persist jobs, or claim a run before the returned promise starts.
 */
export class AgentRunner {
  private readonly loop: BoundedRunLoop;
  private readonly active = new Set<string>();

  constructor(options: AgentRunnerOptions) {
    if (!options.router || !options.capabilityCaller || typeof options.capabilityCaller.call !== 'function') throw new Error('AGENT_RUNNER_HOST_DEPENDENCIES_REQUIRED');
    this.loop = new BoundedRunLoop(options.router, new TierZeroToolExecutor(options.capabilities, options.capabilityCaller), options.loopOptions);
  }

  prepare(input: TrustedAgentRunPreparation): PreparedAgentRun {
    return PreparedAgentRun.fromTrustedHost(input);
  }

  get activeRunIds(): readonly string[] { return [...this.active]; }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.active.has(input.runId)) throw new Error('RUN_ALREADY_ACTIVE');
    this.active.add(input.runId);
    try { return await this.loop.run(input); }
    finally { this.active.delete(input.runId); }
  }

  runPrepared(prepared: PreparedAgentRun): Promise<AgentRunResult> {
    if (!(prepared instanceof PreparedAgentRun)) throw new Error('TRUSTED_PREPARED_RUN_REQUIRED');
    return validatePreparedAuthority(prepared).then(() => this.run(prepared.input));
  }

  async runPreparedWithAuthority(prepared: PreparedAgentRun): Promise<PreparedAgentRunResult> {
    if (!(prepared instanceof PreparedAgentRun)) throw new Error('TRUSTED_PREPARED_RUN_REQUIRED');
    const result = await this.runPrepared(prepared);
    const artifactDigests = await Promise.all(result.artifacts.map(async (artifact) => ({ id: artifact.id, sha256: await hashApprovalInput(artifact.content) })));
    return { runId: prepared.input.runId, authority: prepared.authority, outputDigest: await hashApprovalInput(result.output), artifactDigests, result };
  }

  cancel(runId: string): boolean { return this.loop.cancel(runId); }
}

async function validatePreparedAuthority(prepared: PreparedAgentRun): Promise<void> {
  const { input, authority } = prepared;
  if (input.runId.length === 0 || input.workspaceId !== authority.workspaceId || input.principal.id !== authority.principalId || input.principal.tenantId !== authority.tenantId) {
    throw new Error('PREPARED_RUN_AUTHORITY_MISMATCH');
  }
  const approval = authority.verifiedApproval;
  if (!approval) {
    if (authority.approvedInput !== undefined) throw new Error('PREPARED_RUN_APPROVAL_MISSING');
    return;
  }
  if (!authority.approvedInput || Date.parse(approval.expiresAt) <= Date.now() ||
    approval.principalId !== authority.principalId || approval.tenantId !== authority.tenantId || approval.workspaceId !== authority.workspaceId ||
    approval.inputDigest !== await hashApprovalInput(authority.approvedInput)) throw new Error('PREPARED_RUN_APPROVAL_INVALID');
  const { scopeHash, ...binding } = approval;
  if (scopeHash !== await hashApprovalScope(binding)) throw new Error('PREPARED_RUN_APPROVAL_INVALID');
}
