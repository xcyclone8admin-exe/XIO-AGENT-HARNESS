import { cloudReferenceSetDigest } from './erasure';
import { assertPushResponseBoundToRequest, type PushRequest, type PushResponse } from './sync';

export interface BrainReferenceSyncExpectation {
  tenantId: string;
  workspaceId: string;
  sourceId: string;
  sourceVersionId: string;
  contentDigest: string;
  objectRefIds: string[];
  referenceSetDigest: string;
}

/**
 * Evidence that the authenticated sync authority accepted or already held both exact rows.
 * This is a host-internal result, not a renderer assertion or a substitute for Cloud's own
 * source/ref equality check during ingestion finalization.
 */
export interface BrainReferenceSyncAcknowledgement {
  tenantId: string;
  workspaceId: string;
  sourceId: string;
  sourceVersionId: string;
  contentDigest: string;
  objectRefIds: string[];
  referenceSetDigest: string;
  idempotencyKey: string;
  serverSeq: string;
  sourceChangeId: string;
  sourceChangeIndex: number;
  versionChangeId: string;
  versionChangeIndex: number;
  replayed: boolean;
}

function fieldValue(change: PushRequest['changes'][number], name: string): unknown {
  return change.fields[name]?.value;
}

function requireFieldDisposition(
  response: PushResponse,
  index: number,
  name: string,
): void {
  const outcome = response.changeOutcomes?.[index];
  if (
    !outcome || outcome.outcome === 'rejected' ||
    outcome.conflictedFields.includes(name) ||
    (!outcome.appliedFields.includes(name) && !outcome.unchangedFields.includes(name))
  ) throw new TypeError('SYNC_REFERENCE_FIELD_NOT_COMMITTED');
}

/**
 * Validate exact source/ref and version/content rows against the server's per-change outcomes.
 * Call only inside a trusted host after receiving the authenticated Cloud response.
 */
export async function assertBrainReferenceSyncAcknowledgement(
  request: PushRequest,
  response: PushResponse,
  expected: BrainReferenceSyncExpectation,
): Promise<BrainReferenceSyncAcknowledgement> {
  assertPushResponseBoundToRequest(request, response);
  if (BigInt(response.serverSeq) <= 0n) throw new TypeError('SYNC_COMMIT_SEQUENCE_REQUIRED');
  if (request.changes.length !== response.changeOutcomes?.length) throw new TypeError('SYNC_OUTCOME_COVERAGE_MISMATCH');
  if (
    !/^[a-f0-9]{64}$/.test(expected.contentDigest) ||
    await cloudReferenceSetDigest({
      sourceId: expected.sourceId,
      sourceVersionId: expected.sourceVersionId,
      objectRefIds: expected.objectRefIds,
    }) !== expected.referenceSetDigest
  ) throw new TypeError('SYNC_REFERENCE_EXPECTATION_DIGEST_MISMATCH');

  const sourceMatches = request.changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) =>
      change.table === 'brain_sources' && change.id === expected.sourceId &&
      change.tenantId === expected.tenantId && change.workspaceId === expected.workspaceId &&
      change.op === 'upsert' && Object.hasOwn(change.fields, 'cloud_object_ref_ids'),
    );
  const versionMatches = request.changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) =>
      change.table === 'brain_source_versions' && change.id === expected.sourceVersionId &&
      change.tenantId === expected.tenantId && change.workspaceId === expected.workspaceId &&
      (change.op === 'append' || change.op === 'upsert') &&
      Object.hasOwn(change.fields, 'source_id') && Object.hasOwn(change.fields, 'content_hash'),
    );
  if (sourceMatches.length !== 1 || versionMatches.length !== 1) {
    throw new TypeError('SYNC_REFERENCE_ROWS_MISSING_OR_AMBIGUOUS');
  }
  const source = sourceMatches[0]!;
  const version = versionMatches[0]!;
  const submittedRefs = fieldValue(source.change, 'cloud_object_ref_ids');
  if (
    !Array.isArray(submittedRefs) || submittedRefs.length !== expected.objectRefIds.length ||
    submittedRefs.some((value, index) => value !== expected.objectRefIds[index]) ||
    fieldValue(version.change, 'source_id') !== expected.sourceId ||
    fieldValue(version.change, 'content_hash') !== expected.contentDigest
  ) throw new TypeError('SYNC_REFERENCE_REQUEST_CONTENT_MISMATCH');

  requireFieldDisposition(response, source.index, 'cloud_object_ref_ids');
  requireFieldDisposition(response, version.index, 'source_id');
  requireFieldDisposition(response, version.index, 'content_hash');
  return {
    tenantId: expected.tenantId,
    workspaceId: expected.workspaceId,
    sourceId: expected.sourceId,
    sourceVersionId: expected.sourceVersionId,
    contentDigest: expected.contentDigest,
    objectRefIds: [...expected.objectRefIds],
    referenceSetDigest: expected.referenceSetDigest,
    idempotencyKey: request.idempotencyKey,
    serverSeq: response.serverSeq,
    sourceChangeId: source.change.id,
    sourceChangeIndex: source.index,
    versionChangeId: version.change.id,
    versionChangeIndex: version.index,
    replayed: response.replayed,
  };
}
