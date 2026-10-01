import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

export const UUID = z.uuid();

export const RunState = z.enum(['running', 'succeeded', 'failed', 'dead_letter', 'canceled']);
export type RunState = z.infer<typeof RunState>;

export const RunTrigger = z.enum(['manual', 'schedule']);
export type RunTrigger = z.infer<typeof RunTrigger>;

export const CheckpointStatus = z.enum(['succeeded', 'failed']);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

/** A single step in a workflow definition: a named reference to a step handler the host registers. */
export const WorkflowStep = z.object({
  id: z.string().min(1).max(200),
  handler: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowDefinition = z.object({
  id: UUID,
  name: z.string().min(1).max(200),
  steps: z.array(WorkflowStep).min(1).max(200),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  maxConcurrentRuns: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(true),
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const WorkflowCreate = z.object({
  name: z.string().min(1).max(200),
  steps: z.array(WorkflowStep).min(1).max(200),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  maxConcurrentRuns: z.number().int().min(1).max(100).default(1),
});
export type WorkflowCreate = z.infer<typeof WorkflowCreate>;

export const RunStatus = z.object({
  runId: UUID,
  workflowId: UUID,
  trigger: RunTrigger,
  state: RunState,
  stepIndex: z.number().int().min(0),
  attempt: z.number().int().min(0),
  detail: z.record(z.string(), z.unknown()),
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RunStatus = z.infer<typeof RunStatus>;

export const Checkpoint = z.object({
  id: UUID,
  runId: UUID,
  stepIndex: z.number().int().min(0),
  stepId: z.string(),
  status: CheckpointStatus,
  attempt: z.number().int().min(0),
  output: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const TriggerRunRequest = z.object({ workflowId: UUID, trigger: RunTrigger.default('manual') });
export const AdvanceRunRequest = z.object({ runId: UUID });
export const CancelRunRequest = z.object({ runId: UUID });

export const flowCapabilities = {
  listWorkflows: defineCapability({
    id: 'flow.workflow.list',
    title: 'List workflows',
    description: 'Return every workflow definition in the workspace.',
    kind: 'read',
    permission: 'flow:workflow:read',
    input: z.object({}),
    output: z.array(WorkflowDefinition),
  }),
  createWorkflow: defineCapability({
    id: 'flow.workflow.create',
    title: 'Create a workflow',
    description: 'Persist a new durable workflow definition.',
    kind: 'write',
    permission: 'flow:workflow:write',
    input: WorkflowCreate,
    output: WorkflowDefinition,
  }),
  trigger: defineCapability({
    id: 'flow.run.trigger',
    title: 'Trigger a workflow run',
    description: 'Start a new run of a workflow, bounded by its concurrency limit.',
    kind: 'consequential',
    permission: 'flow:run:trigger',
    input: TriggerRunRequest,
    output: RunStatus,
  }),
  advance: defineCapability({
    id: 'flow.run.advance',
    title: 'Advance a run by one step',
    description: 'Execute the next pending step of a run and persist its checkpoint. Re-invoking after a crash resumes from the last completed step.',
    kind: 'consequential',
    permission: 'flow:run:trigger',
    input: AdvanceRunRequest,
    output: RunStatus,
  }),
  cancel: defineCapability({
    id: 'flow.run.cancel',
    title: 'Cancel a run',
    description: 'Mark a running workflow run as canceled.',
    kind: 'consequential',
    permission: 'flow:run:cancel',
    input: CancelRunRequest,
    output: RunStatus,
  }),
  listRuns: defineCapability({
    id: 'flow.run.list',
    title: 'List runs for a workflow',
    description: 'Return the current status of every run of a workflow, most recent first.',
    kind: 'read',
    permission: 'flow:run:read',
    input: z.object({ workflowId: UUID }),
    output: z.array(RunStatus),
  }),
};
