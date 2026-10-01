import type { AuthenticatedCloudTransport } from './cloud-ingestion';
import { CloudBlobReferenceIssueRequest, CloudBlobUploadResult } from '@xyra/contracts';

export interface NativeCloudRequestResult {
  status: number;
  body: unknown;
}

/** Minimal Tauri invoke surface; the native command owns origin, tokens, and DPoP. */
export type NativeCloudInvoker = (
  command: 'cloud_authenticated_request' | 'cloud_blob_upload',
  args:
    | { request: { path: string; method: 'GET' | 'POST'; body?: unknown } }
    | { request: { name: string; expiresInSec: number; ingestionId: string; bytes: number[] } },
) => Promise<unknown>;

export const MAX_CLOUD_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;

function isAllowedCloudPath(path: string, method: 'GET' | 'POST'): boolean {
  if (path === '/v2/brain/ingestions') return method === 'POST';
  const match =
    /^\/v2\/brain\/ingestions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/finalize)?$/.exec(
      path,
    );
  if (!match) return false;
  return path.endsWith('/finalize') ? method === 'POST' : method === 'GET';
}

/**
 * Bridges the typed SDK to the native command boundary. It never accepts an origin,
 * authorization header, token, or DPoP proof from WebView code.
 */
export class NativeCloudTransport implements AuthenticatedCloudTransport {
  constructor(private readonly invoke: NativeCloudInvoker) {}

  async request(
    path: string,
    init: { method: 'GET' | 'POST'; headers?: { 'content-type': 'application/json' }; body?: string },
  ): Promise<Response> {
    if (!isAllowedCloudPath(path, init.method)) throw new TypeError('CLOUD_ROUTE_NOT_ALLOWED');
    if (
      init.headers !== undefined &&
      (Object.keys(init.headers).some((key) => key !== 'content-type') ||
        init.headers['content-type'] !== 'application/json')
    ) {
      throw new TypeError('CLOUD_HEADERS_NOT_ALLOWED');
    }
    let body: unknown;
    if (init.body !== undefined) {
      if (init.method !== 'POST') throw new TypeError('CLOUD_BODY_NOT_ALLOWED');
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        throw new TypeError('CLOUD_BODY_INVALID_JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new TypeError('CLOUD_BODY_INVALID_SHAPE');
      }
    }
    const result = (await this.invoke('cloud_authenticated_request', {
      request: { path, method: init.method, ...(body === undefined ? {} : { body }) },
    })) as NativeCloudRequestResult;
    if (
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 599 ||
      [204, 205, 304].includes(result.status)
    ) {
      throw new TypeError('CLOUD_NATIVE_RESPONSE_INVALID_STATUS');
    }
    return Response.json(result.body, { status: result.status });
  }

  /** Native issues the signed ref, streams bytes to its relative path, and returns no key/URL. */
  async uploadBlob(request: {
    name: string;
    expiresInSec: number;
    ingestionId: string;
    bytes: Uint8Array;
  }): Promise<ReturnType<typeof CloudBlobUploadResult.parse>> {
    const issue = CloudBlobReferenceIssueRequest.parse({
      mode: 'PUT',
      name: request.name,
      expiresInSec: request.expiresInSec,
      ingestionId: request.ingestionId,
    });
    if (request.bytes.byteLength > MAX_CLOUD_BLOB_UPLOAD_BYTES) throw new RangeError('CLOUD_BLOB_TOO_LARGE');
    const result = CloudBlobUploadResult.parse(
      await this.invoke('cloud_blob_upload', {
        request: {
          name: issue.name,
          expiresInSec: issue.expiresInSec,
          ingestionId: issue.ingestionId,
          bytes: Array.from(request.bytes),
        },
      }),
    );
    const now = Date.now();
    if (result.expiresAtMs <= now || result.expiresAtMs > now + issue.expiresInSec * 1000 + 5_000) {
      throw new TypeError('CLOUD_BLOB_EXPIRY_INVALID');
    }
    return result;
  }
}
