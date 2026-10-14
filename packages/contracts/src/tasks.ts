import { z } from 'zod';
import { CapabilityKind, RiskClass } from './capability';

/** Public metadata only. Credentials are resolved by a native/server adapter. */
export const ModelConnection = z.strictObject({
  id: z.string().min(1).max(120), title: z.string().min(1).max(200),
  provider: z.string().min(1).max(100), model: z.string().min(1).max(200),
  locality: z.enum(['local', 'remote']), available: z.boolean(), detail: z.string().max(1000),
});
export type ModelConnection = z.infer<typeof ModelConnection>;
export const TaskState = z.enum([
  'queued', 'planning', 'waiting_approval', 'running', 'verifying',
  'paused', 'interrupted', 'completed', 'failed', 'cancelled',
]);
export const TaskAdmission = z.strictObject({
  chatId: z.uuid(), instruction: z.string().trim().min(1).max(20000),
  connectionId: z.string().min(1).max(120), requestId: z.uuid(),
});
export type TaskAdmission = z.infer<typeof TaskAdmission>;
export const TaskActionPreview = z.strictObject({
  id: z.uuid(), capabilityId: z.string().min(1), title: z.string(), input: z.unknown(),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/), revision: z.number().int().positive(),
  kind: CapabilityKind, risk: RiskClass,
  approvalRequirement: z.enum(['none', 'confirmation', 'independent']),
  /** A description of proposed effects, never a simulated result. */
  effects: z.string(),
  state: z.enum(['proposed', 'approved', 'running', 'succeeded', 'failed', 'invalidated']),
  result: z.unknown().optional(), error: z.string().optional(), approvalId: z.uuid().optional(),
});
export type TaskActionPreview = z.infer<typeof TaskActionPreview>;
export const TaskEvent = z.strictObject({
  sequence: z.number().int().positive(), revision: z.number().int().positive(),
  stage: z.string().min(1), detail: z.string().max(2000), occurredAt: z.iso.datetime({ offset: true }),
});
export const TaskSnapshot = z.strictObject({
  taskId: z.uuid(), chatId: z.uuid(), revision: z.number().int().positive(),
  connectionId: z.string(), instruction: z.string(), state: TaskState, summary: z.string(),
  actions: z.array(TaskActionPreview).max(8), events: z.array(TaskEvent),
  result: z.string().nullable(), error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;
export const TaskPlan = z.strictObject({
  summary: z.string().max(4000),
  actions: z.array(z.strictObject({ capabilityId: z.string().min(1), input: z.unknown() })).max(8),
});
export type TaskPlan = z.infer<typeof TaskPlan>;
/** Host-derived catalog. Model text cannot add tools or supply authority. */
export interface TaskTool {
  readonly id: string; readonly title: string; readonly description: string;
  readonly kind: 'read' | 'write' | 'consequential';
  readonly risk: 'low' | 'medium' | 'high' | 'critical'; readonly inputSchema: unknown;
}
export interface TaskModelRequest {
  readonly taskId: string; readonly revision: number; readonly tenantId: string;
  readonly workspaceId: string; readonly actorId: string; readonly instruction: string;
  readonly connectionId: string; readonly capabilities: readonly TaskTool[]; readonly signal: AbortSignal;
}
/** Server/native implementations only. No secret occurs in the public contract. */
export interface TaskModelPort {
  list(scope: { tenantId: string; workspaceId: string }): Promise<readonly ModelConnection[]>;
  test(scope: { tenantId: string; workspaceId: string }, connectionId: string): Promise<ModelConnection>;
  plan(request: TaskModelRequest): Promise<TaskPlan>;
}
export const TaskApproval = z.strictObject({
  taskId: z.uuid(), revision: z.number().int().positive(), actionId: z.uuid(),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/), approvalId: z.uuid().optional(),
});
export type TaskApproval = z.infer<typeof TaskApproval>;
export const TaskControl = z.strictObject({
  taskId: z.uuid(), revision: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'cancel', 'revise']),
  instruction: z.string().trim().min(1).max(20000).optional(),
});
export type TaskControl = z.infer<typeof TaskControl>;
