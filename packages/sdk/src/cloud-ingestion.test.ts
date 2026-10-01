import { describe, expect, it } from 'vitest';
import { CloudIngestionClient, type AuthenticatedCloudTransport } from './cloud-ingestion';

const ids = {
  source: '00000000-0000-4000-8000-000000000001',
  ingestion: '00000000-0000-4000-8000-000000000002',
  tenant: '00000000-0000-4000-8000-000000000003',
  workspace: '00000000-0000-4000-8000-000000000004',
  version: '00000000-0000-4000-8000-000000000005',
  refA: '00000000-0000-4000-8000-000000000006',
  refB: '00000000-0000-4000-8000-000000000007',
};
const now = '2026-09-30T12:00:00.000Z';
const digest = 'a'.repeat(64);

function transportReturning(payload: unknown, onRequest?: (path: string, init: unknown) => void) {
  const transport: AuthenticatedCloudTransport = {
    async request(path, init) {
      onRequest?.(path, init);
      return Response.json(payload);
    },
  };
  return transport;
}

describe('CloudIngestionClient', () => {
  it('sends only source and explicit mode at begin; Cloud supplies scope and ingestion id', async () => {
    let sent: { path: string; init: unknown } | undefined;
    const client = new CloudIngestionClient(
      transportReturning(
        {
          protocolVersion: 'cloud-ingest-v2',
          ingestionId: ids.ingestion,
          sourceId: ids.source,
          tenantId: ids.tenant,
          workspaceId: ids.workspace,
          mode: 'with_objects',
          startedAt: now,
        },
        (path, init) => (sent = { path, init }),
      ),
    );
    const result = await client.begin({
      protocolVersion: 'cloud-ingest-v2',
      sourceId: ids.source,
      mode: 'with_objects',
    });
    expect(result.ingestionId).toBe(ids.ingestion);
    expect(sent?.path).toBe('/v2/brain/ingestions');
    expect(JSON.parse((sent?.init as { body: string }).body)).toEqual({
      protocolVersion: 'cloud-ingest-v2',
      sourceId: ids.source,
      mode: 'with_objects',
    });
  });

  it('rejects caller-supplied scope, references, or ingestion id before transport', async () => {
    let requested = false;
    const client = new CloudIngestionClient(
      transportReturning({}, () => {
        requested = true;
      }),
    );
    await expect(
      client.begin({
        protocolVersion: 'cloud-ingest-v2',
        sourceId: ids.source,
        mode: 'text_only',
        tenantId: ids.tenant,
        objectRefIds: [],
      } as never),
    ).rejects.toThrow();
    expect(requested).toBe(false);
  });

  it('finalizes with a source-version content digest, never a caller reference list', async () => {
    let sent: { path: string; init: unknown } | undefined;
    const client = new CloudIngestionClient(
      transportReturning(
        {
          protocolVersion: 'cloud-ingest-v2',
          status: 'finalized',
          ingestionId: ids.ingestion,
          sourceId: ids.source,
          sourceVersionId: ids.version,
          sourceVersion: `cloud-ingest-v2:sha256:${'d'.repeat(64)}`,
          tenantId: ids.tenant,
          workspaceId: ids.workspace,
          contentDigest: digest,
          referenceState: 'verified_nonempty',
          objectRefIds: [ids.refA, ids.refB],
          referenceSetDigest: 'b'.repeat(64),
          referenceStateVersion: 2,
          finalizedAt: now,
        },
        (path, init) => (sent = { path, init }),
      ),
    );
    const receipt = await client.finalize(ids.ingestion, {
      protocolVersion: 'cloud-ingest-v2',
      sourceVersionId: ids.version,
      contentDigest: digest,
    });
    expect(receipt.referenceState).toBe('verified_nonempty');
    expect(sent?.path).toBe(`/v2/brain/ingestions/${ids.ingestion}/finalize`);
    expect(JSON.parse((sent?.init as { body: string }).body)).toEqual({
      protocolVersion: 'cloud-ingest-v2',
      sourceVersionId: ids.version,
      contentDigest: digest,
    });
  });

  it('allows verified-empty only for an empty normalized reference set', async () => {
    const client = new CloudIngestionClient(
      transportReturning({
        protocolVersion: 'cloud-ingest-v2',
        status: 'finalized',
        ingestionId: ids.ingestion,
        sourceId: ids.source,
        sourceVersionId: ids.version,
        sourceVersion: `cloud-ingest-v2:sha256:${'d'.repeat(64)}`,
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        contentDigest: digest,
        referenceState: 'verified_empty',
        objectRefIds: [],
        referenceSetDigest: 'c'.repeat(64),
        referenceStateVersion: 1,
        finalizedAt: now,
      }),
    );
    await expect(
      client.finalize(ids.ingestion, {
        protocolVersion: 'cloud-ingest-v2',
        sourceVersionId: ids.version,
        contentDigest: digest,
      }),
    ).resolves.toMatchObject({ referenceState: 'verified_empty', objectRefIds: [] });
  });

  it('rejects unsorted, duplicate, or inconsistent references in a server receipt', async () => {
    const base = {
      protocolVersion: 'cloud-ingest-v2',
      status: 'finalized',
      ingestionId: ids.ingestion,
      sourceId: ids.source,
      sourceVersionId: ids.version,
      sourceVersion: `cloud-ingest-v2:sha256:${'d'.repeat(64)}`,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      contentDigest: digest,
      referenceState: 'verified_nonempty',
      objectRefIds: [ids.refB, ids.refA],
      referenceSetDigest: 'b'.repeat(64),
      referenceStateVersion: 2,
      finalizedAt: now,
    };
    const client = new CloudIngestionClient(transportReturning(base));
    await expect(
      client.finalize(ids.ingestion, {
        protocolVersion: 'cloud-ingest-v2',
        sourceVersionId: ids.version,
        contentDigest: digest,
      }),
    ).rejects.toThrow();
  });

  it('looks up status through authenticated transport and preserves invalidation as non-proof', async () => {
    const client = new CloudIngestionClient(
      transportReturning({
        protocolVersion: 'cloud-ingest-v2',
        status: 'invalidated',
        ingestionId: ids.ingestion,
        sourceId: ids.source,
        sourceVersionId: ids.version,
        invalidatedAt: now,
      }),
    );
    await expect(client.status(ids.ingestion)).resolves.toMatchObject({ status: 'invalidated' });
  });

  it('maps non-success responses to a code-only request error', async () => {
    const transport: AuthenticatedCloudTransport = {
      async request() {
        return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });
      },
    };
    const client = new CloudIngestionClient(transport);
    await expect(
      client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'text_only' }),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
  });
});
