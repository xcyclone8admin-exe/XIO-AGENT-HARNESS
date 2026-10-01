import { describe, expect, it } from 'vitest';
import { cloudReferenceSetDigest, type PushRequest } from '@xyra/contracts';
import { CloudSyncOutcomeUnknownError, CloudSyncPushClient } from './cloud-sync';
import type { AuthenticatedCloudTransport } from './cloud-ingestion';

const ids = {
  tenant: '019a0000-0000-7000-8000-000000000301',
  workspace: '019a0000-0000-7000-8000-000000000302',
  source: '019a0000-0000-7000-8000-000000000303',
  version: '019a0000-0000-7000-8000-000000000304',
  refA: '019a0000-0000-7000-8000-000000000305',
  refB: '019a0000-0000-7000-8000-000000000306',
};
const digest = 'b'.repeat(64);
const hlc = '1790000000000-0003-devicea';

const request = {
  protocolVersion: 1,
  schemaVersion: 'cloud-sync-v1',
  nodeId: 'devicea',
  idempotencyKey: 'brain-sync-0000000001',
  changes: [
    {
      table: 'brain_sources', id: ids.source, tenantId: ids.tenant, workspaceId: ids.workspace, op: 'upsert', hlc,
      fields: { cloud_object_ref_ids: { value: [ids.refA, ids.refB], hlc, baseHlc: null } },
    },
    {
      table: 'brain_source_versions', id: ids.version, tenantId: ids.tenant, workspaceId: ids.workspace, op: 'append', hlc,
      fields: {
        source_id: { value: ids.source, hlc, baseHlc: null },
        content_hash: { value: digest, hlc, baseHlc: null },
      },
    },
  ],
} as const;

function successOutcome(overrides: Record<string, unknown> = {}) {
  return {
    accepted: 2,
    conflicts: 0,
    serverSeq: '51',
    rejected: [],
    conflictHistory: [],
    changeOutcomes: [
      {
        index: 0, changeId: ids.source, table: 'brain_sources', rowId: ids.source, outcome: 'committed',
        appliedFields: ['cloud_object_ref_ids'], unchangedFields: [], conflictedFields: [],
      },
      {
        index: 1, changeId: ids.version, table: 'brain_source_versions', rowId: ids.version, outcome: 'committed',
        appliedFields: ['content_hash', 'source_id'], unchangedFields: [], conflictedFields: [],
      },
    ],
    replayed: false,
    ...overrides,
  };
}

async function expectation() {
  const objectRefIds = [ids.refA, ids.refB];
  return {
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    sourceId: ids.source,
    sourceVersionId: ids.version,
    contentDigest: digest,
    objectRefIds,
    referenceSetDigest: await cloudReferenceSetDigest({ sourceId: ids.source, sourceVersionId: ids.version, objectRefIds }),
  };
}

describe('CloudSyncPushClient', () => {
  it('returns acknowledgement only after exact source and version rows are confirmed', async () => {
    let called: { path: string; method: string; body: unknown } | undefined;
    const transport: AuthenticatedCloudTransport = {
      async request(path, init) {
        called = { path, method: init.method, body: JSON.parse(init.body ?? 'null') };
        return Response.json(successOutcome());
      },
    };
    const client = new CloudSyncPushClient(transport);
    const ack = await client.pushAndAcknowledgeBrainReferences(request as unknown as PushRequest, await expectation());
    expect(called?.path).toBe('/v1/sync/push');
    expect(called?.method).toBe('POST');
    expect((called?.body as { idempotencyKey: string }).idempotencyKey).toBe(request.idempotencyKey);
    expect(ack).toMatchObject({ sourceId: ids.source, sourceVersionId: ids.version, serverSeq: '51' });
  });

  it('replays the exact idempotent request after a transport loss', async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const client = new CloudSyncPushClient({
      async request(_path, init) {
        calls += 1;
        bodies.push(JSON.parse(init.body ?? 'null'));
        if (calls === 1) throw new Error('response connection lost');
        return Response.json(successOutcome({ replayed: true }));
      },
    });
    const ack = await client.pushAndAcknowledgeBrainReferences(request as unknown as PushRequest, await expectation());
    expect(calls).toBe(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(ack.replayed).toBe(true);
  });

  it('keeps rejected, conflicted, aggregate-only, or wrong-reference results unacknowledged', async () => {
    const conflicted = successOutcome({
      accepted: 1,
      conflicts: 1,
      changeOutcomes: [
        { index: 0, changeId: ids.source, table: 'brain_sources', rowId: ids.source, outcome: 'conflict', appliedFields: [], unchangedFields: [], conflictedFields: ['cloud_object_ref_ids'] },
        successOutcome().changeOutcomes[1],
      ],
    });
    const client = new CloudSyncPushClient({ async request() { return Response.json(conflicted); } });
    await expect(client.pushAndAcknowledgeBrainReferences(request as unknown as PushRequest, await expectation()))
      .rejects.toThrow('SYNC_REFERENCE_FIELD_NOT_COMMITTED');

    const legacyClient = new CloudSyncPushClient({
      async request() { return Response.json({ accepted: 2, conflicts: 0, serverSeq: '51', rejected: [], conflictHistory: [], replayed: false }); },
    });
    await expect(legacyClient.push(request as unknown as PushRequest)).rejects.toThrow('CLOUD_SYNC_OUTCOME_UNKNOWN');

    const changedRefs = await expectation();
    changedRefs.objectRefIds = [ids.refB];
    changedRefs.referenceSetDigest = await cloudReferenceSetDigest({
      sourceId: ids.source,
      sourceVersionId: ids.version,
      objectRefIds: changedRefs.objectRefIds,
    });
    await expect(client.pushAndAcknowledgeBrainReferences(request as unknown as PushRequest, changedRefs))
      .rejects.toThrow('SYNC_REFERENCE_REQUEST_CONTENT_MISMATCH');
  });

  it('leaves uncertain state pending after repeated transport failure', async () => {
    const client = new CloudSyncPushClient({ async request() { throw new Error('offline'); } });
    await expect(client.push(request as unknown as PushRequest)).rejects.toBeInstanceOf(CloudSyncOutcomeUnknownError);
  });
});
