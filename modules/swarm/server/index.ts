import type { AnyCapability, CapabilityCallContext, CapabilityBusLike, ModuleManifest, ModuleServer } from '@xyra/contracts';
import type { VerifiedCapabilityApproval } from '@xyra/contracts';
import type { LocalScopedStore } from '@xyra/db';
import { swarmCapabilities } from '../contracts';
import { SwarmProfileService } from './profile-service';
import { SwarmKillSwitchService, SwarmRunQueueService, type SwarmRunQueueOptions, type SwarmTrustedCallContext } from './runtime-service';

/** Third argument supplied by CapabilityBus only after authentication and approval verification. */
export interface SwarmCapabilityExecutionContext {
  readonly principal: SwarmTrustedCallContext['principal'];
  readonly actorId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly permission: string;
  readonly approval: VerifiedCapabilityApproval | null;
}

/** Runtime extension: the sidecar bus invokes handlers with its verified execution context. */
export interface SwarmTrustedCapabilityBus extends CapabilityBusLike {
  register(
    manifest: ModuleManifest,
    descriptor: AnyCapability,
    handler: (input: unknown, call: CapabilityCallContext, context: SwarmCapabilityExecutionContext) => Promise<unknown>,
  ): void;
}

export const DEFAULT_SWARM_QUEUE_OPTIONS: SwarmRunQueueOptions = Object.freeze({
  maxPendingPerWorkspace: 100,
  maxQueuedPayloadBytes: 1_000_000,
  maxResultPayloadBytes: 1_000_000,
  maxRunDurationMs: 15 * 60_000,
});

export interface SwarmServerServices extends ModuleServer {
  readonly profileService: SwarmProfileService;
  readonly queueService: SwarmRunQueueService;
  readonly killSwitchService: SwarmKillSwitchService;
  readonly killSwitchReader: SwarmKillSwitchService;
}

/** Store-injected registrar. `enqueue` remains a trusted host API and is never a bus capability. */
export function makeSwarmServer(
  store: LocalScopedStore,
  queueOptions: SwarmRunQueueOptions = DEFAULT_SWARM_QUEUE_OPTIONS,
): SwarmServerServices {
  const profileService = new SwarmProfileService(store);
  const queueService = new SwarmRunQueueService(store, queueOptions);
  const killSwitchService = new SwarmKillSwitchService(store);
  return {
    id: 'swarm',
    capabilities: [swarmCapabilities.profiles, swarmCapabilities.createProfile, swarmCapabilities.queuedRuns,
      swarmCapabilities.cancelRun, swarmCapabilities.killSwitch, swarmCapabilities.setKillSwitch],
    profileService,
    queueService,
    killSwitchService,
    killSwitchReader: killSwitchService,
    register(bus: CapabilityBusLike, manifest: ModuleManifest): void {
      // CapabilityBusLike keeps an app-independent two-argument structural contract. The actual
      // sidecar CapabilityBus supplies the trusted third argument; fail closed when it is absent.
      const trustedBus = bus as SwarmTrustedCapabilityBus;
      const c = swarmCapabilities;
      trustedBus.register(manifest, c.profiles, (_input, call, context) => {
        requireContext(context, call, c.profiles.id);
        return profileService.list(scope(context));
      });
      trustedBus.register(manifest, c.createProfile, (input, call, context) => {
        requireContext(context, call, c.createProfile.id);
        return profileService.create(scope(context), context.actorId, input);
      });
      trustedBus.register(manifest, c.queuedRuns, (input, call, context) => {
        requireContext(context, call, c.queuedRuns.id);
        const parsed = c.queuedRuns.input.parse(input);
        return queueService.list(scope(context), parsed.limit);
      });
      trustedBus.register(manifest, c.cancelRun, (input, call, context) => {
        requireContext(context, call, c.cancelRun.id);
        const parsed = c.cancelRun.input.parse(input);
        return queueService.cancel(toTrustedCall(context), parsed.runId);
      });
      trustedBus.register(manifest, c.killSwitch, (_input, call, context) => {
        requireContext(context, call, c.killSwitch.id);
        return killSwitchService.getKillSwitch(scope(context));
      });
      trustedBus.register(manifest, c.setKillSwitch, (input, call, context) => {
        requireContext(context, call, c.setKillSwitch.id);
        const parsed = c.setKillSwitch.input.parse(input);
        return killSwitchService.setKillSwitch(toTrustedCall(context), parsed.engaged, parsed.reason);
      });
    },
  };
}

function scope(context: SwarmCapabilityExecutionContext) {
  return { tenantId: context.tenantId, workspaceId: context.workspaceId };
}

function toTrustedCall(context: SwarmCapabilityExecutionContext): SwarmTrustedCallContext {
  return {
    principal: context.principal,
    actorId: context.actorId,
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    capabilityId: context.capabilityId,
    permission: context.permission,
    approval: context.approval,
  };
}

function requireContext(context: SwarmCapabilityExecutionContext | undefined, call: CapabilityCallContext, capabilityId: string): asserts context is SwarmCapabilityExecutionContext {
  if (!context || context.capabilityId !== capabilityId || context.actorId !== call.principal.id ||
    context.tenantId !== context.principal.tenantId || context.workspaceId !== call.workspaceId ||
    !context.principal.workspaces.some((item) => item.id === context.workspaceId)) {
    throw new Error('SWARM_TRUSTED_EXECUTION_CONTEXT_REQUIRED');
  }
}

export { SwarmProfileService, SwarmKillSwitchService, SwarmRunQueueService };
export * from './profile-service';
export * from './runtime-service';
export default makeSwarmServer;
