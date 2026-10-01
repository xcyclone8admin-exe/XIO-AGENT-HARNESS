import type { AuthenticatedCloudTransport } from './cloud-ingestion';
import { CloudBlobReferenceIssueResult } from '@xyra/contracts';

export interface NativeCloudRequestResult {
  status: number;
  body: unknown;
}

/** Minimal Tauri invoke surface; the native command owns origin, tokens, and DPoP. */
export type NativeCloudInvoker = (
  command: 'cloud_authenticated_request',
  args: { request: { path: string; method: 'GET' | 'POST'; body?: unknown } },
) => Promise<NativeCloudRequestResult>;

export type NativeCloudBlobUploadInvoker = (
  command: 'cloud_blob_upload',
  args: { request: { path: string; bytesBase64: string; contentLength: number } },
) => Promise<NativeCloudRequestResult>;

export const MAX_CLOUD_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(block >>> 18) & 63];
    encoded += alphabet[(block >>> 12) & 63];
    encoded += second === undefined ? '=' : alphabet[(block >>> 6) & 63];
    encoded += third === undefined ? '=' : alphabet[block & 63];
  }
  return encoded;
}

function isAllowedCloudPath(path: string, method: 'GET' | 'POST'): boolean {
  if (path === '/v2/brain/ingestions' || path === '/v1/blobs/ref') return method === 'POST';
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
  constructor(
    private readonly invoke: NativeCloudInvoker,
    private readonly invokeBlobUpload?: NativeCloudBlobUploadInvoker,
  ) {}

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
    const result = await this.invoke('cloud_authenticated_request', {
      request: { path, method: init.method, ...(body === undefined ? {} : { body }) },
    });
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

  /** Upload bytes to a Cloud-issued relative signed path; the native host pins its origin. */
  async uploadBlob(reference: unknown, bytes: Uint8Array): Promise<NativeCloudRequestResult> {
    if (!this.invokeBlobUpload) throw new Error('CLOUD_BLOB_UPLOAD_UNAVAILABLE');
    const parsed = CloudBlobReferenceIssueResult.parse(reference);
    if (parsed.expiresAtMs <= Date.now()) throw new Error('CLOUD_BLOB_REFERENCE_EXPIRED');
    if (bytes.byteLength > MAX_CLOUD_BLOB_UPLOAD_BYTES) throw new RangeError('CLOUD_BLOB_TOO_LARGE');
    const result = await this.invokeBlobUpload('cloud_blob_upload', {
      request: {
        path: parsed.url,
        bytesBase64: encodeBase64(bytes),
        contentLength: bytes.byteLength,
      },
    });
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
      throw new TypeError('CLOUD_NATIVE_RESPONSE_INVALID_STATUS');
    }
    return result;
  }
}
