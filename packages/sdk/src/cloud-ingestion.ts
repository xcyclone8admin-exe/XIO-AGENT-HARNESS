import {
  CloudBrainIngestionBeginRequest,
  CloudBrainIngestionBeginResult,
  CloudBrainIngestionFinalizeRequest,
  CloudBrainIngestionFinalizationReceipt,
  CloudBrainIngestionStatus,
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

export class CloudIngestionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'CloudIngestionRequestError';
  }
}

/** Typed client for Cloud-owned source-ingestion provenance and reference finalization. */
export class CloudIngestionClient {
  constructor(private readonly transport: AuthenticatedCloudTransport) {}

  async begin(input: BeginInput): Promise<ReturnType<typeof CloudBrainIngestionBeginResult.parse>> {
    const body = CloudBrainIngestionBeginRequest.parse(input);
    const result = await this.request('/v2/brain/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return CloudBrainIngestionBeginResult.parse(result);
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
    return CloudBrainIngestionFinalizationReceipt.parse(result);
  }

  async status(ingestionId: string): Promise<ReturnType<typeof CloudBrainIngestionStatus.parse>> {
    const id = CloudBrainIngestionBeginResult.shape.ingestionId.parse(ingestionId);
    return CloudBrainIngestionStatus.parse(
      await this.request(`/v2/brain/ingestions/${encodeURIComponent(id)}`, { method: 'GET' }),
    );
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
        typeof payload === 'object' && payload !== null && 'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : `CLOUD_INGESTION_HTTP_${response.status}`;
      throw new CloudIngestionRequestError(response.status, code);
    }
    return payload;
  }
}
