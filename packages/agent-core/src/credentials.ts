import type { DelegatedCredential } from './contracts';

/** Deny expired or revoked references before a tool/client can ask the secret broker for material. */
export function credentialIsActive(credential: DelegatedCredential, now: Date): boolean {
  return credential.revokedAt === null && new Date(credential.expiresAt).getTime() > now.getTime();
}

export function requireActiveCredential(credential: DelegatedCredential, now: Date): void {
  if (!credentialIsActive(credential, now)) throw new Error('CREDENTIAL_EXPIRED_OR_REVOKED');
}
