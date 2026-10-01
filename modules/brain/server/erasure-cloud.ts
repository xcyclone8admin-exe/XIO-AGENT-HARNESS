import { z } from 'zod';

export const BRAIN_ERASURE_PROTOCOL = 'cloud-erasure-v2' as const;
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CloudSourceVersion = z.string().regex(/^cloud-ingest-v2:sha256:[0-9a-f]{64}$/);
export const CloudReferenceSetInput = z.strictObject({
  protocolVersion: z.literal('cloud-erasure-v2'), contentVersion: Hash, sourceId: z.uuid(), objectRefIds: z.array(z.uuid()).max(500),
});
export const CloudReferenceSetReceipt = z.strictObject({
  protocolVersion: z.literal('cloud-erasure-v2'), snapshotId: z.uuid(), sourceId: z.uuid(), contentVersion: Hash,
  sourceVersion: Hash, referenceStateVersion: z.string().min(1).max(200), objectRefIds: z.array(z.uuid()).max(500),
  snapshotDigest: Hash, status: z.enum(['verified_nonempty', 'verified_empty']),
});
const Source = z.strictObject({ kind: z.literal('brain_source'), id: z.uuid() });
const ObjectDisposition = z.enum(['delete_candidate', 'retained_shared', 'retained_hold', 'unavailable']);
export const CloudErasureStatus = z.enum([
  'eligible', 'retained_shared', 'retained_hold', 'hold_unknown', 'unavailable',
  'eligibility_expired', 'eligibility_invalidated', 'purge_claimed', 'local_purge_acknowledged',
  'delete_pending', 'completed', 'retryable_failure', 'terminal_failure', 'aborted',
]);
export type CloudErasureStatus = z.infer<typeof CloudErasureStatus>;

export const CloudErasureOperation = z.object({
  protocolVersion: z.enum(['cloud-erasure-v1', 'cloud-erasure-v2']),
  operationId: z.uuid(),
  erasureId: z.uuid(),
  attemptId: z.uuid(),
  attemptNo: z.number().int().positive(),
  requestDigest: Hash,
  source: Source,
  sourceVersion: CloudSourceVersion,
  status: CloudErasureStatus,
  eligibility: z.strictObject({
    reservationId: z.uuid(), referenceStateVersion: z.string().min(1).max(200),
    holdStateVersion: z.string().min(1).max(200), expiresAt: z.iso.datetime({ offset: true }),
  }).nullable(),
  claim: z.strictObject({ claimId: z.uuid(), claimGeneration: z.number().int().positive() }).nullable(),
  objects: z.array(z.strictObject({ opaqueRefId: z.string().min(1).max(200), disposition: ObjectDisposition })).max(500),
  auditReceiptId: z.uuid().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
}).passthrough();
export type CloudErasureOperation = z.infer<typeof CloudErasureOperation>;

export const BeginCloudErasure = z.strictObject({
  protocolVersion: z.literal(BRAIN_ERASURE_PROTOCOL), erasureId: z.uuid(), attemptId: z.uuid(), approvalId: z.uuid(),
  source: Source, sourceVersion: CloudSourceVersion,
});
export type BeginCloudErasure = z.infer<typeof BeginCloudErasure>;

export const ClaimCloudPurge = z.strictObject({
  protocolVersion: z.literal(BRAIN_ERASURE_PROTOCOL), attemptId: z.uuid(), reservationId: z.uuid(),
});
export const AckCloudLocalPurge = z.strictObject({
  protocolVersion: z.literal(BRAIN_ERASURE_PROTOCOL), attemptId: z.uuid(),
  localPurgeReceiptId: z.uuid(), localPurgeReceiptDigest: Hash, sourceVersion: CloudSourceVersion,
});
export const AbortCloudPurge = z.strictObject({
  protocolVersion: z.literal(BRAIN_ERASURE_PROTOCOL), attemptId: z.uuid(),
  abortReceiptId: z.uuid(), abortReceiptDigest: Hash, sourceVersion: CloudSourceVersion, claimId: z.uuid(), claimGeneration: z.number().int().positive(),
});

/** Host-injected product-authenticated client. It owns JWT/DPoP and verified approval context. */
export interface CloudErasureClient {
  begin(input: BeginCloudErasure): Promise<unknown>;
  get(operationId: string): Promise<unknown>;
  claimLocalPurge(operationId: string, input: z.infer<typeof ClaimCloudPurge>): Promise<unknown>;
  acknowledgeLocalPurge(operationId: string, input: z.infer<typeof AckCloudLocalPurge>): Promise<unknown>;
  abortLocalPurge(operationId: string, input: z.infer<typeof AbortCloudPurge>): Promise<unknown>;
}

/** Product-session/DPoP adapter for Cloud's trusted source-finalization endpoint. */
export interface CloudBrainSourceFinalizationClient {
  finalizeReferenceSet(input: z.infer<typeof CloudReferenceSetInput>): Promise<unknown>;
}

export function parseCloudErasureOperation(value: unknown): CloudErasureOperation {
  return CloudErasureOperation.parse(value);
}
