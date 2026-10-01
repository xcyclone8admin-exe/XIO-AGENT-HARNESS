import type { AuthenticatedCloudTransport } from './cloud-ingestion';
import {
  CloudBlobReferenceIssueRequest,
  CloudBlobUploadResult,
  MAX_PULL_ROWS,
  MAX_PUSH_BYTES,
  PullRequest,
  PushRequest,
} from '@xyra/contracts';

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
  if (path === '/v1/sync/push') return method === 'POST';
  if (path.startsWith('/v1/sync/pull?')) {
    if (method !== 'GET') return false;
    try {
      const url = new URL(path, 'https://native-route.invalid');
      if (url.origin !== 'https://native-route.invalid' || url.pathname !== '/v1/sync/pull' || url.hash) return false;
      const allowed = new Set(['protocolVersion', 'schemaVersion', 'cursor', 'limit']);
      const seen = new Set<string>();
      for (const key of url.searchParams.keys()) {
        if (!allowed.has(key) || seen.has(key)) return false;
        seen.add(key);
      }
      const parsed = PullRequest.safeParse(Object.fromEntries(url.searchParams.entries()));
      if (!parsed.success || !seen.has('protocolVersion') || !seen.has('schemaVersion')) return false;
      if (parsed.data.cursor !== undefined && parsed.data.cursor.length === 0) return false;
      if (parsed.data.limit !== undefined && parsed.data.limit > MAX_PULL_ROWS) return false;
      return true;
    } catch {
      return false;
    }
  }
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
      if (path === '/v1/sync/push') {
        const parsed = PushRequest.safeParse(body);
        if (!parsed.success) throw new TypeError('CLOUD_SYNC_PUSH_INVALID');
        const size = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
        if (size > MAX_PUSH_BYTES) throw new RangeError('CLOUD_SYNC_PUSH_TOO_LARGE');
        body = parsed.data;
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
