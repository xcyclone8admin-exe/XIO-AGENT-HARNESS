import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { issueAccessToken, verifyAccessToken } from './auth';
import { verifyDpopProofForToken } from './dpop';
import { readCurrentAuthority, withNeonTransaction } from './neon';
import type { CandidateClaims } from './model';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const URL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export class AuthFlowError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 409 | 503 = 400,
  ) {
    super(code);
  }
}

export interface WebAuthnConfig {
  readonly origin: string;
  readonly rpId: string;
  readonly rpName: string;
}

interface AuthTransaction extends Record<string, unknown> {
  id: string;
  state_hash: Uint8Array;
  pkce_challenge: string;
  target_workspace_id: string;
  device_id: string;
  device_public_jwk: JsonWebKey;
  device_thumbprint: string;
  redirect_uri: string;
  challenge: string;
  nonce: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function publicDeviceKey(
  value: unknown,
): Promise<{ jwk: JsonWebKey; thumbprint: string } | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  let canonicalJwk: string;
  let jwk: JsonWebKey;
  if (input['kty'] === 'OKP' && input['crv'] === 'Ed25519' && typeof input['x'] === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(input['x']) && keys.every((key) => ['kty', 'crv', 'x'].includes(key)) &&
      keys.length === 3) {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: input['x'] };
    canonicalJwk = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: input['x'] });
  } else if (input['kty'] === 'EC' && input['crv'] === 'P-256' && typeof input['x'] === 'string' &&
      typeof input['y'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input['x']) &&
      /^[A-Za-z0-9_-]{43}$/.test(input['y']) && keys.every((key) => ['kty', 'crv', 'x', 'y'].includes(key)) &&
      keys.length === 4) {
    jwk = { kty: 'EC', crv: 'P-256', x: input['x'], y: input['y'] };
    // RFC 7638 required-member order for EC public keys.
    canonicalJwk = JSON.stringify({ crv: 'P-256', kty: 'EC', x: input['x'], y: input['y'] });
  } else return null;
  try {
    await crypto.subtle.importKey(
      'jwk', jwk, jwk.kty === 'OKP' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify'],
    );
  } catch {
    return null;
  }
  const digestValue = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJwk));
  return {
    jwk,
    thumbprint: b64url(new Uint8Array(digestValue)),
  };
}

function validRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 256) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !!url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validWebAuthnConfig(config: WebAuthnConfig | undefined): config is WebAuthnConfig {
  if (!config || !config.origin || !config.rpId || !config.rpName) return false;
  try {
    const url = new URL(config.origin);
    if (url.origin !== config.origin || url.username || url.password || url.pathname !== '/') return false;
    if (url.protocol === 'http:') return url.hostname === 'localhost' && config.rpId === 'localhost';
    return (
      url.protocol === 'https:' && (url.hostname === config.rpId || url.hostname.endsWith(`.${config.rpId}`))
    );
  } catch {
    return false;
  }
}

export async function beginPasskeyAuthentication(
  connectionString: string,
  config: WebAuthnConfig,
  input: unknown,
): Promise<{ transactionId: string; state: string; nonce: string; options: unknown }> {
  if (!validWebAuthnConfig(config)) throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AuthFlowError('INVALID_AUTH_REQUEST');
  const body = input as Record<string, unknown>;
  if (
    typeof body['pkceChallenge'] !== 'string' ||
    !URL_TOKEN.test(body['pkceChallenge']) ||
    !validRedirect(body['redirectUri']) ||
    typeof body['deviceId'] !== 'string' ||
    !UUID.test(body['deviceId']) ||
    typeof body['workspaceId'] !== 'string' ||
    !UUID.test(body['workspaceId'])
  )
    throw new AuthFlowError('INVALID_AUTH_REQUEST');
  const device = await publicDeviceKey(body['deviceJwk']);
  if (!device) throw new AuthFlowError('INVALID_DEVICE_KEY');

  const transactionId = crypto.randomUUID();
  const state = randomToken();
  const nonce = randomToken();
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required' });
  const challenge = options.challenge;
  await withNeonTransaction(connectionString, { authTransactionId: transactionId }, async (client) => {
    await client.query(
      `INSERT INTO cloud_auth_transactions
        (id,state_hash,pkce_challenge,target_workspace_id,device_id,device_public_jwk,device_thumbprint,
         redirect_uri,nonce,challenge,expires_at)
       VALUES ($1,decode($2,'hex'),$3,$4,$5,$6::jsonb,$7,$8,$9,$10,now()+interval '5 minutes')`,
      [
        transactionId,
        hex(await digest(state)),
        body['pkceChallenge'],
        body['workspaceId'],
        body['deviceId'],
        JSON.stringify(device.jwk),
        device.thumbprint,
        body['redirectUri'],
        nonce,
        challenge,
      ],
    );
  });
  return { transactionId, state, nonce, options };
}

function uuidBytes(value: string): Uint8Array {
  return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

export async function beginPasskeyRegistration(
  connectionString: string,
  config: WebAuthnConfig,
  claims: CandidateClaims,
): Promise<{ transactionId: string; state: string; options: unknown }> {
  if (!validWebAuthnConfig(config)) throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  if (claims.kind !== 'user' || !claims.deviceId)
    throw new AuthFlowError('USER_AUTHENTICATION_REQUIRED', 403);
  const transactionId = crypto.randomUUID();
  const state = randomToken();
  return withNeonTransaction(
    connectionString,
    { tenantId: claims.tenantId, workspaceId: claims.activeWorkspaceId, authTransactionId: transactionId },
    async (client) => {
      const userResult = await client.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE tenant_id=$1 AND id=$2',
        [claims.tenantId, claims.principalId],
      );
      const user = userResult.rows[0];
      if (!user) throw new AuthFlowError('CURRENT_MEMBERSHIP_REQUIRED', 403);
      const existing = await client.query<{
        credential_id: string;
        transports: AuthenticatorTransportFuture[];
      }>(
        `SELECT credential_id,transports FROM cloud_passkeys
          WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [claims.tenantId, claims.principalId],
      );
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpId,
        userName: claims.principalId,
        userDisplayName: user.display_name,
        userID: new Uint8Array(uuidBytes(claims.principalId)),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: existing.rows.map((row) => ({
          id: row.credential_id,
          transports: row.transports,
        })),
      });
      await client.query(
        `INSERT INTO cloud_auth_transactions
          (id,purpose,tenant_id,user_id,target_workspace_id,state_hash,challenge,expires_at)
         VALUES ($1,'register',$2,$3,$4,decode($5,'hex'),$6,now()+interval '5 minutes')`,
        [
          transactionId,
          claims.tenantId,
          claims.principalId,
          claims.activeWorkspaceId,
          hex(await digest(state)),
          options.challenge,
        ],
      );
      return { transactionId, state, options };
    },
  );
}

export async function finishPasskeyRegistration(
  connectionString: string,
  config: WebAuthnConfig,
  claims: CandidateClaims,
  transactionId: string,
  state: string,
  response: unknown,
): Promise<{ registered: true }> {
  if (!validWebAuthnConfig(config)) throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  if (claims.kind !== 'user' || !UUID.test(transactionId) || !URL_TOKEN.test(state))
    throw new AuthFlowError('INVALID_AUTH_REQUEST');
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new AuthFlowError('INVALID_CREDENTIAL');
  return withNeonTransaction(
    connectionString,
    { tenantId: claims.tenantId, workspaceId: claims.activeWorkspaceId, authTransactionId: transactionId },
    async (client) => {
      const found = await client.query<{ challenge: string }>(
        `SELECT challenge FROM cloud_auth_transactions
          WHERE id=$1 AND purpose='register' AND tenant_id=$2 AND user_id=$3
            AND state_hash=decode($4,'hex') AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [transactionId, claims.tenantId, claims.principalId, hex(await digest(state))],
      );
      const challenge = found.rows[0]?.challenge;
      if (!challenge) throw new AuthFlowError('AUTH_TRANSACTION_INVALID', 401);
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: true,
        });
      } catch {
        throw new AuthFlowError('INVALID_CREDENTIAL', 401);
      }
      const info = verification.verified ? verification.registrationInfo : null;
      if (!info?.userVerified) throw new AuthFlowError('INVALID_CREDENTIAL', 401);
      await client.query(
        `INSERT INTO cloud_passkeys
          (id,tenant_id,user_id,credential_id,public_key,sign_count,transports,device_type,backed_up)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [
          crypto.randomUUID(),
          claims.tenantId,
          claims.principalId,
          info.credential.id,
          info.credential.publicKey,
          info.credential.counter,
          JSON.stringify(info.credential.transports ?? []),
          info.credentialDeviceType,
          info.credentialBackedUp,
        ],
      );
      const consumed = await client.query(
        `UPDATE cloud_auth_transactions SET consumed_at=now()
          WHERE id=$1 AND consumed_at IS NULL RETURNING 1`,
        [transactionId],
      );
      if (!consumed.rows.length) throw new AuthFlowError('AUTH_TRANSACTION_INVALID', 401);
      return { registered: true };
    },
  );
}

interface PasskeyRow extends Record<string, unknown> {
  tenant_id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  sign_count: string | number;
  transports: AuthenticatorTransportFuture[];
}

export async function finishPasskeyAuthentication(
  connectionString: string,
  config: WebAuthnConfig,
  transactionId: string,
  state: string,
  response: unknown,
): Promise<string> {
  if (!validWebAuthnConfig(config)) throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  if (!UUID.test(transactionId) || !URL_TOKEN.test(state)) throw new AuthFlowError('INVALID_AUTH_REQUEST');
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new AuthFlowError('INVALID_CREDENTIAL');
  const credentialResponse = response as AuthenticationResponseJSON;
  if (typeof credentialResponse.id !== 'string' || credentialResponse.id.length > 1024)
    throw new AuthFlowError('INVALID_CREDENTIAL');

  return withNeonTransaction(
    connectionString,
    { authTransactionId: transactionId, authCredentialId: credentialResponse.id },
    async (client) => {
      const txResult = await client.query<AuthTransaction>(
        `SELECT id,state_hash,pkce_challenge,target_workspace_id,device_id,device_public_jwk,
                device_thumbprint,redirect_uri,challenge,nonce,expires_at,consumed_at
           FROM cloud_auth_transactions
          WHERE id=$1 AND state_hash=decode($2,'hex') AND tenant_id IS NULL
            AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [transactionId, hex(await digest(state))],
      );
      const tx = txResult.rows[0];
      if (!tx) throw new AuthFlowError('AUTH_TRANSACTION_INVALID', 401);
      const passkeyResult = await client.query<PasskeyRow>(
        `SELECT tenant_id::text,user_id::text,credential_id,public_key,sign_count,transports
           FROM cloud_passkeys WHERE credential_id=$1 AND revoked_at IS NULL`,
        [credentialResponse.id],
      );
      const passkey = passkeyResult.rows[0];
      if (!passkey) throw new AuthFlowError('INVALID_CREDENTIAL', 401);
      const credential: WebAuthnCredential = {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.sign_count),
        transports: passkey.transports,
      };
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: credentialResponse,
          expectedChallenge: tx.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          credential,
          requireUserVerification: true,
        });
      } catch {
        throw new AuthFlowError('INVALID_CREDENTIAL', 401);
      }
      if (!verification.verified || verification.authenticationInfo.credentialID !== passkey.credential_id)
        throw new AuthFlowError('INVALID_CREDENTIAL', 401);

      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",
        [passkey.tenant_id, tx.target_workspace_id],
      );
      const claims: CandidateClaims = {
        principalId: passkey.user_id,
        kind: 'user',
        tenantId: passkey.tenant_id,
        workspaceIds: [tx.target_workspace_id],
        activeWorkspaceId: tx.target_workspace_id,
        autonomy: 0,
        expiresAtMs: Date.now() + 900_000,
        deviceId: tx.device_id,
        deviceThumbprint: tx.device_thumbprint,
      };
      const authority = await readCurrentAuthority(client, claims);
      if (!authority) throw new AuthFlowError('CURRENT_MEMBERSHIP_REQUIRED', 403);

      await client.query(
        'UPDATE cloud_passkeys SET sign_count=$1,last_used_at=now() WHERE credential_id=$2',
        [verification.authenticationInfo.newCounter, passkey.credential_id],
      );
      await client.query(
        `UPDATE cloud_auth_transactions SET tenant_id=$1,user_id=$2,consumed_at=now()
          WHERE id=$3 AND consumed_at IS NULL`,
        [passkey.tenant_id, passkey.user_id, transactionId],
      );
      const code = randomToken();
      await client.query(
        `INSERT INTO cloud_auth_codes
          (code_hash,transaction_id,tenant_id,user_id,workspace_id,device_id,device_public_jwk,device_thumbprint,expires_at)
         VALUES (decode($1,'hex'),$2,$3,$4,$5,$6,$7::jsonb,$8,now()+interval '60 seconds')`,
        [
          hex(await digest(code)),
          transactionId,
          passkey.tenant_id,
          passkey.user_id,
          tx.target_workspace_id,
          tx.device_id,
          JSON.stringify(tx.device_public_jwk),
          tx.device_thumbprint,
        ],
      );
      const redirect = new URL(tx.redirect_uri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', state);
      return redirect.toString();
    },
  );
}

export function pkceMatches(verifier: string, expectedChallenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return Promise.resolve(false);
  return digest(verifier).then((value) => b64url(value) === expectedChallenge);
}

interface AuthorizationCodeRow extends Record<string, unknown> {
  code_hash: Uint8Array;
  transaction_id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  device_id: string;
  device_thumbprint: string;
  pkce_challenge: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

export async function exchangeAuthorizationCode(
  connectionString: string,
  request: Request,
  input: { transactionId: string; code: string; verifier: string },
  config: { privateJwk: string; publicJwk: string; audience: string; issuer: string },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: 900; tokenType: 'DPoP' }> {
  if (
    !UUID.test(input.transactionId) ||
    !URL_TOKEN.test(input.code) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
  )
    throw new AuthFlowError('INVALID_AUTH_REQUEST');
  if (!config.privateJwk || !config.publicJwk || !config.audience || !config.issuer)
    throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  return withNeonTransaction(connectionString, { authTransactionId: input.transactionId }, async (client) => {
    const found = await client.query<AuthorizationCodeRow>(
      `SELECT c.code_hash,c.transaction_id::text,c.tenant_id::text,c.user_id::text,c.workspace_id::text,
              c.device_id::text,c.device_thumbprint,c.expires_at,c.consumed_at,t.pkce_challenge
         FROM cloud_auth_codes c JOIN cloud_auth_transactions t ON t.id=c.transaction_id
        WHERE c.transaction_id=$1 AND c.code_hash=decode($2,'hex')
          AND c.consumed_at IS NULL AND c.expires_at>now() FOR UPDATE OF c,t`,
      [input.transactionId, hex(await digest(input.code))],
    );
    const code = found.rows[0];
    if (!code || !(await pkceMatches(input.verifier, code.pkce_challenge)))
      throw new AuthFlowError('AUTH_CODE_INVALID', 401);
    const proof = await verifyDpopProofForToken(request, input.code, code.device_thumbprint);
    if (!proof) throw new AuthFlowError('DPOP_INVALID', 401);
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [
      code.tenant_id,
      code.workspace_id,
    ]);
    const claims: CandidateClaims = {
      principalId: code.user_id,
      kind: 'user',
      tenantId: code.tenant_id,
      workspaceIds: [code.workspace_id],
      activeWorkspaceId: code.workspace_id,
      autonomy: 0,
      expiresAtMs: Date.now() + 900_000,
      deviceId: code.device_id,
      deviceThumbprint: code.device_thumbprint,
    };
    const authority = await readCurrentAuthority(client, claims);
    if (!authority) throw new AuthFlowError('CURRENT_MEMBERSHIP_REQUIRED', 403);
    const replay = await client.query(
      `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
       VALUES ($1,$2,decode($3,'hex'),to_timestamp($4)) ON CONFLICT DO NOTHING RETURNING 1`,
      [claims.tenantId, claims.deviceId, proof.jtiHashHex, proof.expiresAtMs / 1000],
    );
    if (replay.rows.length !== 1) throw new AuthFlowError('DPOP_REPLAYED', 401);

    const familyId = crypto.randomUUID();
    const refreshToken = randomToken();
    const refreshHash = hex(await digest(refreshToken));
    await client.query(
      `INSERT INTO cloud_refresh_families
        (id,tenant_id,user_id,workspace_id,device_id,device_public_jwk,device_thumbprint,expires_at)
       SELECT $1,$2,$3,$4,$5,device_public_jwk,$6,now()+interval '30 days'
         FROM cloud_auth_codes WHERE transaction_id=$7`,
      [
        familyId,
        claims.tenantId,
        claims.principalId,
        claims.activeWorkspaceId,
        claims.deviceId,
        claims.deviceThumbprint,
        input.transactionId,
      ],
    );
    await client.query(
      `INSERT INTO cloud_refresh_tokens(token_hash,tenant_id,family_id,generation,expires_at)
       VALUES (decode($1,'hex'),$2,$3,0,now()+interval '30 days')`,
      [refreshHash, claims.tenantId, familyId],
    );
    const consumed = await client.query(
      `UPDATE cloud_auth_codes SET consumed_at=now()
        WHERE transaction_id=$1 AND code_hash=decode($2,'hex') AND consumed_at IS NULL RETURNING 1`,
      [input.transactionId, hex(await digest(input.code))],
    );
    if (consumed.rows.length !== 1) throw new AuthFlowError('AUTH_CODE_INVALID', 401);
    const accessToken = await issueAccessToken(
      {
        principalId: claims.principalId,
        kind: 'user',
        tenantId: claims.tenantId,
        workspaceIds: claims.workspaceIds,
        activeWorkspaceId: claims.activeWorkspaceId,
        autonomy: 0,
        deviceId: code.device_id,
        sessionFamilyId: familyId,
        deviceThumbprint: claims.deviceThumbprint,
      },
      { privateJwk: config.privateJwk, audience: config.audience, issuer: config.issuer },
    );
    const verifiedAccess = await verifyAccessToken(
      new Request('https://cloud.invalid/', { headers: { authorization: `Bearer ${accessToken}` } }),
      { verificationJwk: config.publicJwk, audience: config.audience, issuer: config.issuer },
    );
    if (!verifiedAccess.ok) throw new AuthFlowError('AUTH_SIGNING_KEY_MISMATCH', 503);
    return { accessToken, refreshToken, expiresIn: 900, tokenType: 'DPoP' };
  });
}

interface RefreshRow extends Record<string, unknown> {
  token_hash: Uint8Array;
  tenant_id: string;
  family_id: string;
  generation: number;
  token_expires_at: Date | string;
  used_at: Date | string | null;
  replaced_by_hash: Uint8Array | null;
  user_id: string;
  workspace_id: string;
  device_id: string;
  device_thumbprint: string;
  device_public_jwk: JsonWebKey;
  family_expires_at: Date | string;
  revoked_at: Date | string | null;
}

type RefreshResult =
  | {
      readonly kind: 'tokens';
      readonly value: { accessToken: string; refreshToken: string; expiresIn: 900; tokenType: 'DPoP' };
    }
  | { readonly kind: 'reuse' | 'invalid' | 'membership' | 'dpop' };

export async function rotateRefreshToken(
  connectionString: string,
  request: Request,
  refreshToken: string,
  config: { privateJwk: string; publicJwk: string; audience: string; issuer: string },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: 900; tokenType: 'DPoP' }> {
  if (!URL_TOKEN.test(refreshToken)) throw new AuthFlowError('INVALID_REFRESH_TOKEN', 401);
  if (!config.privateJwk || !config.publicJwk || !config.audience || !config.issuer)
    throw new AuthFlowError('AUTH_NOT_CONFIGURED', 503);
  const oldHash = hex(await digest(refreshToken));
  const result = await withNeonTransaction(
    connectionString,
    { refreshTokenHash: oldHash },
    async (client): Promise<RefreshResult> => {
      const found = await client.query<RefreshRow>(
        `SELECT t.token_hash,t.tenant_id::text,t.family_id::text,t.generation,
                t.expires_at AS token_expires_at,t.used_at,t.replaced_by_hash,
                f.user_id::text,f.workspace_id::text,f.device_id::text,f.device_thumbprint,
                f.device_public_jwk,f.expires_at AS family_expires_at,f.revoked_at
           FROM cloud_refresh_tokens t JOIN cloud_refresh_families f ON f.id=t.family_id
          WHERE t.token_hash=decode($1,'hex') FOR UPDATE OF t,f`,
        [oldHash],
      );
      const old = found.rows[0];
      if (!old) return { kind: 'invalid' };
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",
        [old.tenant_id, old.workspace_id],
      );
      if (old.used_at) {
        await client.query(
          `UPDATE cloud_refresh_families SET revoked_at=COALESCE(revoked_at,now()),
             revoke_reason='refresh_reuse' WHERE id=$1`,
          [old.family_id],
        );
        return { kind: 'reuse' };
      }
      const now = Date.now();
      if (
        old.revoked_at ||
        new Date(old.token_expires_at).getTime() <= now ||
        new Date(old.family_expires_at).getTime() <= now
      )
        return { kind: 'invalid' };
      const proof = await verifyDpopProofForToken(request, refreshToken, old.device_thumbprint, now);
      if (!proof) return { kind: 'dpop' };

      const claims: CandidateClaims = {
        principalId: old.user_id,
        kind: 'user',
        tenantId: old.tenant_id,
        workspaceIds: [old.workspace_id],
        activeWorkspaceId: old.workspace_id,
        autonomy: 0,
        expiresAtMs: now + 900_000,
        deviceId: old.device_id,
        deviceThumbprint: old.device_thumbprint,
      };
      const authority = await readCurrentAuthority(client, claims);
      if (!authority) {
        await client.query(
          `UPDATE cloud_refresh_families SET revoked_at=COALESCE(revoked_at,now()),
             revoke_reason='membership_revoked' WHERE id=$1`,
          [old.family_id],
        );
        return { kind: 'membership' };
      }
      const replay = await client.query(
        `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
         VALUES ($1,$2,decode($3,'hex'),to_timestamp($4)) ON CONFLICT DO NOTHING RETURNING 1`,
        [old.tenant_id, old.device_id, proof.jtiHashHex, proof.expiresAtMs / 1000],
      );
      if (!replay.rows.length) return { kind: 'dpop' };

      const nextRefresh = randomToken();
      const nextHash = hex(await digest(nextRefresh));
      const updated = await client.query(
        `UPDATE cloud_refresh_tokens SET used_at=now(),replaced_by_hash=decode($1,'hex')
          WHERE token_hash=decode($2,'hex') AND used_at IS NULL RETURNING 1`,
        [nextHash, oldHash],
      );
      if (!updated.rows.length) return { kind: 'reuse' };
      await client.query(
        `INSERT INTO cloud_refresh_tokens(token_hash,tenant_id,family_id,generation,expires_at)
         VALUES (decode($1,'hex'),$2,$3,$4,$5)`,
        [nextHash, old.tenant_id, old.family_id, old.generation + 1, old.family_expires_at],
      );
      const accessToken = await issueAccessToken(
        {
          principalId: claims.principalId,
          kind: 'user',
          tenantId: claims.tenantId,
          workspaceIds: claims.workspaceIds,
          activeWorkspaceId: claims.activeWorkspaceId,
          autonomy: 0,
          deviceId: old.device_id,
          sessionFamilyId: old.family_id,
          deviceThumbprint: claims.deviceThumbprint,
        },
        { privateJwk: config.privateJwk, audience: config.audience, issuer: config.issuer },
      );
      const verified = await verifyAccessToken(
        new Request('https://cloud.invalid/', { headers: { authorization: `Bearer ${accessToken}` } }),
        { verificationJwk: config.publicJwk, audience: config.audience, issuer: config.issuer },
      );
      if (!verified.ok) throw new AuthFlowError('AUTH_SIGNING_KEY_MISMATCH', 503);
      return {
        kind: 'tokens',
        value: { accessToken, refreshToken: nextRefresh, expiresIn: 900, tokenType: 'DPoP' },
      };
    },
  );
  if (result.kind === 'tokens') return result.value;
  if (result.kind === 'reuse') throw new AuthFlowError('REFRESH_REUSE_DETECTED', 401);
  if (result.kind === 'membership') throw new AuthFlowError('CURRENT_MEMBERSHIP_REQUIRED', 403);
  if (result.kind === 'dpop') throw new AuthFlowError('DPOP_INVALID', 401);
  throw new AuthFlowError('INVALID_REFRESH_TOKEN', 401);
}

/** Revoke only the refresh family named by the verified device-bound access token. */
export async function revokeCurrentRefreshFamily(
  connectionString: string,
  claims: CandidateClaims,
): Promise<boolean> {
  if (claims.kind !== 'user' || !claims.deviceId || !claims.sessionFamilyId)
    throw new AuthFlowError('SESSION_NOT_FOUND', 409);
  return withNeonTransaction(connectionString,
    { tenantId: claims.tenantId, workspaceId: claims.activeWorkspaceId },
    async (client) => {
      const authority = await readCurrentAuthority(client, claims);
      if (!authority) throw new AuthFlowError('CURRENT_MEMBERSHIP_REQUIRED', 403);
      const found = await client.query<{ id: string }>(
        `SELECT id FROM cloud_refresh_families
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND user_id=$4 AND device_id=$5
          FOR UPDATE`,
        [claims.sessionFamilyId, claims.tenantId, claims.activeWorkspaceId, claims.principalId, claims.deviceId],
      );
      if (!found.rows.length) return false;
      await client.query(
        `UPDATE cloud_refresh_families SET revoked_at=COALESCE(revoked_at,now()),
           revoke_reason=COALESCE(revoke_reason,'user_logout')
          WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND user_id=$4 AND device_id=$5`,
        [claims.sessionFamilyId, claims.tenantId, claims.activeWorkspaceId, claims.principalId, claims.deviceId],
      );
      return true;
    });
}
