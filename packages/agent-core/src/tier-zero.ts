import type { AnyCapability, Principal } from '@xyra/contracts';
import type { AgentProfile, CapabilityCaller, ToolResult } from './contracts';
import { decideRunAccess } from './permissions';

export interface TierZeroContext {
  readonly principal: Principal;
  readonly profile: AgentProfile;
  readonly runId: string;
  readonly traceId: string;
  readonly signal: AbortSignal;
}

/**
 * Tier-0 intentionally permits only read capabilities. It calls the Capability Bus under the
 * supplied agent principal directly; it neither proxies a user principal nor owns an external tool.
 */
export class TierZeroToolExecutor {
  private readonly catalog = new Map<string, AnyCapability>();

  constructor(capabilities: readonly AnyCapability[], private readonly caller: CapabilityCaller) {
    for (const capability of capabilities) this.catalog.set(capability.id, capability);
  }

  async call(context: TierZeroContext, call: { readonly id: string; readonly capabilityId: string; readonly input: unknown }): Promise<ToolResult> {
    const capability = this.catalog.get(call.capabilityId);
    if (!capability) return denied(call, 'CAPABILITY_NOT_FOUND');
    const grant = decideRunAccess(context.profile, { dimension: 'capability', id: capability.id });
    if (!grant.allowed) return denied(call, grant.reason);
    if (!capability.agentCallable) return denied(call, 'CAPABILITY_NOT_AGENT_CALLABLE');
    if (capability.kind !== 'read') return denied(call, 'TIER_ZERO_READ_ONLY');
    if (context.signal.aborted) return { callId: call.id, capabilityId: call.capabilityId, status: 'canceled', reason: 'CANCELED' };
    try {
      const output = await this.caller.call({
        principal: context.principal,
        capabilityId: capability.id,
        input: call.input,
        traceId: context.traceId,
        idempotencyKey: `${context.runId}:${call.id}`,
        signal: context.signal,
      });
      return { callId: call.id, capabilityId: capability.id, status: 'ok', output };
    } catch (error) {
      return { callId: call.id, capabilityId: capability.id, status: 'failed', reason: error instanceof Error ? error.message : 'CAPABILITY_FAILED' };
    }
  }
}

function denied(call: { readonly id: string; readonly capabilityId: string }, reason: string): ToolResult {
  return { callId: call.id, capabilityId: call.capabilityId, status: 'denied', reason };
}
