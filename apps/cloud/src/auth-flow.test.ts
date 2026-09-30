import { describe, expect, it } from 'vitest';
import { beginPasskeyAuthentication, pkceMatches, publicDeviceKey, validWebAuthnConfig } from './auth-flow';

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
});
