import type { CandidateClaims } from './model';

const utf8 = new TextEncoder();

interface DpopHeader {
  readonly typ?: unknown;
  readonly alg?: unknown;
  readonly jwk?: unknown;
}

interface DpopPayload {
  readonly htu?: unknown;
  readonly htm?: unknown;
  readonly iat?: unknown;
  readonly jti?: unknown;
  readonly ath?: unknown;
}

export interface VerifiedDpopProof {
  readonly jtiHashHex: string;
  readonly expiresAtMs: number;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson<T>(value: string): T | null {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function equal(a: string, b: string): boolean {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function sha256(bytes: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Verify RFC 9449-style DPoP binding before the request reaches any authority route. */
export async function verifyDpopProof(
  request: Request,
  accessToken: string,
  claims: CandidateClaims,
  nowMs = Date.now(),
): Promise<VerifiedDpopProof | null> {
  return verifyDpopProofForToken(request, accessToken, claims.deviceThumbprint, nowMs);
}

/** Validate a proof against a one-time authorization code or refresh token before JWT issuance. */
export async function verifyDpopProofForToken(
  request: Request,
  boundToken: string,
  expectedThumbprint: string,
  nowMs = Date.now(),
): Promise<VerifiedDpopProof | null> {
  const token = request.headers.get('dpop');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = decodeJson<DpopHeader>(parts[0]);
  const payload = decodeJson<DpopPayload>(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (
    !header ||
    !payload ||
    !signature ||
    header.typ !== 'dpop+jwt' ||
    (header.alg !== 'EdDSA' && header.alg !== 'ES256') ||
    !header.jwk ||
    typeof header.jwk !== 'object'
  )
    return null;
  const jwk = header.jwk as Record<string, unknown>;
  let canonicalJwk: string;
  let publicJwk: JsonWebKey;
  let algorithm: 'EdDSA' | 'ES256';
  if (jwk['kty'] === 'OKP' && jwk['crv'] === 'Ed25519' && typeof jwk['x'] === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(jwk['x']) && Object.keys(jwk).length === 3 &&
      ['kty', 'crv', 'x'].every((key) => key in jwk) && header.alg === 'EdDSA') {
    publicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk['x'] };
    canonicalJwk = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk['x'] });
    algorithm = 'EdDSA';
  } else if (jwk['kty'] === 'EC' && jwk['crv'] === 'P-256' && typeof jwk['x'] === 'string' &&
      typeof jwk['y'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk['x']) &&
      /^[A-Za-z0-9_-]{43}$/.test(jwk['y']) && Object.keys(jwk).length === 4 &&
      ['kty', 'crv', 'x', 'y'].every((key) => key in jwk) && header.alg === 'ES256') {
    publicJwk = { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] };
    canonicalJwk = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk['x'], y: jwk['y'] });
    algorithm = 'ES256';
  } else return null;
  if (signature.byteLength !== 64) return null;
  const thumbprint = encodeBase64Url(await sha256(utf8.encode(canonicalJwk)));
  if (!equal(thumbprint, expectedThumbprint)) return null;
  if (
    typeof payload.iat !== 'number' ||
    !Number.isSafeInteger(payload.iat) ||
    Math.abs(nowMs / 1000 - payload.iat) > 60 ||
    typeof payload.jti !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti)
  )
    return null;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  const expectedHtu = url.toString();
  if (
    !equal(String(payload.htm ?? ''), request.method.toUpperCase()) ||
    !equal(String(payload.htu ?? ''), expectedHtu)
  )
    return null;
  const tokenHash = encodeBase64Url(await sha256(utf8.encode(boundToken)));
  if (!equal(String(payload.ath ?? ''), tokenHash)) return null;
  try {
    const publicKey = algorithm === 'EdDSA'
      ? await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify'])
      : await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      algorithm === 'EdDSA' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' },
      publicKey, new Uint8Array(signature), utf8.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  const jtiHash = await sha256(utf8.encode(payload.jti));
  return {
    jtiHashHex: [...jtiHash].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    expiresAtMs: nowMs + 120_000,
  };
}
