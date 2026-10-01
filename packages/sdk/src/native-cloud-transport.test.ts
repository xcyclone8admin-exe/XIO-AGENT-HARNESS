import { describe, expect, it } from 'vitest';
import {
  NativeCloudTransport,
  type NativeCloudBlobUploadInvoker,
  type NativeCloudInvoker,
} from './native-cloud-transport';

const ingestionId = '00000000-0000-4000-8000-000000000001';

describe('NativeCloudTransport', () => {
  it('sends only the typed route and body to the native-owned authenticated command', async () => {
    let call: Parameters<NativeCloudInvoker> | undefined;
    const transport = new NativeCloudTransport(async (...args) => {
      call = args;
      return { status: 201, body: { accepted: true } };
    });
    const response = await transport.request('/v2/brain/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 'cloud-ingest-v2', mode: 'text_only' }),
    });
    expect(call).toEqual([
      'cloud_authenticated_request',
      {
        request: {
          path: '/v2/brain/ingestions',
          method: 'POST',
          body: { protocolVersion: 'cloud-ingest-v2', mode: 'text_only' },
        },
      },
    ]);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it('allows only the Cloud ingestion routes and fixed methods', async () => {
    const transport = new NativeCloudTransport(async () => ({ status: 200, body: {} }));
    await expect(
      transport.request(`/v2/brain/ingestions/${ingestionId}`, { method: 'GET' }),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      transport.request(`/v2/brain/ingestions/${ingestionId}/finalize`, { method: 'POST', body: '{}' }),
    ).resolves.toBeInstanceOf(Response);
    await expect(transport.request('/v1/blobs/ref', { method: 'POST', body: '{}' })).resolves.toBeInstanceOf(
      Response,
    );
    await expect(transport.request('/v2/other/resource', { method: 'GET' })).rejects.toThrow(
      'CLOUD_ROUTE_NOT_ALLOWED',
    );
    await expect(
      transport.request('https://attacker.invalid/v2/brain/ingestions', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('CLOUD_ROUTE_NOT_ALLOWED');
    await expect(
      transport.request(`/v2/brain/ingestions/${ingestionId}`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow('CLOUD_ROUTE_NOT_ALLOWED');
  });

  it('rejects caller-supplied auth headers and malformed body before IPC', async () => {
    let invoked = false;
    const transport = new NativeCloudTransport(async () => {
      invoked = true;
      return { status: 200, body: {} };
    });
    await expect(
      transport.request('/v2/brain/ingestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer caller-token' } as never,
        body: '{}',
      }),
    ).rejects.toThrow('CLOUD_HEADERS_NOT_ALLOWED');
    await expect(transport.request('/v2/brain/ingestions', { method: 'POST', body: '{' })).rejects.toThrow(
      'CLOUD_BODY_INVALID_JSON',
    );
    expect(invoked).toBe(false);
  });

  it('uploads bounded bytes only to a Cloud-issued relative signed path', async () => {
    let call: Parameters<NativeCloudBlobUploadInvoker> | undefined;
    const transport = new NativeCloudTransport(
      async () => ({ status: 200, body: {} }),
      async (...args) => {
        call = args;
        return { status: 204, body: null };
      },
    );
    const reference = {
      objectRefId: '00000000-0000-4000-8000-000000000009',
      mode: 'PUT',
      expiresAtMs: Date.now() + 60_000,
      url: '/v1/blobs/access.eyJrZXkiOiJ0ZXN0In0.signature',
      referenceStatus: 'tracked',
    };
    // Cloud path is a fixed route followed by the signed token.
    reference.url = '/v1/blobs/access/eyJrZXkiOiJ0ZXN0In0.signature';
    await expect(transport.uploadBlob(reference, new Uint8Array([0, 1, 255]))).resolves.toMatchObject({
      status: 204,
    });
    expect(call).toEqual([
      'cloud_blob_upload',
      { request: { path: reference.url, bytesBase64: 'AAH/', contentLength: 3 } },
    ]);
    await expect(
      transport.uploadBlob({ ...reference, url: 'https://attacker.invalid/upload' }, new Uint8Array()),
    ).rejects.toThrow();
    await expect(transport.uploadBlob(reference, new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(
      'CLOUD_BLOB_TOO_LARGE',
    );
  });
});
