import { describe, expect, it } from 'vitest';
import { cloudBrainSourceVersion, cloudReferenceSetDigest } from '@xyra/contracts';
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

async function finalizedReceipt(overrides: Record<string, unknown> = {}) {
  const data = {
    protocolVersion: 'cloud-ingest-v2' as const,
    status: 'finalized' as const,
    ingestionId: ids.ingestion,
    sourceId: ids.source,
    sourceVersionId: ids.version,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    contentDigest: digest,
    referenceState: 'verified_nonempty' as const,
    objectRefIds: [ids.refA, ids.refB],
    referenceStateVersion: 2,
    finalizedAt: now,
    ...overrides,
  };
  const [referenceSetDigest, sourceVersion] = await Promise.all([
    cloudReferenceSetDigest({
      sourceId: data.sourceId as string,
      sourceVersionId: data.sourceVersionId as string,
      objectRefIds: data.objectRefIds as string[],
    }),
    cloudBrainSourceVersion({
      protocolVersion: data.protocolVersion,
      sourceId: data.sourceId as string,
      sourceVersionId: data.sourceVersionId as string,
      tenantId: data.tenantId as string,
      workspaceId: data.workspaceId as string,
      contentDigest: data.contentDigest as string,
      objectRefIds: data.objectRefIds as string[],
      referenceStateVersion: data.referenceStateVersion as number,
    }),
  ]);
  return { ...data, referenceSetDigest, sourceVersion };
}

function transportReturning(payload: unknown, onRequest?: (path: string, init: unknown) => void) {
  const transport: AuthenticatedCloudTransport = {
    async request(path, init) {
      onRequest?.(path, init);
      return Response.json(payload);
    },
  };
  return transport;
}

function transportSequence(
  payloads: unknown[],
  onRequest?: (path: string, init: unknown) => void,
  uploadBlob?: (request: {
    name: string;
    expiresInSec: number;
    ingestionId: string;
    bytes: Uint8Array;
  }) => Promise<unknown>,
) {
  const transport: AuthenticatedCloudTransport & {
    uploadBlob?: typeof uploadBlob;
  } = {
    async request(path, init) {
      onRequest?.(path, init);
      const payload = payloads.shift();
      return Response.json(payload ?? null);
    },
    ...(uploadBlob ? { uploadBlob } : {}),
  };
  return transport;
}

function beginResult(mode: 'with_objects' | 'text_only' = 'with_objects') {
  return {
    protocolVersion: 'cloud-ingest-v2',
    ingestionId: ids.ingestion,
    sourceId: ids.source,
    tenantId: ids.tenant,
    workspaceId: ids.workspace,
    mode,
    startedAt: now,
  };
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
      transportSequence([beginResult(), await finalizedReceipt()], (path, init) => {
        if (path.endsWith('/finalize')) sent = { path, init };
      }),
    );
    await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'with_objects' });
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
      transportSequence([
        beginResult('text_only'),
        await finalizedReceipt({
          referenceState: 'verified_empty',
          objectRefIds: [],
          referenceStateVersion: 1,
        }),
      ]),
    );
    await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'text_only' });
    await expect(
      client.finalize(ids.ingestion, {
        protocolVersion: 'cloud-ingest-v2',
        sourceVersionId: ids.version,
        contentDigest: digest,
      }),
    ).resolves.toMatchObject({ referenceState: 'verified_empty', objectRefIds: [] });
  });

  it('uploads tracked blob bytes only for a known object-enabled ingestion', async () => {
    const expiresAtMs = Date.now() + 60_000;
    let uploaded: unknown;
    const client = new CloudIngestionClient(
      transportSequence([beginResult()], undefined, async (request) => {
        uploaded = request;
        return { objectRefId: ids.refA, expiresAtMs };
      }),
    );
    await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'with_objects' });
    await expect(
      client.uploadObject(ids.ingestion, {
        name: 'contract.pdf',
        expiresInSec: 60,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toMatchObject({ objectRefId: ids.refA });
    expect(uploaded).toMatchObject({ name: 'contract.pdf', expiresInSec: 60, ingestionId: ids.ingestion });
    await expect(
      client.uploadObject(ids.ingestion, {
        name: '../escape',
        expiresInSec: 60,
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow();
  });

  it('rejects unsorted, duplicate, or inconsistent references in a server receipt', async () => {
    const valid = await finalizedReceipt();
    const base = { ...valid, objectRefIds: [ids.refB, ids.refA] };
    const client = new CloudIngestionClient(transportSequence([beginResult(), base]));
    await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'with_objects' });
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

  it('rejects a swapped receipt id, scope, source, version, or content binding', async () => {
    const cases = [
      { ingestionId: ids.version },
      { tenantId: ids.workspace },
      { workspaceId: ids.tenant },
      { sourceId: ids.version },
      { sourceVersionId: ids.source },
      { contentDigest: 'f'.repeat(64) },
    ];
    for (const altered of cases) {
      const client = new CloudIngestionClient(
        transportSequence([beginResult(), await finalizedReceipt(altered)]),
      );
      await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'with_objects' });
      await expect(
        client.finalize(ids.ingestion, {
          protocolVersion: 'cloud-ingest-v2',
          sourceVersionId: ids.version,
          contentDigest: digest,
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects status receipts that do not match the requested ingestion id or known scope', async () => {
    const swapped = await finalizedReceipt({ ingestionId: ids.version });
    const client = new CloudIngestionClient(
      transportSequence([
        beginResult(),
        {
          protocolVersion: 'cloud-ingest-v2',
          status: 'finalized',
          receipt: swapped,
        },
      ]),
    );
    await client.begin({ protocolVersion: 'cloud-ingest-v2', sourceId: ids.source, mode: 'with_objects' });
    await expect(client.status(ids.ingestion)).rejects.toThrow();
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
