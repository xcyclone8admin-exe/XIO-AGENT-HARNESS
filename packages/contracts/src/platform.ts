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

/**
 * Server-only proof emitted after durable approval, active approver membership, expiry, and
 * request-digest checks. This is a binding contract, not a transport signature. Never accept this
 * object from client or Worker request JSON; callers send only approvalId and each server
 * reconstructs this proof from trusted identity plus durable rows.
 */
export const VerifiedCapabilityApproval = z.strictObject({
  version: z.literal(1),
  approvalId: z.uuid(),
  decisionId: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  principalId: z.uuid(),
  requestedBy: z.uuid(),
  approverId: z.uuid(),
  capabilityId: z.string().min(1),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  scopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type VerifiedCapabilityApproval = z.infer<typeof VerifiedCapabilityApproval>;

export type ApprovalScopeBinding = Omit<VerifiedCapabilityApproval, 'scopeHash'>;

function canonicalApprovalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalApprovalJson(item)}`).join(',')}}`;
}

interface RuntimeDigestApi {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

const runtimeCrypto = (globalThis as unknown as { crypto: { subtle: RuntimeDigestApi } }).crypto;
const RuntimeTextEncoder = (globalThis as unknown as {
  TextEncoder: new () => { encode(value?: string): Uint8Array };
}).TextEncoder;

function digestHex(value: string): Promise<string> {
  return runtimeCrypto.subtle.digest('SHA-256', new RuntimeTextEncoder().encode(value)).then((bytes) =>
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

/** Canonical digest of validated capability input, shared by trusted local and Worker verifiers. */
export async function hashApprovalInput(input: unknown): Promise<string> {
  return digestHex(canonicalApprovalJson(input));
}

/** Stable, versioned approval binding shared by sidecar and Worker verifiers. */
export async function hashApprovalScope(binding: ApprovalScopeBinding): Promise<string> {
  const fields = [
    String(binding.version), binding.approvalId, binding.decisionId, binding.tenantId,
    binding.workspaceId, binding.principalId, binding.requestedBy, binding.approverId,
    binding.capabilityId, binding.inputDigest, binding.issuedAt, binding.expiresAt,
  ];
  return digestHex(fields.join('\n'));
}

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
