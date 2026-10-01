import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from './auth';

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const thumbprint = 'A'.repeat(43);

describe('device-bound access token issuance', () => {
  it('issues a 15-minute EdDSA JWT accepted by the Worker verifier', async () => {
    const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const token = await issueAccessToken(
      {
        principalId: USER,
        kind: 'user',
        tenantId: TENANT,
        workspaceIds: [WORKSPACE],
        activeWorkspaceId: WORKSPACE,
        autonomy: 0,
        deviceId: DEVICE,
        sessionFamilyId: '55555555-5555-4555-8555-555555555555',
        deviceThumbprint: thumbprint,
      },
      {
        privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
        audience: 'xyra-cloud',
        issuer: 'xyra-auth',
      },
    );
    const result = await verifyAccessToken(
      new Request('https://cloud.test/', { headers: { authorization: `Bearer ${token}` } }),
      { verificationJwk: JSON.stringify(publicJwk), audience: 'xyra-cloud', issuer: 'xyra-auth' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.principalId).toBe(USER);
      expect(result.claims.deviceThumbprint).toBe(thumbprint);
      expect(result.claims.sessionFamilyId).toBe('55555555-5555-4555-8555-555555555555');
    }
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };
    expect((payload.exp - payload.iat) * 1000).toBe(900_000);
  });

  it('refuses malformed scopes and incomplete agent delegation before signing', async () => {
    const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const config = {
      privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
      audience: 'xyra-cloud',
      issuer: 'xyra-auth',
    };
    await expect(
      issueAccessToken(
        {
          principalId: USER,
          kind: 'user',
          tenantId: TENANT,
          workspaceIds: [WORKSPACE, WORKSPACE],
          activeWorkspaceId: WORKSPACE,
          autonomy: 0,
          deviceId: DEVICE,
          deviceThumbprint: thumbprint,
        },
        config,
      ),
    ).rejects.toThrow('Invalid access-token claims');
    await expect(
      issueAccessToken(
        {
          principalId: USER,
          kind: 'agent',
          tenantId: TENANT,
          workspaceIds: [WORKSPACE],
          activeWorkspaceId: WORKSPACE,
          autonomy: 2,
          deviceId: DEVICE,
          deviceThumbprint: thumbprint,
        },
        config,
      ),
    ).rejects.toThrow('Invalid access-token claims');
  });
});
