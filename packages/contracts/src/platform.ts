import { z } from 'zod';

/** Approval request (Protocol 06 §123–126): scope-hashed, expiring, single-use. */
export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']);
export const ApprovalRecord = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  capabilityId: z.string(),
  policy: z.string(),
  reason: z.string(),
  scopeHash: z.string().length(64),
  inputPreview: z.unknown(),
  requestedBy: z.object({
    kind: z.enum(['user', 'agent', 'system']),
    id: z.uuid(),
    runId: z.uuid().optional(),
  }),
  status: ApprovalStatus,
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

/** Append-only audit event (Protocol 05 §100–101; XIO-REQ-PLT-004). */
export const AuditEvent = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  actorKind: z.enum(['user', 'agent', 'system']),
  actorId: z.uuid(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  result: z.enum(['allowed', 'denied', 'approval_required', 'succeeded', 'failed']),
  approvalId: z.uuid().nullable(),
  traceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Kill switch (REQ-AIS-002). */
export const KillSwitchState = z.object({
  engaged: z.boolean(),
  scope: z.enum(['global', 'workspace']),
  reason: z.string().nullable(),
  changedBy: z.uuid().nullable(),
  changedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type KillSwitchState = z.infer<typeof KillSwitchState>;

export const SyncState = z.enum(['local-only', 'pending', 'synced', 'conflict', 'failed', 'offline']);
export type SyncState = z.infer<typeof SyncState>;
