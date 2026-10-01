import { describe, expect, it } from 'vitest';
import { compareHlc, encodeHlc, MAX_DRIFT_MS } from '@xyra/core';
import { cloudReferenceSetDigest } from './erasure';
import {
  HLC_PATTERN,
  MAX_HLC_DRIFT_MS,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  assertPushResponseBoundToRequest,
  SyncUpdateRequired,
} from './sync';
import { assertBrainReferenceSyncAcknowledgement } from './sync-ack';

const tenantId = '019a0000-0000-7000-8000-000000000001';
const workspaceId = '019a0000-0000-7000-8000-000000000011';
const hlc = encodeHlc({ ms: 1_790_000_000_000, counter: 3, node: 'devicea' });
const change = {
  table: 'ops_tasks',
  id: '019a0000-0000-7000-8000-000000000101',
  tenantId,
  workspaceId,
  op: 'upsert',
  fields: { title: { value: 'Ship', hlc, baseHlc: null } },
  hlc,
} as const;
const versions = { protocolVersion: 1, schemaVersion: 'cloud-sync-v1' } as const;
const push = {
  protocolVersion: 1,
  schemaVersion: 'cloud-sync-v1',
  nodeId: 'devicea',
  idempotencyKey: 'push-0000000000000001',
  changes: [change],
};

describe('cloud-sync-v1 wire contract', () => {
  it('accepts clocks produced by the shared HLC encoder, in code-point order', () => {
    expect(HLC_PATTERN.test(hlc)).toBe(true);
    expect(MAX_HLC_DRIFT_MS).toBe(MAX_DRIFT_MS);
    const later = encodeHlc({ ms: 1_790_000_000_000, counter: 3, node: 'deviceb' });
    expect(compareHlc(hlc, later)).toBeLessThan(0);
  });

  it('requires protocol, schema version and an idempotency key', () => {
    expect(PushRequest.parse(push).changes).toHaveLength(1);
    expect(() => PushRequest.parse({ ...push, protocolVersion: 2 })).toThrow();
    expect(() => PushRequest.parse({ ...push, schemaVersion: 'cloud-sync-v0' })).toThrow();
    expect(() => PushRequest.parse({ ...push, idempotencyKey: 'short' })).toThrow();
    expect(() =>
      PushRequest.parse({ ...push, changes: [{ ...change, hlc: '2026-09-30T00:00:00Z' }] }),
    ).toThrow();
  });

  it('carries per-row rejections, conflict history and decimal sequence numbers', () => {
    const response = PushResponse.parse({
      accepted: 0,
      conflicts: 0,
      serverSeq: '18446744073709551615',
      rejected: [{ index: 0, changeId: change.id, code: 'KILL_SWITCH_ENGAGED' }],
      conflictHistory: [],
      changeOutcomes: [{
        index: 0,
        changeId: change.id,
        table: change.table,
        rowId: change.id,
        outcome: 'rejected',
        appliedFields: [],
        unchangedFields: [],
        conflictedFields: [],
        rejectionCode: 'KILL_SWITCH_ENGAGED',
      }],
      replayed: false,
    });
    expect(response.rejected[0]?.code).toBe('KILL_SWITCH_ENGAGED');
    assertPushResponseBoundToRequest(PushRequest.parse(push), response);
    const legacy = PushResponse.parse({
      accepted: 0, conflicts: 0, serverSeq: '0', rejected: [], conflictHistory: [], replayed: false,
    });
    expect(() => assertPushResponseBoundToRequest(PushRequest.parse(push), legacy)).toThrow('SYNC_OUTCOME_COVERAGE_MISMATCH');
    expect(() =>
      PullResponse.parse({ ...versions, changes: [], cursor: '', more: false, serverSeq: '0' }),
    ).toThrow();
    expect(
      PullResponse.parse({
        ...versions,
        changes: [{ seq: '1', change }],
        cursor: 'djE6MQ',
        more: false,
        serverSeq: '1',
      }).changes[0]?.seq,
    ).toBe('1');
  });

  it('binds every committed field outcome to the exact push request', () => {
    const request = PushRequest.parse(push);
    const response = PushResponse.parse({
      accepted: 1,
      conflicts: 0,
      serverSeq: '42',
      rejected: [],
      conflictHistory: [],
      changeOutcomes: [{
        index: 0,
        changeId: change.id,
        table: change.table,
        rowId: change.id,
        outcome: 'committed',
        appliedFields: ['title'],
        unchangedFields: [],
        conflictedFields: [],
      }],
      replayed: false,
    });
    expect(() => assertPushResponseBoundToRequest(request, response)).not.toThrow();
    expect(() => assertPushResponseBoundToRequest(request, {
      ...response,
      changeOutcomes: [{ ...response.changeOutcomes![0]!, rowId: '019a0000-0000-7000-8000-000000000999' }],
    })).toThrow('SYNC_OUTCOME_REQUEST_MISMATCH');
    expect(() => assertPushResponseBoundToRequest(request, {
      ...response,
      changeOutcomes: [{ ...response.changeOutcomes![0]!, appliedFields: [], unchangedFields: ['title'] }],
    })).toThrow();
    expect(() => assertPushResponseBoundToRequest(request, { ...response, accepted: 0 })).toThrow('SYNC_ACCEPTED_COUNT_MISMATCH');
  });

  it('rejects ambiguous or overlapping field dispositions', () => {
    const outcome = {
      index: 0,
      changeId: change.id,
      table: change.table,
      rowId: change.id,
      outcome: 'committed',
      appliedFields: ['title'],
      unchangedFields: ['title'],
      conflictedFields: [],
    };
    expect(() => PushResponse.parse({
      accepted: 1, conflicts: 0, serverSeq: '1', rejected: [], conflictHistory: [],
      changeOutcomes: [outcome], replayed: false,
    })).toThrow();
  });
});

describe('version negotiation (CLD-R-009)', () => {
  it('parses the pull query and rejects foreign versions', () => {
    expect(
      PullRequest.parse({ protocolVersion: '1', schemaVersion: 'cloud-sync-v1', limit: '10' }).limit,
    ).toBe(10);
    expect(() => PullRequest.parse({ protocolVersion: '2', schemaVersion: 'cloud-sync-v1' })).toThrow();
    expect(() => PullRequest.parse({ schemaVersion: 'cloud-sync-v1' })).toThrow();
    expect(SyncUpdateRequired.parse({ code: 'UPDATE_REQUIRED', ...versions }).code).toBe('UPDATE_REQUIRED');
    expect(() => PullResponse.parse({ changes: [], cursor: 'x', more: false, serverSeq: '0' })).toThrow();
  });
});

describe('BRAIN reference push acknowledgement', () => {
  const sourceId = '019a0000-0000-7000-8000-000000000201';
  const versionId = '019a0000-0000-7000-8000-000000000202';
  const refIds = ['019a0000-0000-7000-8000-000000000203', '019a0000-0000-7000-8000-000000000204'];
  const contentDigest = 'a'.repeat(64);

  function brainPush() {
    return PushRequest.parse({
      protocolVersion: 1,
      schemaVersion: 'cloud-sync-v1',
      nodeId: 'devicea',
      idempotencyKey: 'brain-ref-sync-000001',
      changes: [
        {
          table: 'brain_sources', id: sourceId, tenantId, workspaceId, op: 'upsert', hlc,
          fields: { cloud_object_ref_ids: { value: refIds, hlc, baseHlc: null } },
        },
        {
          table: 'brain_source_versions', id: versionId, tenantId, workspaceId, op: 'append', hlc,
          fields: {
            source_id: { value: sourceId, hlc, baseHlc: null },
            content_hash: { value: contentDigest, hlc, baseHlc: null },
          },
        },
      ],
    });
  }

  it('acknowledges only exact scoped source refs and matching immutable source version', async () => {
    const request = brainPush();
    const referenceSetDigest = await cloudReferenceSetDigest({ sourceId, sourceVersionId: versionId, objectRefIds: refIds });
    const response = PushResponse.parse({
      accepted: 2, conflicts: 0, serverSeq: '42', rejected: [], conflictHistory: [], replayed: false,
      changeOutcomes: [
        { index: 0, changeId: sourceId, table: 'brain_sources', rowId: sourceId, outcome: 'committed', appliedFields: ['cloud_object_ref_ids'], unchangedFields: [], conflictedFields: [] },
        { index: 1, changeId: versionId, table: 'brain_source_versions', rowId: versionId, outcome: 'committed', appliedFields: ['content_hash', 'source_id'], unchangedFields: [], conflictedFields: [] },
      ],
    });
    await expect(assertBrainReferenceSyncAcknowledgement(request, response, {
      tenantId, workspaceId, sourceId, sourceVersionId: versionId, contentDigest, objectRefIds: refIds, referenceSetDigest,
    })).resolves.toMatchObject({ sourceId, sourceVersionId: versionId, serverSeq: '42', idempotencyKey: request.idempotencyKey });
    await expect(assertBrainReferenceSyncAcknowledgement(request, response, {
      tenantId, workspaceId: '019a0000-0000-7000-8000-000000000099', sourceId,
      sourceVersionId: versionId, contentDigest, objectRefIds: refIds, referenceSetDigest,
    })).rejects.toThrow('SYNC_REFERENCE_ROWS_MISSING_OR_AMBIGUOUS');
  });

  it('keeps a partial HLC loser pending even when another row in the batch committed', async () => {
    const request = brainPush();
    const referenceSetDigest = await cloudReferenceSetDigest({ sourceId, sourceVersionId: versionId, objectRefIds: refIds });
    const response = PushResponse.parse({
      accepted: 1, conflicts: 1, serverSeq: '43', rejected: [], conflictHistory: [], replayed: false,
      changeOutcomes: [
        { index: 0, changeId: sourceId, table: 'brain_sources', rowId: sourceId, outcome: 'conflict', appliedFields: [], unchangedFields: [], conflictedFields: ['cloud_object_ref_ids'] },
        { index: 1, changeId: versionId, table: 'brain_source_versions', rowId: versionId, outcome: 'committed', appliedFields: ['content_hash', 'source_id'], unchangedFields: [], conflictedFields: [] },
      ],
    });
    await expect(assertBrainReferenceSyncAcknowledgement(request, response, {
      tenantId, workspaceId, sourceId, sourceVersionId: versionId, contentDigest, objectRefIds: refIds, referenceSetDigest,
    })).rejects.toThrow('SYNC_REFERENCE_FIELD_NOT_COMMITTED');
  });
});
