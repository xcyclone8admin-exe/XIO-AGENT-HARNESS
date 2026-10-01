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
  readonly nbf?: unknown;
  readonly device_id?: unknown;
  readonly delegated_by?: unknown;
  readonly run_id?: unknown;
  readonly aud?: unknown;
  readonly iss?: unknown;
  readonly cnf?: unknown;
  readonly sid?: unknown;
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

/** Leeway applied to iat and nbf only; exp is never extended. */
export const CLOCK_LEEWAY_SEC = 60;
/** Access tokens are 15 minutes (Protocol 02 §24); anything longer-lived is refused. */
export const MAX_TOKEN_LIFETIME_SEC = 15 * 60 + CLOCK_LEEWAY_SEC;

const isNumericDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 2 ** 40;

function optionalUuid(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function toClaims(payload: JwtPayload, config: JwtVerifierConfig): CandidateClaims | null {
  const nowSeconds = (config.nowMs ?? Date.now()) / 1000;
  const deviceId = optionalUuid(payload.device_id);
  const delegatedBy = optionalUuid(payload.delegated_by);
  const runId = optionalUuid(payload.run_id);
  const sessionFamilyId = optionalUuid(payload.sid);
  const confirmation = payload.cnf;
  const deviceThumbprint =
    confirmation && typeof confirmation === 'object'
      ? (confirmation as Record<string, unknown>)['jkt']
      : undefined;
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
    !isNumericDate(payload.exp) ||
    !isNumericDate(payload.iat) ||
    payload.exp <= nowSeconds ||
    payload.iat > nowSeconds + CLOCK_LEEWAY_SEC ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SEC ||
    (payload.nbf !== undefined &&
      (!isNumericDate(payload.nbf) || payload.nbf > nowSeconds + CLOCK_LEEWAY_SEC)) ||
    deviceId === null ||
    !deviceId ||
    typeof deviceThumbprint !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(deviceThumbprint) ||
    delegatedBy === null ||
    runId === null ||
    sessionFamilyId === null ||
    // An agent token must name its delegating user; a user token must not claim one.
    (payload.kind === 'agent') !== (delegatedBy !== undefined) ||
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
    deviceThumbprint,
    ...(deviceId ? { deviceId } : {}),
    ...(delegatedBy ? { delegatedBy } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionFamilyId ? { sessionFamilyId } : {}),
  };
}

export interface AccessTokenInput {
  readonly principalId: string;
  readonly kind: 'user' | 'agent';
  readonly tenantId: string;
  readonly workspaceIds: readonly string[];
  readonly activeWorkspaceId: string;
  readonly autonomy: 0 | 1 | 2 | 3 | 4;
  readonly deviceId: string;
  readonly delegatedBy?: string;
  readonly runId?: string;
  readonly sessionFamilyId?: string;
  readonly deviceThumbprint: string;
}

/** Issue only short-lived, device-bound Worker access tokens (15 minutes maximum). */
export async function issueAccessToken(
  input: AccessTokenInput,
  config: { privateJwk: string; audience: string; issuer: string; nowMs?: number },
): Promise<string> {
  const workspaceIds = [...new Set(input.workspaceIds)];
  const agentIdentityValid =
    input.kind === 'agent'
      ? !!input.delegatedBy && !!input.runId && UUID.test(input.delegatedBy) && UUID.test(input.runId)
      : !input.delegatedBy && !input.runId;
  if (
    !UUID.test(input.principalId) ||
    !UUID.test(input.tenantId) ||
    !UUID.test(input.deviceId) ||
    !workspaceIds.length ||
    workspaceIds.length !== input.workspaceIds.length ||
    !workspaceIds.every((id) => UUID.test(id)) ||
    !workspaceIds.includes(input.activeWorkspaceId) ||
    ![0, 1, 2, 3, 4].includes(input.autonomy) ||
    !agentIdentityValid ||
    (input.sessionFamilyId !== undefined && !UUID.test(input.sessionFamilyId)) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.deviceThumbprint) ||
    !config.audience ||
    !config.issuer
  )
    throw new Error('Invalid access-token claims');
  const now = Math.floor((config.nowMs ?? Date.now()) / 1000);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));
  const payload = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: input.principalId,
        kind: input.kind,
        tenant_id: input.tenantId,
        workspace_ids: workspaceIds,
        active_workspace: input.activeWorkspaceId,
        autonomy_level: input.autonomy,
        device_id: input.deviceId,
        ...(input.delegatedBy ? { delegated_by: input.delegatedBy } : {}),
        ...(input.runId ? { run_id: input.runId } : {}),
        ...(input.sessionFamilyId ? { sid: input.sessionFamilyId } : {}),
        cnf: { jkt: input.deviceThumbprint },
        iat: now,
        exp: now + 15 * 60,
        aud: config.audience,
        iss: config.issuer,
      }),
    ),
  );
  const privateJwk = JSON.parse(config.privateJwk) as JsonWebKey;
  if (
    privateJwk.kty !== 'OKP' ||
    privateJwk.crv !== 'Ed25519' ||
    typeof privateJwk.x !== 'string' ||
    typeof privateJwk.d !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(privateJwk.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(privateJwk.d)
  )
    throw new Error('Invalid access signing key');
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
    // Import only the public key material; runtimes differ on which optional JWK members they accept.
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
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
