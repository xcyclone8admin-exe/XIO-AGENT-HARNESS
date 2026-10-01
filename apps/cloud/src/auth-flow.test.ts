import { describe, expect, it } from 'vitest';
import { beginPasskeyAuthentication, pkceMatches, publicDeviceKey, validWebAuthnConfig } from './auth-flow';
import { verifyDpopProofForToken } from './dpop';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

describe('Cloud passkey login boundary', () => {
  it('allows localhost only for development and requires a matching HTTPS RP in hosted deployments', () => {
    expect(validWebAuthnConfig({ origin: 'http://localhost:8787', rpId: 'localhost', rpName: 'XYRA' })).toBe(
      true,
    );
    expect(validWebAuthnConfig({ origin: 'http://127.0.0.1:8787', rpId: '127.0.0.1', rpName: 'XYRA' })).toBe(
      false,
    );
    expect(
      validWebAuthnConfig({ origin: 'https://cloud.example.com', rpId: 'example.com', rpName: 'XYRA' }),
    ).toBe(true);
    expect(
      validWebAuthnConfig({ origin: 'https://notexample.com', rpId: 'example.com', rpName: 'XYRA' }),
    ).toBe(false);
    expect(validWebAuthnConfig(undefined)).toBe(false);
  });

  it('checks the RFC 7636 verifier transform and refuses non-loopback callbacks before storage', async () => {
    expect(
      await pkceMatches(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(true);
    expect(await pkceMatches('short', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    const config = { origin: 'http://localhost:8787', rpId: 'localhost', rpName: 'XYRA' };
    await expect(
      beginPasskeyAuthentication('unused', config, {
        pkceChallenge: 'A'.repeat(43),
        redirectUri: 'https://attacker.example/callback',
        deviceId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        deviceJwk: { kty: 'OKP', crv: 'Ed25519', x: 'B'.repeat(43) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUTH_REQUEST' });
    await expect(
      publicDeviceKey({ kty: 'OKP', crv: 'Ed25519', x: 'B'.repeat(43), d: 'C'.repeat(43) }),
    ).resolves.toBeNull();
  });

  it('computes the RFC 7638 P-256 thumbprint and verifies ES256 DPoP JOSE proofs', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const deviceJwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
    const device = await publicDeviceKey(deviceJwk);
    expect(device).not.toBeNull();
    const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: exported.x, y: exported.y });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
    expect(device?.thumbprint).toBe(b64url(digest));
    expect(await publicDeviceKey({ ...deviceJwk, d: exported.d })).toBeNull();
    expect(await publicDeviceKey({ ...deviceJwk, alg: 'ES256' })).toBeNull();

    const token = 'opaque-access-token';
    const request = new Request('https://cloud.test/v1/auth/logout', { method: 'POST' });
    const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: deviceJwk })));
    const ath = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
    const payload = b64url(new TextEncoder().encode(JSON.stringify({
      htu: request.url, htm: 'POST', iat: Math.floor(Date.now() / 1000), jti: 'desktop-proof-jti-0001', ath,
    })));
    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(signingInput),
    ));
    expect(signature).toHaveLength(64);
    const proof = `${signingInput}.${b64url(signature)}`;
    request.headers.set('dpop', proof);
    await expect(verifyDpopProofForToken(request, token, device!.thumbprint)).resolves.toMatchObject({
      jtiHashHex: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(verifyDpopProofForToken(request, token, 'A'.repeat(43))).resolves.toBeNull();

    const edPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const edExported = await crypto.subtle.exportKey('jwk', edPair.publicKey);
    const edJwk = { kty: 'OKP', crv: 'Ed25519', x: edExported.x };
    const edDevice = await publicDeviceKey(edJwk);
    expect(edDevice).not.toBeNull();
    const edHeader = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: edJwk })));
    const edPayload = b64url(new TextEncoder().encode(JSON.stringify({
      htu: request.url, htm: 'POST', iat: Math.floor(Date.now() / 1000), jti: 'legacy-ed-proof-jti-0001', ath,
    })));
    const edInput = `${edHeader}.${edPayload}`;
    const edSignature = new Uint8Array(await crypto.subtle.sign('Ed25519', edPair.privateKey, new TextEncoder().encode(edInput)));
    request.headers.set('dpop', `${edInput}.${b64url(edSignature)}`);
    await expect(verifyDpopProofForToken(request, token, edDevice!.thumbprint)).resolves.toMatchObject({
      jtiHashHex: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
