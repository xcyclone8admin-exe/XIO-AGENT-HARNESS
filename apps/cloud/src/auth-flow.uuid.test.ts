import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ readonly scope: unknown; readonly queries: string[]; readonly values: unknown[][] }>,
}));

vi.mock('./neon', () => ({
  withNeonTransaction: async (
    _connectionString: string,
    scope: unknown,
    operation: (client: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[] }> }) => Promise<unknown>,
  ) => {
    const call = { scope, queries: [] as string[], values: [] as unknown[][] };
    probe.calls.push(call);
    return operation({
      query: async (sql: string, values: readonly unknown[] = []) => {
        call.queries.push(sql);
        call.values.push([...values]);
        return { rows: [] };
      },
    });
  },
}));

import { beginPasskeyAuthentication, exchangeAuthorizationCode, finishPasskeyAuthentication } from './auth-flow';
import type { WebAuthnConfig } from './auth-flow';

const VALID_TX = '11111111-1111-4111-8111-111111111111';
const VALID_DEVICE = '22222222-2222-4222-8222-222222222222';
const VALID_WORKSPACE = '33333333-3333-4333-8333-333333333333';
const MALFORMED_UUID = '11111111-1111-4111-8111-11111111111';
const config: WebAuthnConfig = { origin: 'http://localhost:8787', rpId: 'localhost', rpName: 'XYRA Test' };

beforeEach(() => probe.calls.splice(0));

describe('Cloud auth UUID validation against the canonical policy', () => {
  it('accepts valid device/workspace UUIDs and sends passkey begin through the DB transaction', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const result = await beginPasskeyAuthentication('mock://cloud-db', config, {
      pkceChallenge: 'P'.repeat(43),
      redirectUri: 'http://127.0.0.1:34829/callback',
      deviceId: VALID_DEVICE,
      workspaceId: VALID_WORKSPACE,
      deviceJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
    });
    expect(result.transactionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.queries[0]).toContain('INSERT INTO cloud_auth_transactions');
    expect(probe.calls[0]?.values[0]).toContain(VALID_DEVICE);
    expect(probe.calls[0]?.values[0]).toContain(VALID_WORKSPACE);
  });

  it('rejects malformed begin UUIDs before opening a DB transaction, with valid redirect and key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const input = {
      pkceChallenge: 'P'.repeat(43),
      redirectUri: 'http://127.0.0.1:34829/callback',
      deviceId: VALID_DEVICE,
      workspaceId: VALID_WORKSPACE,
      deviceJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
    };
    await expect(beginPasskeyAuthentication('mock://cloud-db', config, { ...input, deviceId: MALFORMED_UUID }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_REQUEST' });
    await expect(beginPasskeyAuthentication('mock://cloud-db', config, { ...input, workspaceId: MALFORMED_UUID }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_REQUEST' });
    expect(probe.calls).toHaveLength(0);
  });

  it('accepts a valid finish transaction UUID through the DB lookup and rejects malformed UUIDs first', async () => {
    const response = { id: 'credential-id', type: 'public-key' };
    await expect(finishPasskeyAuthentication('mock://cloud-db', config, VALID_TX, 'S'.repeat(43), response))
      .rejects.toMatchObject({ code: 'AUTH_TRANSACTION_INVALID' });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.queries[0]).toContain('FROM cloud_auth_transactions');

    probe.calls.splice(0);
    await expect(finishPasskeyAuthentication('mock://cloud-db', config, MALFORMED_UUID, 'S'.repeat(43), response))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_REQUEST' });
    expect(probe.calls).toHaveLength(0);
  });

  it('accepts a valid exchange transaction UUID through the authorization-code lookup', async () => {
    const request = new Request('https://cloud.test/v1/auth/token', { method: 'POST' });
    const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', signing.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', signing.privateKey);
    await expect(exchangeAuthorizationCode('mock://cloud-db', request, {
      transactionId: VALID_TX, code: 'C'.repeat(43), verifier: 'V'.repeat(43),
    }, { privateJwk: JSON.stringify(privateJwk), publicJwk: JSON.stringify(publicJwk),
      audience: 'xyra-cloud', issuer: 'xyra-auth' }))
      .rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.queries[0]).toContain('FROM cloud_auth_codes');

    probe.calls.splice(0);
    await expect(exchangeAuthorizationCode('mock://cloud-db', request, {
      transactionId: MALFORMED_UUID, code: 'C'.repeat(43), verifier: 'V'.repeat(43),
    }, { privateJwk: JSON.stringify(privateJwk), publicJwk: JSON.stringify(publicJwk),
      audience: 'xyra-cloud', issuer: 'xyra-auth' }))
      .rejects.toMatchObject({ code: 'INVALID_AUTH_REQUEST' });
    expect(probe.calls).toHaveLength(0);
  });
});
