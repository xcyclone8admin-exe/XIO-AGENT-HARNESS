import { describe, expect, it } from 'vitest';
import {
  AbortErasureRequest,
  blobReferenceSnapshotDigest,
  CloudIngestionFinalizeRequest,
  CloudIngestionFinalizationReceipt,
  CloudIngestionStatus,
  CloudIngestionStartRequest,
  erasureSourceSnapshotVersion,
  BeginErasureRequest,
  ClaimLocalPurgeRequest,
  LocalPurgeAckRequest,
  sourceVersionDigest,
  sourceVersionFromSyncedRows,
} from './erasures';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const VERSION_A = '22222222-2222-4222-8222-222222222222';
const VERSION_B = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = '55555555-5555-4555-8555-555555555555';

describe('Cloud/BRAIN erasure wire and source snapshot', () => {
  it('canonicalizes BRAIN source versions in numeric-version then lexical-id order', async () => {
    const first = await sourceVersionDigest({
      sourceId: SOURCE,
      versions: [
        { id: VERSION_B, version: 10, contentHash: 'b'.repeat(64) },
        { id: VERSION_A, version: 2, contentHash: 'a'.repeat(64) },
      ],
    });
    const reordered = await sourceVersionDigest({
      versions: [
        { contentHash: 'a'.repeat(64), version: 2, id: VERSION_A },
        { contentHash: 'b'.repeat(64), version: 10, id: VERSION_B },
      ],
      sourceId: SOURCE,
    });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toBe(reordered);
  });

  it('fails closed on missing, deleted, or malformed synced source/version rows', async () => {
    await expect(sourceVersionFromSyncedRows(SOURCE, undefined, [])).rejects.toThrow(
      'SOURCE_STATE_UNAVAILABLE',
    );
    await expect(sourceVersionFromSyncedRows(SOURCE, { fields: {}, deleted: true }, [])).rejects.toThrow(
      'SOURCE_STATE_UNAVAILABLE',
    );
    await expect(
      sourceVersionFromSyncedRows(SOURCE, { fields: {}, deleted: false }, [{ id: VERSION_A, fields: {}, deleted: false }]),
    ).rejects.toThrow('SOURCE_STATE_UNAVAILABLE');
    await expect(
      sourceVersionFromSyncedRows(
        SOURCE,
        { fields: {}, deleted: false },
        [{ id: VERSION_A, fields: { version: { value: 1 }, content_hash: { value: 'a'.repeat(64) } }, deleted: true }],
      ),
    ).rejects.toThrow('SOURCE_STATE_UNAVAILABLE');
  });

  it('accepts only the versioned public fields and rejects caller-supplied authority', () => {
    const base = {
      protocolVersion: 'cloud-erasure-v1',
      erasureId: OPERATION,
      attemptId: ATTEMPT,
      approvalId: ATTEMPT,
      source: { kind: 'brain_source', id: SOURCE },
      sourceVersion: `cloud-ingest-v2:sha256:${'0'.repeat(64)}`,
    };
    expect(BeginErasureRequest.safeParse(base).success).toBe(true);
    expect(
      BeginErasureRequest.safeParse({ ...base, tenantId: SOURCE, approvalVerified: true }).success,
    ).toBe(false);
    expect(
      ClaimLocalPurgeRequest.safeParse({
        protocolVersion: 'cloud-erasure-v1',
        attemptId: ATTEMPT,
        reservationId: OPERATION,
        purgeAllowed: true,
      }).success,
    ).toBe(false);
    expect(
      LocalPurgeAckRequest.safeParse({
        protocolVersion: 'cloud-erasure-v1',
        attemptId: ATTEMPT,
        claimId: OPERATION,
        claimGeneration: 1,
        localPurgeReceiptId: ATTEMPT,
        localPurgeReceiptDigest: 'a'.repeat(64),
        sourceVersion: `cloud-ingest-v2:sha256:${'0'.repeat(64)}`,
        tenantId: SOURCE,
      }).success,
    ).toBe(false);
    expect(
      AbortErasureRequest.safeParse({
        protocolVersion: 'cloud-erasure-v1',
        attemptId: ATTEMPT,
        claimId: OPERATION,
        abortReceiptId: ATTEMPT,
        abortReceiptDigest: 'b'.repeat(64),
      }).success,
    ).toBe(true);
  });

  it('canonicalizes complete Cloud object snapshots and rejects duplicate object identities', async () => {
    const one = '66666666-6666-4666-8666-666666666666';
    const two = '77777777-7777-4777-8777-777777777777';
    expect(await blobReferenceSnapshotDigest(SOURCE, VERSION_A, [one, two]))
      .toBe(await blobReferenceSnapshotDigest(SOURCE, VERSION_A, [two, one]));
    expect(await blobReferenceSnapshotDigest(SOURCE, VERSION_A, [one, two]))
      .not.toBe(await blobReferenceSnapshotDigest(SOURCE, VERSION_B, [one, two]));
    await expect(blobReferenceSnapshotDigest(SOURCE, VERSION_A, [one, one]))
      .rejects.toThrow('DUPLICATE_OBJECT_REFERENCE');
    const referenceDigest = await blobReferenceSnapshotDigest(SOURCE, VERSION_A, [one, two]);
    const expectedRefBody = JSON.stringify({ objectRefIds: [one, two], sourceId: SOURCE, sourceVersionId: VERSION_A });
    const expectedRefHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expectedRefBody)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(referenceDigest).toBe(expectedRefHash);
    expect(referenceDigest).toMatch(/^[0-9a-f]{64}$/);
    const digestOne = await erasureSourceSnapshotVersion(SOURCE, VERSION_A, OPERATION, ATTEMPT, 'a'.repeat(64), [one, two], 1);
    expect(digestOne).toBe(await erasureSourceSnapshotVersion(SOURCE, VERSION_A, OPERATION, ATTEMPT, 'a'.repeat(64), [two, one], 1));
    expect(digestOne).not.toBe(await erasureSourceSnapshotVersion(SOURCE, VERSION_A, OPERATION, ATTEMPT, 'a'.repeat(64), [two, one], 2));
    expect(digestOne).toMatch(/^cloud-ingest-v2:sha256:[0-9a-f]{64}$/);
    const sourceVersionBody = JSON.stringify({ contentDigest: 'a'.repeat(64), objectRefIds: [one, two],
      protocolVersion: 'cloud-ingest-v2', referenceStateVersion: 1, sourceId: SOURCE,
      sourceVersionId: VERSION_A, tenantId: OPERATION, workspaceId: ATTEMPT });
    const expectedSourceVersionHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceVersionBody)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(digestOne).toBe(`cloud-ingest-v2:sha256:${expectedSourceVersionHash}`);
    expect(CloudIngestionStartRequest.safeParse({ protocolVersion: 'cloud-ingest-v2', sourceId: SOURCE, mode: 'text_only' }).success).toBe(true);
    expect(CloudIngestionStartRequest.parse({ protocolVersion: 'cloud-ingest-v2', sourceId: SOURCE.toUpperCase(), mode: 'text_only' }).sourceId).toBe(SOURCE);
    expect(CloudIngestionStartRequest.safeParse({ protocolVersion: 'cloud-ingest-v2', sourceId: SOURCE, mode: 'text_only', ingestionId: OPERATION }).success).toBe(false);
    expect(CloudIngestionFinalizeRequest.safeParse({ protocolVersion: 'cloud-ingest-v2', sourceVersionId: VERSION_A, contentDigest: 'a'.repeat(64), objectRefIds: [] }).success).toBe(false);
    expect(CloudIngestionFinalizeRequest.safeParse({ protocolVersion: 'cloud-ingest-v2', sourceVersionId: VERSION_A, contentDigest: `sha256:${'a'.repeat(64)}` }).success).toBe(false);
    const receipt = { protocolVersion: 'cloud-ingest-v2', ingestionId: OPERATION, tenantId: OPERATION,
      workspaceId: ATTEMPT, sourceId: SOURCE, sourceVersionId: VERSION_A, contentDigest: 'a'.repeat(64),
      sourceVersion: digestOne, referenceState: 'verified_nonempty', objectRefIds: [one, two],
      referenceSetDigest: 'b'.repeat(64), referenceStateVersion: 1, finalizedAt: new Date().toISOString(), status: 'finalized' };
    expect(CloudIngestionFinalizationReceipt.safeParse(receipt).success).toBe(true);
    expect(CloudIngestionFinalizationReceipt.safeParse({ ...receipt, objectRefIds: [two, one] }).success).toBe(false);
    expect(CloudIngestionFinalizationReceipt.safeParse({ ...receipt, referenceSetDigest: `sha256:${'b'.repeat(64)}` }).success).toBe(false);
    expect(CloudIngestionStatus.safeParse({ protocolVersion: 'cloud-ingest-v2', status: 'pending', ingestionId: OPERATION,
      sourceId: SOURCE, tenantId: OPERATION, workspaceId: ATTEMPT, mode: 'text_only', startedAt: new Date().toISOString() }).success).toBe(true);
    expect(CloudIngestionStatus.safeParse({ protocolVersion: 'cloud-ingest-v2', status: 'finalized', receipt }).success).toBe(true);
    expect(CloudIngestionStatus.safeParse({ protocolVersion: 'cloud-ingest-v2', status: 'invalidated', ingestionId: OPERATION, sourceId: SOURCE,
      sourceVersionId: VERSION_A, invalidatedAt: new Date().toISOString() }).success).toBe(true);
    expect(CloudIngestionStatus.safeParse({ protocolVersion: 'cloud-ingest-v2', status: 'pending', ingestionId: OPERATION, sourceId: SOURCE,
      startedAt: new Date().toISOString(), tenantId: ATTEMPT }).success).toBe(false);
  });
});
