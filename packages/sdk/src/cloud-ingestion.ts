import {
  CloudBrainIngestionBeginRequest,
  CloudBrainIngestionBeginResult,
  CloudBrainIngestionFinalizeRequest,
  CloudBrainIngestionFinalizationReceipt,
  CloudBrainIngestionStatus,
  CloudBlobReferenceIssueRequest,
  CloudBlobUploadResult,
  cloudBrainSourceVersion,
  cloudReferenceSetDigest,
  type CloudBrainIngestionFinalizationReceipt as FinalizationReceipt,
  type CloudBrainIngestionBeginRequest as BeginInput,
  type CloudBrainIngestionFinalizeRequest as FinalizeInput,
} from '@xyra/contracts';

/**
 * App-owned adapter that sends requests with the active product JWT+DPoP session.
 * It must not accept caller-provided authorization headers or treat local CapabilityBus
 * context as remote authentication. No raw credential is held by this SDK client.
 */
export interface AuthenticatedCloudTransport {
  request(
    path: string,
    init: { method: 'GET' | 'POST'; headers?: { 'content-type': 'application/json' }; body?: string },
  ): Promise<Response>;
}

export interface AuthenticatedCloudBlobTransport {
  uploadBlob(request: {
    name: string;
    expiresInSec: number;
    ingestionId: string;
    bytes: Uint8Array;
  }): Promise<unknown>;
}

export class CloudIngestionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'CloudIngestionRequestError';
  }
}

export class CloudIngestionBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CloudIngestionBindingError';
  }
}

export interface ExpectedCloudIngestionBinding {
  ingestionId: string;
  sourceId: string;
  sourceVersionId: string;
  tenantId: string;
  workspaceId: string;
  contentDigest: string;
}

/** Validate a finalized receipt against caller-held source/scope expectations before use. */
export async function assertCloudIngestionReceiptBinding(
  receipt: FinalizationReceipt,
  expected: ExpectedCloudIngestionBinding,
): Promise<void> {
  if (
    receipt.ingestionId !== expected.ingestionId ||
    receipt.sourceId !== expected.sourceId ||
    receipt.sourceVersionId !== expected.sourceVersionId ||
    receipt.tenantId !== expected.tenantId ||
    receipt.workspaceId !== expected.workspaceId ||
    receipt.contentDigest !== expected.contentDigest
  ) {
    throw new CloudIngestionBindingError('INGESTION_RECEIPT_BINDING_MISMATCH');
  }
  const [referenceSetDigest, sourceVersion] = await Promise.all([
    cloudReferenceSetDigest({
      sourceId: receipt.sourceId,
      sourceVersionId: receipt.sourceVersionId,
      objectRefIds: receipt.objectRefIds,
    }),
    cloudBrainSourceVersion({
      protocolVersion: receipt.protocolVersion,
      sourceId: receipt.sourceId,
      sourceVersionId: receipt.sourceVersionId,
      tenantId: receipt.tenantId,
      workspaceId: receipt.workspaceId,
      contentDigest: receipt.contentDigest,
      objectRefIds: receipt.objectRefIds,
      referenceStateVersion: receipt.referenceStateVersion,
    }),
  ]);
  if (receipt.referenceSetDigest !== referenceSetDigest || receipt.sourceVersion !== sourceVersion) {
    throw new CloudIngestionBindingError('INGESTION_RECEIPT_DIGEST_MISMATCH');
  }
}

/** Typed client for Cloud-owned source-ingestion provenance and reference finalization. */
export class CloudIngestionClient {
  private readonly knownIngestions = new Map<
    string,
    ReturnType<typeof CloudBrainIngestionBeginResult.parse>
  >();
  private readonly knownFinalizations = new Map<string, { sourceVersionId: string; contentDigest: string }>();

  constructor(private readonly transport: AuthenticatedCloudTransport) {}

  async begin(input: BeginInput): Promise<ReturnType<typeof CloudBrainIngestionBeginResult.parse>> {
    const body = CloudBrainIngestionBeginRequest.parse(input);
    const result = await this.request('/v2/brain/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = CloudBrainIngestionBeginResult.parse(result);
    if (parsed.sourceId !== body.sourceId || parsed.mode !== body.mode) {
      throw new CloudIngestionBindingError('INGESTION_BEGIN_BINDING_MISMATCH');
    }
    this.knownIngestions.set(parsed.ingestionId, parsed);
    return parsed;
  }

  async finalize(
    ingestionId: string,
    input: FinalizeInput,
  ): Promise<ReturnType<typeof CloudBrainIngestionFinalizationReceipt.parse>> {
    const id = CloudBrainIngestionBeginResult.shape.ingestionId.parse(ingestionId);
    const body = CloudBrainIngestionFinalizeRequest.parse(input);
    const result = await this.request(`/v2/brain/ingestions/${encodeURIComponent(id)}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const receipt = CloudBrainIngestionFinalizationReceipt.parse(result);
    const known = this.knownIngestions.get(id);
    if (!known) throw new CloudIngestionBindingError('INGESTION_BEGIN_CONTEXT_REQUIRED');
    await assertCloudIngestionReceiptBinding(receipt, {
      ingestionId: id,
      sourceId: known.sourceId,
      sourceVersionId: body.sourceVersionId,
      tenantId: known.tenantId,
      workspaceId: known.workspaceId,
      contentDigest: body.contentDigest,
    });
    this.knownFinalizations.set(id, {
      sourceVersionId: body.sourceVersionId,
      contentDigest: body.contentDigest,
    });
    return receipt;
  }

  async uploadObject(
    ingestionId: string,
    input: { name: string; expiresInSec: number; bytes: Uint8Array },
  ): Promise<ReturnType<typeof CloudBlobUploadResult.parse>> {
    const id = CloudBrainIngestionBeginResult.shape.ingestionId.parse(ingestionId);
    const known = this.knownIngestions.get(id);
    if (!known) throw new CloudIngestionBindingError('INGESTION_BEGIN_CONTEXT_REQUIRED');
    if (known.mode !== 'with_objects')
      throw new CloudIngestionBindingError('INGESTION_MODE_DOES_NOT_ALLOW_OBJECTS');
    const request = CloudBlobReferenceIssueRequest.parse({
      mode: 'PUT',
      name: input.name,
      expiresInSec: input.expiresInSec,
      ingestionId: id,
    });
    if (input.bytes.byteLength > 10 * 1024 * 1024) throw new RangeError('CLOUD_BLOB_TOO_LARGE');
    const blobTransport = this.transport as AuthenticatedCloudTransport &
      Partial<AuthenticatedCloudBlobTransport>;
    if (typeof blobTransport.uploadBlob !== 'function') throw new Error('CLOUD_BLOB_UPLOAD_UNAVAILABLE');
    const result = CloudBlobUploadResult.parse(
      await blobTransport.uploadBlob({
        name: request.name,
        expiresInSec: request.expiresInSec,
        ingestionId: request.ingestionId,
        bytes: input.bytes,
      }),
    );
    const now = Date.now();
    if (result.expiresAtMs <= now || result.expiresAtMs > now + request.expiresInSec * 1000 + 5_000) {
      throw new CloudIngestionBindingError('BLOB_REFERENCE_EXPIRY_INVALID');
    }
    return result;
  }

  async status(ingestionId: string): Promise<ReturnType<typeof CloudBrainIngestionStatus.parse>> {
    const id = CloudBrainIngestionBeginResult.shape.ingestionId.parse(ingestionId);
    const status = CloudBrainIngestionStatus.parse(
      await this.request(`/v2/brain/ingestions/${encodeURIComponent(id)}`, { method: 'GET' }),
    );
    if (status.status === 'finalized') {
      const known = this.knownIngestions.get(id);
      if (!known) throw new CloudIngestionBindingError('INGESTION_BEGIN_CONTEXT_REQUIRED');
      const finalized = this.knownFinalizations.get(id);
      await assertCloudIngestionReceiptBinding(status.receipt, {
        ingestionId: id,
        sourceId: known.sourceId,
        sourceVersionId: finalized?.sourceVersionId ?? status.receipt.sourceVersionId,
        tenantId: known.tenantId,
        workspaceId: known.workspaceId,
        contentDigest: finalized?.contentDigest ?? status.receipt.contentDigest,
      });
    } else if (status.ingestionId !== id) {
      throw new CloudIngestionBindingError('INGESTION_STATUS_ID_MISMATCH');
    }
    const known = this.knownIngestions.get(id);
    if (known && status.status === 'pending') {
      if (
        status.sourceId !== known.sourceId ||
        status.tenantId !== known.tenantId ||
        status.workspaceId !== known.workspaceId ||
        status.mode !== known.mode
      ) {
        throw new CloudIngestionBindingError('INGESTION_STATUS_BINDING_MISMATCH');
      }
    } else if (known && status.status === 'invalidated' && status.sourceId !== known.sourceId) {
      throw new CloudIngestionBindingError('INGESTION_STATUS_BINDING_MISMATCH');
    }
    return status;
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; headers?: { 'content-type': 'application/json' }; body?: string },
  ): Promise<unknown> {
    const response = await this.transport.request(path, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code =
        typeof payload === 'object' &&
        payload !== null &&
        'code' in payload &&
        typeof payload.code === 'string'
          ? payload.code
          : `CLOUD_INGESTION_HTTP_${response.status}`;
      throw new CloudIngestionRequestError(response.status, code);
    }
    return payload;
  }
}
