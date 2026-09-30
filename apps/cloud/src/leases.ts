import type { LeaseRecord } from './model';

export const LEASE_KEY = /^[A-Za-z0-9._:-]{1,256}$/;
export const MIN_LEASE_TTL_MS = 5_000;
export const MAX_LEASE_TTL_MS = 5 * 60_000;

/** Allow-listed client input; identity never comes from here (CLD-R-001). */
export interface LeaseInput {
  readonly key: string;
  readonly ttlMs: number;
  readonly token?: string;
}

const TOKEN = /^[0-9a-f-]{36}$/;

/** Strictly parses a lease body: any property beyond key/ttlMs/token (e.g. `claims`) is refused. */
export function parseLeaseInput(value: unknown, requireToken: boolean): LeaseInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'key' && key !== 'ttlMs' && key !== 'token')) return null;
  const { key, ttlMs, token } = body;
  if (typeof key !== 'string' || !LEASE_KEY.test(key)) return null;
  if (requireToken ? typeof token !== 'string' || !TOKEN.test(token) : token !== undefined) return null;
  if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !validTtl(ttlMs))) return null;
  return {
    key,
    ttlMs: typeof ttlMs === 'number' ? ttlMs : MIN_LEASE_TTL_MS,
    ...(typeof token === 'string' ? { token } : {}),
  };
}

export function validTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs >= MIN_LEASE_TTL_MS && ttlMs <= MAX_LEASE_TTL_MS;
}

export interface LeaseHolder {
  readonly principalId: string;
  readonly deviceId: string;
}

/**
 * Exactly one executing device per key (ADR-0003 A1 §H). A live lease is never re-granted, not even
 * to its own holder: the holder renews with its token. `nextFence` must be strictly larger than any
 * fence previously issued in the workspace.
 */
export function acquireLease(
  existing: LeaseRecord | undefined,
  key: string,
  holder: LeaseHolder,
  ttlMs: number,
  nowMs: number,
  token: string,
  nextFence: number,
): LeaseRecord | null {
  if (!validTtl(ttlMs) || !LEASE_KEY.test(key)) return null;
  if (existing && existing.expiresAtMs > nowMs) return null;
  return { key, ...holder, token, fence: nextFence, expiresAtMs: nowMs + ttlMs };
}

/** Renewal needs the same device and the grant's token; the fence is unchanged. */
export function renewLease(
  existing: LeaseRecord | undefined,
  holder: LeaseHolder,
  token: string,
  ttlMs: number,
  nowMs: number,
): LeaseRecord | null {
  if (!validTtl(ttlMs) || !existing || existing.expiresAtMs <= nowMs) return null;
  if (
    existing.token !== token ||
    existing.principalId !== holder.principalId ||
    existing.deviceId !== holder.deviceId
  )
    return null;
  return { ...existing, expiresAtMs: nowMs + ttlMs };
}

export function mayRelease(existing: LeaseRecord | undefined, holder: LeaseHolder, token: string): boolean {
  return (
    existing !== undefined &&
    existing.token === token &&
    existing.principalId === holder.principalId &&
    existing.deviceId === holder.deviceId
  );
}
