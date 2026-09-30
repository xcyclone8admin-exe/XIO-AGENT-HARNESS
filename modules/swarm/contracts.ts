import { AgentProfile, NightShiftLeash, RunBudget, type AgentRunResult } from '@xyra/agent-core';
import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

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
    description: 'Create a bounded agent profile with explicit grants and budgets',
    kind: 'write',
    permission: 'swarm:profile:write',
    input: AgentProfile,
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
} as const;

export type SwarmRunSummary = Pick<AgentRunResult, 'runId' | 'termination' | 'output' | 'counters'>;
