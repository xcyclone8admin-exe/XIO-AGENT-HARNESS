export interface BlobAccess {
  readonly key: string;
  /** Principal the ref was issued to; redemption rechecks their current membership. */
  readonly principalId: string;
  readonly mode: 'GET' | 'PUT';
  readonly expiresAtMs: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (part) => part.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function tenantWorkspaceKey(tenantId: string, workspaceId: string, name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(name)) return null;
  return `${tenantId}/${workspaceId}/${name}`;
}

/** Worker-signed, short-lived reference to a private R2 object; never an R2 public URL. */
export async function signBlobAccess(access: BlobAccess, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(access)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyBlobAccess(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<BlobAccess | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const signatureBytes = bytes(signature);
  const payloadBytes = bytes(payload);
  if (!signatureBytes || !payloadBytes) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    signatureBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    if (
      typeof parsed.key !== 'string' ||
      !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/i.test(parsed.key) ||
      (parsed.mode !== 'GET' && parsed.mode !== 'PUT') ||
      typeof parsed.principalId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(parsed.principalId) ||
      typeof parsed.expiresAtMs !== 'number' ||
      !Number.isSafeInteger(parsed.expiresAtMs) ||
      parsed.expiresAtMs <= nowMs
    ) {
      return null;
    }
    return {
      key: parsed.key,
      principalId: parsed.principalId,
      mode: parsed.mode,
      expiresAtMs: parsed.expiresAtMs,
    };
  } catch {
    return null;
  }
}
