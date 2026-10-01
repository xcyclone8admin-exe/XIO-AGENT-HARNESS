import { z } from 'zod';
import {
  canonicalCloudIngestionJson,
  cloudBrainContentDigest,
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
import { NeonSyncStore } from './neon-sync-store';
import type { FieldWrite } from './store';

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

export interface CurrentBrainIngestionSnapshot {
  readonly sourceVersion: string;
  readonly contentDigest: string;
  readonly referenceSetDigest: string;
  readonly referenceStateVersion: number;
  readonly objectRefIds: readonly string[];
}

/** Reads and re-derives the current, finalized v2 source/ref snapshot under the caller's workspace lock. */
export async function currentBrainIngestionSnapshot(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  sourceId: string,
): Promise<CurrentBrainIngestionSnapshot> {
  const finalized = await client.query<{
    ingestion_id: string;
    source_version_id: string;
    content_version: string;
    content_digest: string;
    source_version: string;
    reference_state: string;
    object_ref_ids: unknown;
    reference_state_version: string | number;
    ref_source_version: string;
    snapshot_digest: string;
    ref_object_ids: unknown;
    completeness: string;
  }>(
    `SELECT i.id AS ingestion_id,i.source_version_id,i.content_version,i.content_digest,i.source_version,
        i.reference_state,i.object_ref_ids,
        i.reference_state_version,rs.source_version AS ref_source_version,rs.snapshot_digest,
        rs.object_ids AS ref_object_ids,rs.completeness
       FROM cloud_erasure_reference_sets rs
       JOIN cloud_source_ingestions i ON (i.tenant_id,i.workspace_id,i.id)=(rs.tenant_id,rs.workspace_id,rs.ingestion_id)
      WHERE rs.tenant_id=$1 AND rs.workspace_id=$2 AND rs.source_kind='brain_source' AND rs.source_id=$3
        AND rs.current=true AND i.status='finalized'
      FOR UPDATE OF rs,i`,
    [tenantId, workspaceId, sourceId],
  );
  const snapshot = finalized.rows[0];
  if (!snapshot || !['verified_empty', 'verified_nonempty'].includes(snapshot.completeness) ||
      snapshot.reference_state !== snapshot.completeness)
    throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
  const objectRefIds = Array.isArray(snapshot.ref_object_ids) ? snapshot.ref_object_ids : null;
  const ingestionRefIds = Array.isArray(snapshot.object_ref_ids) ? snapshot.object_ref_ids : null;
  if (!objectRefIds || !ingestionRefIds || objectRefIds.some((id) => typeof id !== 'string') ||
      ingestionRefIds.some((id) => typeof id !== 'string')) throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
  const refs = objectRefIds as string[];
  const normalizedRefs = [...new Set(refs)].sort();
  const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (refs.length !== normalizedRefs.length || refs.some((id, index) => !canonicalUuid.test(id) || id !== normalizedRefs[index]) ||
      (ingestionRefIds as string[]).some((id) => !canonicalUuid.test(id)) ||
      (ingestionRefIds as string[]).join(',') !== refs.join(',')) throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
  if ((snapshot.completeness === 'verified_empty' && refs.length !== 0) ||
      (snapshot.completeness === 'verified_nonempty' && refs.length === 0))
    throw new Error('SOURCE_REFERENCES_UNAVAILABLE');

  const source = await client.query<{ fields: unknown; deleted_hlc: string | null }>(
    `SELECT fields,deleted_hlc FROM cloud_sync_rows
      WHERE tenant_id=$1 AND workspace_id=$2 AND table_name='brain_sources' AND row_id=$3 FOR UPDATE`,
    [tenantId, workspaceId, sourceId],
  );
  const versions = await client.query<{ row_id: string; fields: unknown; deleted_hlc: string | null }>(
    `SELECT row_id,fields,deleted_hlc FROM cloud_sync_rows
      WHERE tenant_id=$1 AND workspace_id=$2 AND table_name='brain_source_versions'
        AND fields->'source_id'->>'value'=$3 ORDER BY row_id FOR UPDATE`,
    [tenantId, workspaceId, sourceId],
  );
  const parseFields = (value: unknown): SyncedFields =>
    (typeof value === 'string' ? JSON.parse(value) : value) as SyncedFields;
  const sourceRow = source.rows[0];
  const sourceFields = sourceRow ? parseFields(sourceRow.fields) : undefined;
  let versionSnapshot: SourceVersionSnapshot;
  try {
    versionSnapshot = sourceVersionSnapshotFromSyncedRows(sourceId,
      sourceFields ? { fields: sourceFields, deleted: !!sourceRow!.deleted_hlc } : undefined,
      versions.rows.map((row) => ({ id: row.row_id, fields: parseFields(row.fields), deleted: !!row.deleted_hlc })));
  } catch {
    throw new Error('SOURCE_STATE_UNAVAILABLE');
  }
  const contentVersion = await sourceVersionDigest(versionSnapshot);
  if (contentVersion !== snapshot.content_version) throw new Error('SOURCE_STATE_UNAVAILABLE');
  const target = versions.rows.find((row) => row.row_id === snapshot.source_version_id);
  const targetFields = target ? parseFields(target.fields) : undefined;
  const contentText = targetFields?.['content_text']?.value;
  const targetVersion = targetFields?.['version']?.value;
  const maxVersion = Math.max(...versionSnapshot.versions.map(({ version }) => version));
  const syncedRefs = sourceFields?.['cloud_object_ref_ids']?.value;
  if (!target || target.deleted_hlc || typeof contentText !== 'string' || !Array.isArray(syncedRefs) ||
      targetVersion !== maxVersion || syncedRefs.some((id) => typeof id !== 'string' || !canonicalUuid.test(id)) ||
      (syncedRefs as string[]).join(',') !== refs.join(','))
    throw new Error('SOURCE_STATE_UNAVAILABLE');
  const contentDigest = await cloudBrainContentDigest(contentText);
  if (contentDigest !== snapshot.content_digest) throw new Error('SOURCE_STATE_UNAVAILABLE');
  const referenceStateVersion = Number(snapshot.reference_state_version);
  if (!Number.isSafeInteger(referenceStateVersion) || referenceStateVersion < 1)
    throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
  const sourceVersion = await cloudBrainSourceVersion({
    protocolVersion: 'cloud-ingest-v2', sourceId, sourceVersionId: snapshot.source_version_id,
    tenantId, workspaceId, contentDigest, objectRefIds: refs, referenceStateVersion,
  });
  if (sourceVersion !== snapshot.source_version || sourceVersion !== snapshot.ref_source_version)
    throw new Error('SOURCE_STATE_UNAVAILABLE');
  const referenceSetDigest = await cloudReferenceSetDigest({ sourceId, sourceVersionId: snapshot.source_version_id, objectRefIds: refs });
  if (referenceSetDigest !== snapshot.snapshot_digest) throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
  return { sourceVersion, contentDigest, referenceSetDigest, referenceStateVersion, objectRefIds: refs };
}

export type ClaimErasureResult =
  | { readonly ok: true; readonly claimId: string; readonly claimGeneration: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: 'ERASURE_NOT_FOUND' | 'ATTEMPT_NOT_FOUND' | 'RESERVATION_MISMATCH' |
      'RESERVATION_EXPIRED' | 'ERASURE_NOT_ELIGIBLE' | 'SOURCE_STATE_UNAVAILABLE' | 'SOURCE_REFERENCES_UNAVAILABLE' |
      'SOURCE_VERSION_STALE' | 'ELIGIBILITY_INVALIDATED' | 'RETAINED_HOLD' | 'HOLD_UNKNOWN' | 'OBJECT_UNAVAILABLE' };

/** Atomically claims the phase-1 reservation after recomputing every Cloud-owned precondition. */
export async function claimLocalErasurePurge(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  operationId: string,
  attemptId: string,
  reservationId: string,
  blobsAvailable: boolean,
  now = new Date(),
): Promise<ClaimErasureResult> {
  const operations = await client.query<{
    id: string; erasure_id: string; source_id: string; source_version: string; status: string;
    attempt_no: number; reference_state_version: unknown; hold_state_version: unknown; reservation_id: string | null;
    reservation_expires_at: string | Date | null; claim_id: string | null; claim_generation: string | number;
  }>(`SELECT id,erasure_id,source_id,source_version,status,attempt_no,reference_state_version,hold_state_version,
       reservation_id,reservation_expires_at,claim_id,claim_generation
      FROM cloud_erasure_operations WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
  [tenantId, workspaceId, operationId]);
  const operation = operations.rows[0];
  if (!operation) return { ok: false, code: 'ERASURE_NOT_FOUND' };
  const attempt = await client.query(`SELECT 1 FROM cloud_erasure_attempts WHERE tenant_id=$1 AND workspace_id=$2
    AND operation_id=$3 AND attempt_id=$4`, [tenantId, workspaceId, operationId, attemptId]);
  if (!attempt.rows.length) return { ok: false, code: 'ATTEMPT_NOT_FOUND' };
  if (operation.status === 'purge_claimed' && operation.reservation_id === reservationId && operation.claim_id)
    return { ok: true, claimId: operation.claim_id, claimGeneration: Number(operation.claim_generation), replayed: true };
  if (operation.status !== 'eligible') return { ok: false, code: 'ERASURE_NOT_ELIGIBLE' };
  if (operation.reservation_id !== reservationId) return { ok: false, code: 'RESERVATION_MISMATCH' };
  if (!operation.reservation_expires_at || new Date(operation.reservation_expires_at).getTime() <= now.getTime()) {
    await client.query(`UPDATE cloud_erasure_operations SET status='eligibility_expired',reservation_id=NULL,
      reservation_expires_at=NULL,updated_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [tenantId, workspaceId, operationId, now.toISOString()]);
    await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
      VALUES ($1,$2,$3,$4,'eligibility_expired','{"reason":"reservation_expired"}'::jsonb)`,
    [tenantId, workspaceId, operationId, crypto.randomUUID()]);
    return { ok: false, code: 'RESERVATION_EXPIRED' };
  }
  let snapshot: CurrentBrainIngestionSnapshot;
  try {
    snapshot = await currentBrainIngestionSnapshot(client, tenantId, workspaceId, operation.source_id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    return { ok: false, code: message === 'SOURCE_REFERENCES_UNAVAILABLE' ? 'SOURCE_REFERENCES_UNAVAILABLE' : 'SOURCE_STATE_UNAVAILABLE' };
  }
  if (snapshot.sourceVersion !== operation.source_version) return { ok: false, code: 'SOURCE_VERSION_STALE' };
  const oldRefVersions = typeof operation.reference_state_version === 'string'
    ? JSON.parse(operation.reference_state_version) as Record<string, number>
    : operation.reference_state_version as Record<string, number>;
  const oldHoldVersions = typeof operation.hold_state_version === 'string'
    ? JSON.parse(operation.hold_state_version) as Record<string, number>
    : operation.hold_state_version as Record<string, number>;
  if (snapshot.objectRefIds.join(',') !== Object.keys(oldRefVersions).sort().join(','))
    return { ok: false, code: 'ELIGIBILITY_INVALIDATED' };
  const ids = snapshot.objectRefIds;
  const objects = ids.length ? await client.query<{
    id: string; storage_state: string; reference_state_version: string | number;
    hold_state: string; hold_state_version: string | number;
  }>(`SELECT id,storage_state,reference_state_version,hold_state,hold_state_version
       FROM cloud_erasure_objects WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])
       ORDER BY id FOR UPDATE`, [tenantId, workspaceId, ids]) : { rows: [] };
  if (objects.rows.length !== ids.length) return { ok: false, code: 'OBJECT_UNAVAILABLE' };
  let holdCode: 'RETAINED_HOLD' | 'HOLD_UNKNOWN' | null = null;
  let invalidated = false;
  let unavailable = false;
  for (const object of objects.rows) {
    if (Number(object.reference_state_version) !== oldRefVersions[object.id] ||
        Number(object.hold_state_version) !== oldHoldVersions[object.id]) invalidated = true;
    if (object.hold_state === 'held') holdCode = 'RETAINED_HOLD';
    else if (object.hold_state !== 'clear' && !holdCode) holdCode = 'HOLD_UNKNOWN';
    const ownership = await client.query<{ active_refs: number }>(
      `SELECT count(*)::int AS active_refs FROM cloud_erasure_refs
        WHERE tenant_id=$1 AND workspace_id=$2 AND object_id=$3 AND active=true`, [tenantId, workspaceId, object.id]);
    const own = await client.query(`SELECT 1 FROM cloud_erasure_refs WHERE tenant_id=$1 AND workspace_id=$2
      AND object_id=$3 AND source_kind='brain_source' AND source_id=$4 AND active=true`,
    [tenantId, workspaceId, object.id, operation.source_id]);
    if (!own.rows.length || Number(ownership.rows[0]?.active_refs ?? 0) < 1) invalidated = true;
    if (Number(ownership.rows[0]?.active_refs ?? 0) <= 1 && (!blobsAvailable || object.storage_state !== 'available'))
      unavailable = true;
  }
  if (invalidated || holdCode || unavailable) {
    const status = unavailable ? 'unavailable' : holdCode === 'RETAINED_HOLD' ? 'retained_hold'
      : holdCode === 'HOLD_UNKNOWN' ? 'hold_unknown' : 'eligibility_invalidated';
    const code = unavailable ? 'OBJECT_UNAVAILABLE' : holdCode ?? 'ELIGIBILITY_INVALIDATED';
    await client.query(`UPDATE cloud_erasure_operations SET status=$4,reservation_id=NULL,
      reservation_expires_at=NULL,updated_at=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [tenantId, workspaceId, operationId, status, now.toISOString()]);
    await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [tenantId, workspaceId, operationId, crypto.randomUUID(), status,
      JSON.stringify({ reason: code.toLowerCase(), referenceStateVersion: oldRefVersions, holdStateVersion: oldHoldVersions })]);
    return { ok: false, code };
  }
  const claimId = crypto.randomUUID();
  const claimGeneration = Number(operation.claim_generation) + 1;
  await client.query(`UPDATE cloud_erasure_operations SET status='purge_claimed',claim_id=$4,
      claim_generation=$5,updated_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
  [tenantId, workspaceId, operationId, claimId, claimGeneration, now.toISOString()]);
  await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
    VALUES ($1,$2,$3,$4,'purge_claimed',$5::jsonb)`,
  [tenantId, workspaceId, operationId, crypto.randomUUID(), JSON.stringify({ claimId, claimGeneration })]);
  return { ok: true, claimId, claimGeneration, replayed: false };
}

export interface CloudSourcePurgeCounts {
  readonly canonicalRows: number;
  readonly derivedRows: number;
  readonly deletedByTable: Readonly<Record<string, number>>;
  readonly detachedSupersedesEdges: number;
  readonly syncChangesRedacted: number;
  readonly conflictRecordsDeleted: number;
  readonly idempotencyRecordsDeleted: number;
  readonly syncReferenceEdgesDeleted: number;
  readonly ingestionRecordsDeleted: number;
  readonly referenceSnapshotsDeleted: number;
}

interface CloudSyncRow extends Record<string, unknown> {
  readonly table_name: string;
  readonly row_id: string;
  readonly fields: unknown;
}

type StoredCloudFields = Record<string, { readonly value: unknown; readonly hlc?: string; readonly baseHlc?: string | null }>;

function parseSyncedFields(value: unknown): StoredCloudFields {
  return (typeof value === 'string' ? JSON.parse(value) : value) as StoredCloudFields;
}

function syncedValue(fields: StoredCloudFields, name: string): unknown {
  return fields[name]?.value;
}

function nextServerHlc(previous: string | undefined, now: number): string {
  const current = String(now).padStart(13, '0');
  if (!previous) return `${current}-0000-cloud-erasure`;
  const match = /^(\d{13})-([0-9a-f]{4})-([a-z0-9]{1,32})$/.exec(previous);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error('SOURCE_STATE_UNAVAILABLE');
  let physical = Number(match[1]);
  let logical = Number.parseInt(match[2], 16);
  if (physical < now) return `${current}-0000-cloud-erasure`;
  if (logical < 0xffff) logical += 1;
  else {
    physical += 1;
    logical = 0;
  }
  if (physical > now + 5 * 60_000) throw new Error('SOURCE_STATE_UNAVAILABLE');
  return `${String(physical).padStart(13, '0')}-${logical.toString(16).padStart(4, '0')}-cloud-erasure`;
}

/**
 * Erases only the reviewed BRAIN lineage fields. It deliberately does not walk generic refs:
 * supersedes edges are detached, while brain_procedures.source_run_id is not source ownership.
 * Caller holds the workspace sequence lock and the claimed operation row lock in this transaction.
 */
export async function eraseCloudBrainSourceRows(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  sourceId: string,
  operationId: string,
  sourceVersion: string,
  now = Date.now(),
): Promise<CloudSourcePurgeCounts> {
  const tables = ['brain_sources','brain_source_versions','brain_chunks','brain_signals','brain_claims',
    'brain_promotions','brain_facts','brain_contradictions','brain_memories'];
  const result = await client.query<CloudSyncRow>(
    `SELECT table_name,row_id,fields FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
      AND table_name=ANY($3::text[]) ORDER BY table_name,row_id FOR UPDATE`,
    [tenantId, workspaceId, tables]);
  const rows = result.rows.map((row) => ({ ...row, fields: parseSyncedFields(row.fields) }));
  const values = (row: (typeof rows)[number], field: string) => syncedValue(row.fields, field);
  const versions = new Set(rows.filter((row) => row.table_name === 'brain_source_versions' && values(row, 'source_id') === sourceId).map((row) => row.row_id));
  const owned = new Map<string, Map<string, (typeof rows)[number]>>();
  const add = (table: string, row: (typeof rows)[number]) => {
    const found = owned.get(table) ?? new Map<string, (typeof rows)[number]>();
    found.set(row.row_id, row);
    owned.set(table, found);
  };
  const has = (table: string, id: unknown) => typeof id === 'string' && (owned.get(table)?.has(id) ?? false);
  const signals = new Set(rows.filter((row) => row.table_name === 'brain_signals' &&
    (values(row, 'source_id') === sourceId || (typeof values(row, 'source_version_id') === 'string' && versions.has(values(row, 'source_version_id') as string))))
    .map((row) => row.row_id));
  const claims = new Set(rows.filter((row) => row.table_name === 'brain_claims' && typeof values(row, 'signal_id') === 'string' && signals.has(values(row, 'signal_id') as string))
    .map((row) => row.row_id));
  const facts = new Set(rows.filter((row) => row.table_name === 'brain_facts' && typeof values(row, 'claim_id') === 'string' && claims.has(values(row, 'claim_id') as string))
    .map((row) => row.row_id));
  for (const row of rows) {
    if (row.table_name === 'brain_sources' && row.row_id === sourceId) add(row.table_name, row);
    else if (row.table_name === 'brain_source_versions' && versions.has(row.row_id)) add(row.table_name, row);
    else if (row.table_name === 'brain_chunks' &&
      (values(row, 'source_id') === sourceId || (typeof values(row, 'source_version_id') === 'string' && versions.has(values(row, 'source_version_id') as string)))) add(row.table_name, row);
    else if (row.table_name === 'brain_signals' && signals.has(row.row_id)) add(row.table_name, row);
    else if (row.table_name === 'brain_claims' && claims.has(row.row_id)) add(row.table_name, row);
    else if (row.table_name === 'brain_promotions' && has('brain_claims', values(row, 'claim_id'))) add(row.table_name, row);
    else if (row.table_name === 'brain_facts' && facts.has(row.row_id)) add(row.table_name, row);
    else if (row.table_name === 'brain_contradictions' &&
      (has('brain_claims', values(row, 'claim_id')) || has('brain_facts', values(row, 'fact_id')))) add(row.table_name, row);
    else if (row.table_name === 'brain_memories' &&
      (values(row, 'source_id') === sourceId || (typeof values(row, 'source_version_id') === 'string' && versions.has(values(row, 'source_version_id') as string)))) add(row.table_name, row);
  }
  if (!owned.get('brain_sources')?.has(sourceId) || !versions.size) throw new Error('SOURCE_STATE_UNAVAILABLE');

  const ownedFacts = owned.get('brain_facts') ?? new Map();
  const ownedMemories = owned.get('brain_memories') ?? new Map();
  const store = new NeonSyncStore(client, tenantId, workspaceId);
  const idempotencyKeys = new Set<string>();
  let detachedSupersedesEdges = 0;
  let syncChangesRedacted = 0;
  for (const row of rows) {
    const targetSet = row.table_name === 'brain_facts' ? ownedFacts : row.table_name === 'brain_memories' ? ownedMemories : null;
    if (!targetSet || targetSet.has(row.row_id)) continue;
    const previous = row.fields['supersedes_id'];
    const targetId = typeof previous?.value === 'string' ? previous.value : null;
    if (!targetId || !targetSet.has(targetId)) continue;
    const hlc = nextServerHlc(previous?.hlc, now);
    const write = { value: null, hlc, baseHlc: previous?.hlc ?? null };
    const next = { ...row.fields, supersedes_id: write };
    const oldChanges = await client.query(`SELECT 1 FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2
      AND table_name=$3 AND row_id=$4 AND change->'fields' ? 'supersedes_id'`,
    [tenantId, workspaceId, row.table_name, row.row_id]);
    syncChangesRedacted += oldChanges.rows.length;
    await store.putRow(`${row.table_name}:${row.row_id}`, { fields: next as Record<string, FieldWrite> });
    await store.appendLog({ table: row.table_name, id: row.row_id, tenantId, workspaceId,
      op: 'upsert', hlc, fields: { supersedes_id: write } });
    const parentTable = row.table_name === 'brain_facts' ? 'brain_facts' : 'brain_memories';
    await client.query(`DELETE FROM cloud_sync_refs WHERE tenant_id=$1 AND workspace_id=$2
      AND child_table=$3 AND child_row=$4 AND parent_table=$5 AND parent_row=$6`,
    [tenantId, workspaceId, row.table_name, row.row_id, parentTable, targetId]);
    const erasedConflict = await client.query(`DELETE FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2
      AND table_name=$3 AND record->>'field'='supersedes_id' AND record->>'losingValue'=$4 RETURNING 1`,
    [tenantId, workspaceId, row.table_name, targetId]);
    if (erasedConflict.rows.length) {
      const replay = await client.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM cloud_sync_idempotency WHERE tenant_id=$1 AND workspace_id=$2 AND
          EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(response->'conflictHistory','[]'::jsonb)) x
            WHERE x->>'table'=$3 AND x->>'field'='supersedes_id' AND x->>'losingValue'=$4)`,
        [tenantId, workspaceId, row.table_name, targetId]);
      for (const item of replay.rows) idempotencyKeys.add(item.idempotency_key);
    }
    detachedSupersedesEdges += 1;
  }

  const ownedRows = [...owned.entries()].flatMap(([table, entries]) => [...entries.values()].map((row) => ({ table, row })));
  let conflictRecordsDeleted = 0;
  let idempotencyRecordsDeleted = 0;
  let syncReferenceEdgesDeleted = 0;
  for (const { table, row } of ownedRows) {
    const removedChanges = await client.query(`DELETE FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4 RETURNING 1`,
      [tenantId, workspaceId, table, row.row_id]);
    syncChangesRedacted += removedChanges.rows.length;
    const removedConflicts = await client.query(`DELETE FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4 RETURNING 1`,
      [tenantId, workspaceId, table, row.row_id]);
    conflictRecordsDeleted += removedConflicts.rows.length;
    const replay = await client.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM cloud_sync_idempotency WHERE tenant_id=$1 AND workspace_id=$2 AND (
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(response->'changeOutcomes','[]'::jsonb)) x
          WHERE x->>'table'=$3 AND x->>'rowId'=$4) OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(response->'conflictHistory','[]'::jsonb)) x
          WHERE x->>'table'=$3 AND x->>'rowId'=$4) OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(response->'rejected','[]'::jsonb)) x
          WHERE x->>'changeId'=$4))`, [tenantId, workspaceId, table, row.row_id]);
    for (const item of replay.rows) idempotencyKeys.add(item.idempotency_key);
    const edges = await client.query(`DELETE FROM cloud_sync_refs WHERE tenant_id=$1 AND workspace_id=$2 AND
      ((child_table=$3 AND child_row=$4) OR (parent_table=$3 AND parent_row=$4)) RETURNING 1`,
    [tenantId, workspaceId, table, row.row_id]);
    syncReferenceEdgesDeleted += edges.rows.length;
    await client.query(`DELETE FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4`,
      [tenantId, workspaceId, table, row.row_id]);
    const latestClock = Object.values(row.fields).map((field) => field.hlc).filter((clock): clock is string => typeof clock === 'string')
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0).at(-1);
    await store.appendLog({ table, id: row.row_id, tenantId, workspaceId, op: 'delete', fields: {},
      hlc: nextServerHlc(latestClock, now) });
    await client.query(`INSERT INTO cloud_erasure_source_fences(tenant_id,workspace_id,source_kind,source_id,
      table_name,row_id,operation_id,erased_source_version) VALUES ($1,$2,'brain_source',$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id,workspace_id,table_name,row_id) DO NOTHING`,
    [tenantId, workspaceId, sourceId, table, row.row_id, operationId, sourceVersion]);
  }
  if (idempotencyKeys.size) {
    const removed = await client.query(`DELETE FROM cloud_sync_idempotency WHERE tenant_id=$1 AND workspace_id=$2
      AND idempotency_key=ANY($3::text[]) RETURNING 1`, [tenantId, workspaceId, [...idempotencyKeys]]);
    idempotencyRecordsDeleted = removed.rows.length;
  }
  const ingestionIds = await client.query<{ id: string }>(`SELECT id FROM cloud_source_ingestions
    WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 FOR UPDATE`, [tenantId, workspaceId, sourceId]);
  const ids = ingestionIds.rows.map(({ id }) => id);
  if (ids.length) await client.query(`DELETE FROM cloud_source_ingestion_objects WHERE tenant_id=$1 AND workspace_id=$2
    AND ingestion_id=ANY($3::uuid[])`, [tenantId, workspaceId, ids]);
  const deletedSnapshots = await client.query(`DELETE FROM cloud_erasure_reference_sets WHERE tenant_id=$1 AND workspace_id=$2
    AND source_kind='brain_source' AND source_id=$3 RETURNING 1`, [tenantId, workspaceId, sourceId]);
  const retiredRefs = await client.query(`DELETE FROM cloud_erasure_refs WHERE tenant_id=$1 AND workspace_id=$2
    AND source_kind='brain_source' AND source_id=$3 RETURNING 1`, [tenantId, workspaceId, sourceId]);
  if (ids.length) await client.query(`DELETE FROM cloud_source_ingestions WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])`,
    [tenantId, workspaceId, ids]);
  const deletedByTable = Object.fromEntries([...owned.entries()].map(([table, entries]) => [table, entries.size]));
  const canonicalRows = (deletedByTable['brain_sources'] ?? 0) + (deletedByTable['brain_source_versions'] ?? 0);
  return { canonicalRows, derivedRows: ownedRows.length - canonicalRows, deletedByTable,
    detachedSupersedesEdges, syncChangesRedacted, conflictRecordsDeleted, idempotencyRecordsDeleted,
    syncReferenceEdgesDeleted: syncReferenceEdgesDeleted + retiredRefs.rows.length,
    ingestionRecordsDeleted: ingestionIds.rows.length, referenceSnapshotsDeleted: deletedSnapshots.rows.length };
}

export type LocalErasureAckResult =
  | { readonly ok: true; readonly status: string; readonly detail: Record<string, unknown>;
      readonly receiptId: string; readonly replayed: boolean; readonly deleteTargets: readonly { readonly id: string; readonly key: string }[] }
  | { readonly ok: false; readonly code: 'ERASURE_NOT_FOUND' | 'ATTEMPT_NOT_FOUND' | 'CLAIM_MISMATCH' |
      'RECEIPT_MISMATCH' | 'ERASURE_NOT_CLAIMED' | 'SOURCE_VERSION_STALE' | 'SOURCE_STATE_UNAVAILABLE' |
      'SOURCE_REFERENCES_UNAVAILABLE' };

/** Persists the local receipt and atomically erases Cloud sync/history copies under the claim. */
export async function acknowledgeLocalErasurePurge(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  operationId: string,
  input: z.infer<typeof LocalPurgeAckRequest>,
  blobsAvailable: boolean,
  now = new Date(),
): Promise<LocalErasureAckResult> {
  // Neon JSON/record drivers expose dynamic rows; values are validated against the operation below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = await client.query<Record<string, any>>(
    `SELECT id,source_id,source_version,status,attempt_no,claim_id,claim_generation,local_receipt_id,
        local_receipt_digest,receipt_id,retry_count,retry_limit
       FROM cloud_erasure_operations WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
    [tenantId, workspaceId, operationId]);
  const operation = found.rows[0];
  if (!operation) return { ok: false, code: 'ERASURE_NOT_FOUND' };
  const attempt = await client.query(`SELECT 1 FROM cloud_erasure_attempts WHERE tenant_id=$1 AND workspace_id=$2
    AND operation_id=$3 AND attempt_id=$4`, [tenantId, workspaceId, operationId, input.attemptId]);
  if (!attempt.rows.length) return { ok: false, code: 'ATTEMPT_NOT_FOUND' };
  if (operation.local_receipt_id && (operation.local_receipt_id !== input.localPurgeReceiptId ||
      operation.local_receipt_digest !== input.localPurgeReceiptDigest)) return { ok: false, code: 'RECEIPT_MISMATCH' };
  if (operation.source_version !== input.sourceVersion) return { ok: false, code: 'SOURCE_VERSION_STALE' };

  if (operation.status !== 'purge_claimed') {
    if (!operation.local_receipt_id || operation.local_receipt_id !== input.localPurgeReceiptId ||
        operation.local_receipt_digest !== input.localPurgeReceiptDigest ||
        !['local_purge_acknowledged','delete_pending','completed','retained_shared','retained_hold','hold_unknown',
          'unavailable','retryable_failure','terminal_failure'].includes(operation.status))
      return { ok: false, code: 'ERASURE_NOT_CLAIMED' };
    const event = await client.query<{ detail: unknown }>(`SELECT detail FROM cloud_erasure_events WHERE tenant_id=$1 AND workspace_id=$2
      AND operation_id=$3 ORDER BY id DESC LIMIT 1`, [tenantId, workspaceId, operationId]);
    const detail = typeof event.rows[0]?.detail === 'string' ? JSON.parse(event.rows[0].detail) as Record<string, unknown>
      : (event.rows[0]?.detail ?? {}) as Record<string, unknown>;
    const deleteTargets: Array<{ id: string; key: string }> = [];
    let status = operation.status as string;
    if (Array.isArray(detail['objects']) && ['delete_pending','retryable_failure','unavailable'].includes(status)) {
      for (const item of detail['objects'] as Array<Record<string, unknown>>) {
        const id = typeof item['opaqueRefId'] === 'string' ? item['opaqueRefId'] : null;
        if (!id || !['delete_pending','unavailable'].includes(String(item['disposition']))) continue;
        const object = await client.query<{ storage_key: string; storage_state: string; hold_state: string }>(
          `SELECT storage_key,storage_state,hold_state FROM cloud_erasure_objects
            WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [tenantId, workspaceId, id]);
        const stored = object.rows[0];
        if (!stored) { item['disposition'] = 'unavailable'; continue; }
        const refs = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM cloud_erasure_refs
          WHERE tenant_id=$1 AND workspace_id=$2 AND object_id=$3 AND active=true`, [tenantId, workspaceId, id]);
        if (Number(refs.rows[0]?.count ?? 0) > 0) { item['disposition'] = 'retained_shared'; continue; }
        if (stored.hold_state === 'held') { item['disposition'] = 'retained_hold'; continue; }
        if (stored.hold_state !== 'clear') { item['disposition'] = 'hold_unknown'; continue; }
        if (stored.storage_state === 'deleted') { item['disposition'] = 'deleted'; continue; }
        if (!blobsAvailable || !['available','deleting'].includes(stored.storage_state)) {
          item['disposition'] = 'unavailable';
          continue;
        }
        if (stored.storage_state === 'available') await client.query(`UPDATE cloud_erasure_objects SET storage_state='deleting'
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [tenantId, workspaceId, id]);
        item['disposition'] = 'delete_pending';
        deleteTargets.push({ id, key: stored.storage_key });
      }
      status = deleteTargets.length ? 'delete_pending'
        : (detail['objects'] as Array<Record<string, unknown>>).some((item) => item['disposition'] === 'unavailable') ? 'unavailable'
          : (detail['objects'] as Array<Record<string, unknown>>).some((item) => item['disposition'] === 'retained_hold') ? 'retained_hold'
            : (detail['objects'] as Array<Record<string, unknown>>).some((item) => item['disposition'] === 'hold_unknown') ? 'hold_unknown'
              : (detail['objects'] as Array<Record<string, unknown>>).some((item) => item['disposition'] === 'retained_shared') ? 'retained_shared' : 'completed';
      if (status !== operation.status || deleteTargets.length) {
        await client.query(`UPDATE cloud_erasure_operations SET status=$4,updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [tenantId, workspaceId, operationId, status]);
        await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [tenantId, workspaceId, operationId, crypto.randomUUID(), status, JSON.stringify(detail)]);
      }
    }
    return { ok: true, status, detail, receiptId: operation.receipt_id, replayed: true, deleteTargets };
  }
  if (operation.claim_id !== input.claimId || Number(operation.claim_generation) !== input.claimGeneration)
    return { ok: false, code: 'CLAIM_MISMATCH' };
  let snapshot: CurrentBrainIngestionSnapshot;
  try {
    snapshot = await currentBrainIngestionSnapshot(client, tenantId, workspaceId, operation.source_id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    return { ok: false, code: message === 'SOURCE_REFERENCES_UNAVAILABLE' ? 'SOURCE_REFERENCES_UNAVAILABLE' : 'SOURCE_STATE_UNAVAILABLE' };
  }
  if (snapshot.sourceVersion !== operation.source_version || snapshot.sourceVersion !== input.sourceVersion)
    return { ok: false, code: 'SOURCE_VERSION_STALE' };

  const objects = snapshot.objectRefIds.length ? await client.query<{
    id: string; storage_key: string; storage_state: string; hold_state: string;
  }>(`SELECT id,storage_key,storage_state,hold_state FROM cloud_erasure_objects
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
  [tenantId, workspaceId, snapshot.objectRefIds]) : { rows: [] };
  const objectIds = new Set(objects.rows.map(({ id }) => id));
  const dispositions: Array<{ opaqueRefId: string; disposition: string; holdState: string }> = [];
  const deleteTargets: Array<{ id: string; key: string }> = [];
  let missing = false;
  let shared = false;
  let retainedHold = false;
  let holdUnknown = false;
  let unavailable = false;
  for (const id of snapshot.objectRefIds) {
    const object = objects.rows.find((candidate) => candidate.id === id);
    if (!object) {
      missing = true;
      dispositions.push({ opaqueRefId: id, disposition: 'unavailable', holdState: 'unknown' });
      continue;
    }
    const refs = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM cloud_erasure_refs
      WHERE tenant_id=$1 AND workspace_id=$2 AND object_id=$3 AND active=true`, [tenantId, workspaceId, id]);
    const own = await client.query(`SELECT 1 FROM cloud_erasure_refs WHERE tenant_id=$1 AND workspace_id=$2
      AND object_id=$3 AND source_kind='brain_source' AND source_id=$4 AND active=true`,
    [tenantId, workspaceId, id, operation.source_id]);
    const activeCount = Number(refs.rows[0]?.count ?? 0);
    let disposition: string;
    if (object.hold_state === 'held') { disposition = 'retained_hold'; retainedHold = true; }
    else if (object.hold_state !== 'clear') { disposition = 'hold_unknown'; holdUnknown = true; }
    else if (activeCount > 1) { disposition = 'retained_shared'; shared = true; }
    else if (!own.rows.length || activeCount !== 1 || !blobsAvailable || object.storage_state !== 'available') {
      disposition = 'unavailable'; unavailable = true;
    } else {
      disposition = 'delete_pending';
      deleteTargets.push({ id, key: object.storage_key });
    }
    dispositions.push({ opaqueRefId: id, disposition, holdState: object.hold_state });
  }
  if (objects.rows.length !== objectIds.size || missing) unavailable = true;
  for (const target of deleteTargets) await client.query(`UPDATE cloud_erasure_objects SET storage_state='deleting'
    WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [tenantId, workspaceId, target.id]);
  const counts = await eraseCloudBrainSourceRows(client, tenantId, workspaceId, operation.source_id,
    operationId, operation.source_version, now.getTime());
  const status = deleteTargets.length ? 'delete_pending' : unavailable ? 'unavailable'
    : retainedHold ? 'retained_hold' : holdUnknown ? 'hold_unknown' : shared ? 'retained_shared' : 'completed';
  const detail: Record<string, unknown> = {
    objects: dispositions,
    cloudCopies: { canonicalRows: counts.canonicalRows, derivedRows: counts.derivedRows,
      deletedByTable: counts.deletedByTable, detachedSupersedesEdges: counts.detachedSupersedesEdges,
      syncChangesRedacted: counts.syncChangesRedacted, conflictRecordsDeleted: counts.conflictRecordsDeleted,
      idempotencyRecordsDeleted: counts.idempotencyRecordsDeleted,
      syncReferenceEdgesDeleted: counts.syncReferenceEdgesDeleted,
      ingestionRecordsDeleted: counts.ingestionRecordsDeleted,
      referenceSnapshotsDeleted: counts.referenceSnapshotsDeleted },
    localReceiptId: input.localPurgeReceiptId,
    localReceiptDigest: input.localPurgeReceiptDigest,
    checkedObjectRefs: snapshot.objectRefIds.length,
    deletedObjectRefs: 0,
  };
  await client.query(`UPDATE cloud_erasure_operations SET local_receipt_id=$4,local_receipt_digest=$5,status=$6,
    retry_count=0,updated_at=$7 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
  [tenantId, workspaceId, operationId, input.localPurgeReceiptId, input.localPurgeReceiptDigest, status, now.toISOString()]);
  await client.query(`INSERT INTO cloud_erasure_events(tenant_id,workspace_id,operation_id,event_id,status,detail)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [tenantId, workspaceId, operationId, crypto.randomUUID(), status, JSON.stringify(detail)]);
  return { ok: true, status, detail, receiptId: operation.receipt_id, replayed: false, deleteTargets };
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
