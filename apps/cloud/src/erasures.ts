import { z } from 'zod';
import {
  canonicalCloudIngestionJson,
  cloudBrainSourceVersion,
  cloudReferenceSetDigest,
  CloudBlobReferenceIssueRequest as SharedBlobReferenceIssueRequest,
  CloudBlobReferenceIssueResult as SharedBlobReferenceIssueResult,
  CloudBrainIngestionBeginRequest as SharedIngestionBeginRequest,
  CloudBrainIngestionBeginResult as SharedIngestionBeginResult,
  CloudBrainIngestionFinalizeRequest as SharedIngestionFinalizeRequest,
  CloudBrainIngestionFinalizationReceipt as SharedIngestionFinalizationReceipt,
  CloudBrainIngestionStatus as SharedIngestionStatus,
  hashApprovalInput,
  hashApprovalScope,
  VerifiedCapabilityApproval,
  type VerifiedCapabilityApproval as VerifiedCapabilityApprovalType,
} from '@xyra/contracts';
import type { NeonQueryClient } from './neon';
import type { CandidateClaims } from './model';

export const ERASURE_PROTOCOL_VERSION = 'cloud-erasure-v1' as const;

export const ErasureSource = z.object({
  kind: z.literal('brain_source'),
  id: z.uuid(),
});

export const BeginErasureRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  erasureId: z.uuid(),
  attemptId: z.uuid(),
  approvalId: z.uuid(),
  source: ErasureSource,
  sourceVersion: z.string().regex(/^cloud-ingest-v2:sha256:[0-9a-f]{64}$/),
}).strict();

export const ClaimLocalPurgeRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  reservationId: z.uuid(),
}).strict();

export const LocalPurgeAckRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  claimId: z.uuid(),
  claimGeneration: z.number().int().positive(),
  localPurgeReceiptId: z.uuid(),
  localPurgeReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sourceVersion: z.string().regex(/^cloud-ingest-v2:sha256:[0-9a-f]{64}$/),
}).strict();

export const AbortErasureRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  claimId: z.uuid(),
  abortReceiptId: z.uuid(),
  abortReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const CloudIngestionStartRequest = SharedIngestionBeginRequest.transform((request) => ({
  ...request, sourceId: request.sourceId.toLowerCase(),
}));
export const CloudIngestionBeginResult = SharedIngestionBeginResult;
export const CloudIngestionFinalizeRequest = SharedIngestionFinalizeRequest.transform((request) => ({
  ...request, sourceVersionId: request.sourceVersionId.toLowerCase(),
}));
export const CloudIngestionFinalizationReceipt = SharedIngestionFinalizationReceipt;
export const CloudIngestionStatus = SharedIngestionStatus;
export const CloudBlobReferenceIssueRequest = SharedBlobReferenceIssueRequest;
export const CloudBlobReferenceIssueResult = SharedBlobReferenceIssueResult;

export type ErasureStatus =
  | 'eligible'
  | 'retained_shared'
  | 'retained_hold'
  | 'hold_unknown'
  | 'unavailable'
  | 'eligibility_expired'
  | 'eligibility_invalidated'
  | 'purge_claimed'
  | 'local_purge_acknowledged'
  | 'delete_pending'
  | 'completed'
  | 'aborted'
  | 'retryable_failure'
  | 'terminal_failure';

export interface SourceVersionEntry {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface SourceVersionSnapshot {
  readonly sourceId: string;
  readonly versions: readonly SourceVersionEntry[];
}

/** BRAIN's agreed opaque precondition encoding; caller values never replace the server snapshot. */
export async function sourceVersionDigest(snapshot: SourceVersionSnapshot): Promise<string> {
  const versions = [...snapshot.versions]
    .sort((left, right) => left.version - right.version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(({ id, version, contentHash }) => ({ id, version, contentHash }));
  const body = canonicalCloudIngestionJson({ sourceId: snapshot.sourceId, versions });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function blobReferenceSnapshotDigest(sourceId: string, sourceVersionId: string, objectRefIds: readonly string[]): Promise<string> {
  const normalized = objectRefIds.map((id) => id.toLowerCase());
  const ids = [...new Set(normalized)].sort();
  if (ids.length !== objectRefIds.length) throw new Error('DUPLICATE_OBJECT_REFERENCE');
  if (normalized.some((id, index) => id !== objectRefIds[index])) throw new Error('NON_CANONICAL_OBJECT_REFERENCE');
  return cloudReferenceSetDigest({ sourceId, sourceVersionId, objectRefIds: ids });
}

/** v2 destructive precondition: synced content/version, normalized refs, and Cloud's state fence. */
export async function erasureSourceSnapshotVersion(
  input: {
    readonly sourceId: string;
    readonly sourceVersionId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly contentDigest: string;
    readonly objectRefIds: readonly string[];
    readonly referenceStateVersion: number;
  },
): Promise<string> {
  if (!Number.isSafeInteger(input.referenceStateVersion) || input.referenceStateVersion < 1)
    throw new Error('INVALID_REFERENCE_STATE_VERSION');
  if (!/^[0-9a-f]{64}$/.test(input.contentDigest)) throw new Error('INVALID_CONTENT_DIGEST');
  const normalized = input.objectRefIds.map((id) => id.toLowerCase());
  const ids = [...new Set(normalized)].sort();
  if (ids.length !== input.objectRefIds.length) throw new Error('DUPLICATE_OBJECT_REFERENCE');
  if (normalized.some((id, index) => id !== input.objectRefIds[index])) throw new Error('NON_CANONICAL_OBJECT_REFERENCE');
  return cloudBrainSourceVersion({
    protocolVersion: 'cloud-ingest-v2', sourceId: input.sourceId, sourceVersionId: input.sourceVersionId,
    tenantId: input.tenantId, workspaceId: input.workspaceId, contentDigest: input.contentDigest,
    objectRefIds: ids, referenceStateVersion: input.referenceStateVersion,
  });
}

export type SyncedField = { readonly value: unknown };
export type SyncedFields = Readonly<Record<string, SyncedField>>;

/** Extracts only a live, server-synced BRAIN source/version snapshot. Missing state is an error. */
export function sourceVersionSnapshotFromSyncedRows(
  sourceId: string,
  sourceRow: { readonly fields: SyncedFields; readonly deleted: boolean } | undefined,
  versionRows: readonly { readonly id: string; readonly fields: SyncedFields; readonly deleted: boolean }[],
): SourceVersionSnapshot {
  // The source identity is the cloud_sync_rows.row_id; only a present, live row is needed here.
  if (!sourceRow || sourceRow.deleted) throw new Error('SOURCE_STATE_UNAVAILABLE');
  if (versionRows.length === 0 || versionRows.some((row) => row.deleted))
    throw new Error('SOURCE_STATE_UNAVAILABLE');

  const versions: SourceVersionEntry[] = versionRows.map(({ id, fields }) => {
    const version = fields['version']?.value;
    const contentHash = fields['content_hash']?.value;
    if (
      !Number.isSafeInteger(version) ||
      Number(version) < 0 ||
      typeof contentHash !== 'string' ||
      !contentHash
    )
      throw new Error('SOURCE_STATE_UNAVAILABLE');
    return { id, version: Number(version), contentHash };
  });

  return { sourceId, versions };
}

export async function sourceVersionFromSyncedRows(
  sourceId: string,
  sourceRow: { readonly fields: SyncedFields; readonly deleted: boolean } | undefined,
  versionRows: readonly { readonly id: string; readonly fields: SyncedFields; readonly deleted: boolean }[],
): Promise<string> {
  return sourceVersionDigest(sourceVersionSnapshotFromSyncedRows(sourceId, sourceRow, versionRows));
}

/** True when any incoming row is permanently fenced by a completed Cloud erasure. */
export async function hasErasureFence(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  changes: readonly { readonly table: string; readonly id: string }[],
): Promise<boolean> {
  for (const change of changes) {
    const result = await client.query(
      `SELECT 1 FROM cloud_erasure_source_fences
        WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4 LIMIT 1`,
      [tenantId, workspaceId, change.table, change.id],
    );
    if (result.rows.length > 0) return true;
  }
  return false;
}

interface ApprovalRow extends Record<string, unknown> {
  approval_id: string;
  decision_id: string;
  tenant_id: string;
  workspace_id: string;
  capability_id: string;
  input_hash: string;
  requested_by: string;
  approver_id: string;
  issued_at: string | Date;
  expires_at: string | Date;
}

/**
 * Reconstructs the same typed proof as CapabilityBus from trusted identity and durable approval
 * rows. This object is internal to the Worker and is never read from request JSON.
 */
export async function verifyCloudCapabilityApproval(
  client: NeonQueryClient,
  claims: CandidateClaims,
  approvalId: string,
  capabilityId: 'brain.sources.erase' | 'brain.sources.erase.retry',
  capabilityInput: unknown,
): Promise<VerifiedCapabilityApprovalType | null> {
  // BRAIN erasure capabilities are explicitly non-agent-callable.
  if (claims.kind !== 'user') return null;
  const inputDigest = await hashApprovalInput(capabilityInput);
  const result = await client.query<ApprovalRow>(
    `SELECT r.id AS approval_id,d.id AS decision_id,r.tenant_id,r.workspace_id,
        r.capability_id,r.input_hash,r.requested_by,d.decided_by AS approver_id,
        d.created_at AS issued_at,r.expires_at
       FROM approval_requests r
       JOIN approval_decisions d
         ON (d.tenant_id,d.workspace_id,d.request_id)=(r.tenant_id,r.workspace_id,r.id)
       JOIN memberships m
         ON (m.tenant_id,m.workspace_id,m.user_id)=(d.tenant_id,d.workspace_id,d.decided_by)
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.workspace_id=$3
        AND r.capability_id=$4 AND r.input_hash=$5 AND r.requested_by=$6
        AND r.expires_at>now() AND d.decision='approved' AND d.valid=true
        AND d.decided_by<>r.requested_by AND m.active=true AND m.role IN ('owner','admin')
      LIMIT 1`,
    [approvalId, claims.tenantId, claims.activeWorkspaceId, capabilityId, inputDigest, claims.principalId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const proof = {
    version: 1 as const,
    approvalId: row.approval_id,
    decisionId: row.decision_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    principalId: claims.principalId,
    requestedBy: row.requested_by,
    approverId: row.approver_id,
    capabilityId: row.capability_id,
    inputDigest: row.input_hash,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  return VerifiedCapabilityApproval.parse({
    ...proof,
    scopeHash: await hashApprovalScope(proof),
  });
}
