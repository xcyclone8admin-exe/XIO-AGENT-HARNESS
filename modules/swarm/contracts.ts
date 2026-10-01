import { AgentProfile, AgentRunAdmissionRequest, NightShiftLeash, RunBudget, type AgentRunResult } from '@xyra/agent-core';
import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

/** Read-only port over the durable workspace agent kill switch; scope is always host-derived. */
export type KillSwitchScope = { readonly tenantId: string; readonly workspaceId: string };
export interface KillSwitchSnapshot {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string | null;
}
export interface KillSwitchReader {
  getKillSwitch(scope: KillSwitchScope): Promise<KillSwitchSnapshot>;
}

const Empty = z.object({});
const AgentRunSummary = z.object({
  runId: z.uuid(),
  termination: z.string(),
  output: z.string().nullable(),
  counters: z.object({
    iterations: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
const KillSwitchState = z.object({
  engaged: z.boolean(),
  reason: z.string().nullable(),
  changedBy: z.uuid().nullable(),
  changedAt: z.iso.datetime({ offset: true }).nullable(),
});
const QueueAdmission = z.object({
  accepted: z.boolean(),
  runId: z.uuid().nullable(),
  state: z.enum(['queued', 'claimed', 'running', 'completed', 'failed', 'canceled', 'refused']).nullable(),
  reason: z.string().nullable(),
});
const QueuedRun = z.object({
  runId: z.uuid(),
  profileId: z.uuid(),
  principalId: z.uuid(),
  state: z.enum(['queued', 'claimed', 'running', 'completed', 'failed', 'canceled', 'refused']),
  cancellationRequested: z.boolean(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

/**
 * Privilege-bearing and server-derived profile fields (manifest guardedColumns). Device and agent
 * writes never carry them: creates get fail-closed defaults and eval history derives from evals.
 */
export const GUARDED_PROFILE_FIELDS = [
  'capabilityGrants',
  'autonomyLevel',
  'secretScopes',
  'networkPolicy',
  'filesystemPolicy',
  'approvalPolicy',
  'evalHistory',
] as const;

/** The only profile fields a caller may write; unknown or guarded keys are rejected, not stripped. */
export const AgentProfileDraft = z.strictObject(
  AgentProfile.pick({
    roleId: true,
    charter: true,
    defaultProvider: true,
    defaultModel: true,
    fallbacks: true,
    budgets: true,
    memoryScope: true,
    outputSchema: true,
  }).shape,
);
export type AgentProfileDraft = z.infer<typeof AgentProfileDraft>;

/** Public contracts only. Runtime implementations stay in packages/agent-core. */
export const swarmCapabilities = {
  profiles: defineCapability({
    id: 'swarm.profiles.list',
    title: 'List agent profiles',
    description: 'List profiles visible in the current workspace',
    kind: 'read',
    permission: 'swarm:profile:read',
    input: Empty,
    output: z.array(AgentProfile),
  }),
  createProfile: defineCapability({
    id: 'swarm.profiles.create',
    title: 'Create agent profile',
    description: 'Create a bounded agent profile; privilege fields start fail-closed',
    kind: 'write',
    permission: 'swarm:profile:write',
    input: AgentProfileDraft,
    output: AgentProfile,
  }),
  runs: defineCapability({
    id: 'swarm.runs.list',
    title: 'List agent runs',
    description: 'List durable run summaries for the current workspace',
    kind: 'read',
    permission: 'swarm:run:read',
    input: Empty,
    output: z.array(AgentRunSummary),
  }),
  queuedRuns: defineCapability({
    id: 'swarm.runs.queue',
    title: 'List durable agent queue entries',
    description: 'List queued and terminal run admission records in the current workspace',
    kind: 'read',
    permission: 'swarm:run:read',
    input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    output: z.array(QueuedRun),
  }),
  enqueueRun: defineCapability({
    id: 'swarm.runs.enqueue',
    title: 'Queue an approved bounded agent run',
    description: 'Durably admit a host-prepared run after trusted profile, route and approval resolution',
    kind: 'consequential',
    permission: 'swarm:run:write',
    approvalPolicy: 'swarm.runs.enqueue',
    input: AgentRunAdmissionRequest,
    output: QueueAdmission,
  }),
  cancelRun: defineCapability({
    id: 'swarm.runs.cancel',
    title: 'Cancel agent run',
    description: 'Request cancellation of an active agent run',
    kind: 'write',
    permission: 'swarm:run:cancel',
    input: z.object({ runId: z.uuid() }),
    output: z.object({ accepted: z.boolean() }),
  }),
  configureNightShift: defineCapability({
    id: 'swarm.night-shift.configure',
    title: 'Configure Night Shift',
    description: 'Set the bounded autonomous execution leash',
    kind: 'consequential',
    permission: 'swarm:night-shift:configure',
    approvalPolicy: 'swarm.night-shift.configure',
    input: NightShiftLeash,
    output: NightShiftLeash,
  }),
  setRunBudget: defineCapability({
    id: 'swarm.runs.set-budget',
    title: 'Set run budget',
    description: 'Set explicit ceilings for a queued run',
    kind: 'write',
    permission: 'swarm:run:write',
    input: z.object({ runId: z.uuid(), budget: RunBudget }),
    output: z.object({ accepted: z.boolean() }),
  }),
  killSwitch: defineCapability({
    id: 'swarm.kill-switch.read',
    title: 'Read workspace agent kill switch',
    description: 'Read the server-owned kill-switch state for this workspace',
    kind: 'read',
    permission: 'swarm:kill-switch:read',
    input: Empty,
    output: KillSwitchState,
  }),
  setKillSwitch: defineCapability({
    id: 'swarm.kill-switch.set',
    title: 'Set workspace agent kill switch',
    description: 'Engage or release the durable workspace-wide agent kill switch',
    kind: 'consequential',
    permission: 'swarm:kill-switch:manage',
    approvalPolicy: 'swarm.kill-switch.set',
    input: z.strictObject({ engaged: z.boolean(), reason: z.string().trim().max(500).nullable() }),
    output: KillSwitchState,
  }),
} as const;

export type SwarmRunSummary = Pick<AgentRunResult, 'runId' | 'termination' | 'output' | 'counters'>;
