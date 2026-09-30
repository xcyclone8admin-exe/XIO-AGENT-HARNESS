import type { CandidateClaims } from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthFailureCode =
  'MISSING_AUTH' | 'MALFORMED_TOKEN' | 'AUTH_NOT_CONFIGURED' | 'INVALID_SIGNATURE' | 'INVALID_CLAIMS';

export type AuthResult =
  | { readonly ok: true; readonly claims: CandidateClaims }
  | { readonly ok: false; readonly code: AuthFailureCode };

export interface JwtVerifierConfig {
  readonly audience?: string;
  readonly issuer?: string;
  /** Public Ed25519 JWK only; the private signing key never reaches the Worker. */
  readonly verificationJwk?: string;
  readonly nowMs?: number;
}

interface JwtHeader {
  readonly alg?: unknown;
  readonly typ?: unknown;
}

interface JwtPayload {
  readonly sub?: unknown;
  readonly kind?: unknown;
  readonly tenant_id?: unknown;
  readonly workspace_ids?: unknown;
  readonly active_workspace?: unknown;
  readonly autonomy_level?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly aud?: unknown;
  readonly iss?: unknown;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson<T>(part: string): T | null {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function validAudience(value: unknown, expected: string | undefined): boolean {
  if (!expected) return true;
  return (
    value === expected ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.includes(expected))
  );
}

function toClaims(payload: JwtPayload, config: JwtVerifierConfig): CandidateClaims | null {
  const nowSeconds = Math.floor((config.nowMs ?? Date.now()) / 1000);
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.tenant_id !== 'string' ||
    typeof payload.active_workspace !== 'string' ||
    !UUID.test(payload.sub) ||
    !UUID.test(payload.tenant_id) ||
    !UUID.test(payload.active_workspace) ||
    !Array.isArray(payload.workspace_ids) ||
    !payload.workspace_ids.every((id) => typeof id === 'string' && UUID.test(id)) ||
    !payload.workspace_ids.includes(payload.active_workspace) ||
    (payload.kind !== 'user' && payload.kind !== 'agent') ||
    ![0, 1, 2, 3, 4].includes(payload.autonomy_level as number) ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number' ||
    payload.exp <= nowSeconds ||
    payload.iat > nowSeconds + 60 ||
    !validAudience(payload.aud, config.audience) ||
    (config.issuer !== undefined && payload.iss !== config.issuer)
  ) {
    return null;
  }
  return {
    principalId: payload.sub,
    kind: payload.kind,
    tenantId: payload.tenant_id,
    workspaceIds: payload.workspace_ids,
    activeWorkspaceId: payload.active_workspace,
    autonomy: payload.autonomy_level as CandidateClaims['autonomy'],
    expiresAtMs: payload.exp * 1000,
  };
}

/** Verifies an Ed25519 access JWT. Claim data is intentionally not authorization. */
export async function verifyAccessToken(request: Request, config: JwtVerifierConfig): Promise<AuthResult> {
  const authorization = request.headers.get('authorization');
  if (!authorization) return { ok: false, code: 'MISSING_AUTH' };
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
  if (!token) return { ok: false, code: 'MALFORMED_TOKEN' };
  // Fail closed: signature key, audience and issuer must all be configured.
  if (!config.verificationJwk || !config.audience || !config.issuer)
    return { ok: false, code: 'AUTH_NOT_CONFIGURED' };

  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) return { ok: false, code: 'MALFORMED_TOKEN' };
  const header = decodeJson<JwtHeader>(headerPart);
  const payload = decodeJson<JwtPayload>(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!header || !payload || !signature || header.alg !== 'EdDSA' || header.typ !== 'JWT') {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  let key: CryptoKey;
  try {
    const jwk = JSON.parse(config.verificationJwk) as JsonWebKey;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
      return { ok: false, code: 'AUTH_NOT_CONFIGURED' };
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return { ok: false, code: 'AUTH_NOT_CONFIGURED' };
  }
  const valid = await crypto.subtle.verify(
    'Ed25519',
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return { ok: false, code: 'INVALID_SIGNATURE' };
  const claims = toClaims(payload, config);
  return claims ? { ok: true, claims } : { ok: false, code: 'INVALID_CLAIMS' };
}
