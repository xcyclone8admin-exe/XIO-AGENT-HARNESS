import type { LeaseRecord } from './model';

export interface LeaseBook {
  readonly leases: Readonly<Record<string, LeaseRecord>>;
}

export function emptyLeaseBook(): LeaseBook {
  return { leases: {} };
}

function validTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs >= 5_000 && ttlMs <= 5 * 60_000;
}

/** Deterministic lease operations; WorkspaceHub persists them atomically. */
export function acquireLease(
  book: LeaseBook,
  key: string,
  holder: string,
  ttlMs: number,
  nowMs = Date.now(),
): LeaseRecord | null {
  if (!validTtl(ttlMs) || !/^[A-Za-z0-9._:-]{1,256}$/.test(key)) return null;
  const existing = book.leases[key];
  if (existing && existing.expiresAtMs > nowMs && existing.holder !== holder) return null;
  return { key, holder, expiresAtMs: nowMs + ttlMs };
}

export function renewLease(
  book: LeaseBook,
  key: string,
  holder: string,
  ttlMs: number,
  nowMs = Date.now(),
): LeaseRecord | null {
  if (!validTtl(ttlMs)) return null;
  const existing = book.leases[key];
  if (!existing || existing.holder !== holder || existing.expiresAtMs <= nowMs) return null;
  return { key, holder, expiresAtMs: nowMs + ttlMs };
}
