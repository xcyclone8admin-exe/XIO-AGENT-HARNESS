import {
  assertBrainReferenceSyncAcknowledgement,
  assertPushResponseBoundToRequest,
  PushRequest,
  PushResponse,
  type BrainReferenceSyncAcknowledgement,
  type BrainReferenceSyncExpectation,
  type PushRequest as PushRequestType,
  type PushResponse as PushResponseType,
} from '@xyra/contracts';
import type { AuthenticatedCloudTransport } from './cloud-ingestion';

export class CloudSyncRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'CloudSyncRequestError';
  }
}

export class CloudSyncOutcomeUnknownError extends Error {
  constructor() {
    super('CLOUD_SYNC_OUTCOME_UNKNOWN');
    this.name = 'CloudSyncOutcomeUnknownError';
  }
}

/**
 * Host-side authenticated sync push client. It retries only with the same idempotency key and
 * does not return an acknowledgement unless every request row has an outcome bound to it.
 * Do not use the returned object as authority for a public/server capability; the host must keep
 * it on the trusted side of the WebView boundary.
 */
export class CloudSyncPushClient {
  constructor(private readonly transport: AuthenticatedCloudTransport) {}

  async push(requestInput: PushRequestType): Promise<PushResponseType> {
    const request = PushRequest.parse(requestInput);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.transport.request('/v1/sync/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        if (attempt === 1) throw new CloudSyncOutcomeUnknownError();
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (attempt === 0 && response.status >= 500 && response.status <= 599) continue;
        throw new CloudSyncOutcomeUnknownError();
      }

      if (!response.ok) {
        const code = typeof payload === 'object' && payload !== null && 'code' in payload && typeof payload.code === 'string'
          ? payload.code
          : `CLOUD_SYNC_HTTP_${response.status}`;
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          // Re-submit the exact request and key so Cloud returns its durable prior outcome.
          continue;
        }
        throw new CloudSyncRequestError(response.status, code);
      }

      try {
        const parsed = PushResponse.parse(payload);
        assertPushResponseBoundToRequest(request, parsed);
        return parsed;
      } catch {
        if (attempt === 0) continue;
        throw new CloudSyncOutcomeUnknownError();
      }
    }
    throw new CloudSyncOutcomeUnknownError();
  }

  async pushAndAcknowledgeBrainReferences(
    request: PushRequestType,
    expected: BrainReferenceSyncExpectation,
  ): Promise<BrainReferenceSyncAcknowledgement> {
    const response = await this.push(request);
    return assertBrainReferenceSyncAcknowledgement(request, response, expected);
  }
}
