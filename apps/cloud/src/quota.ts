/** Fixed-window request and ingress-byte quotas enforced inside the workspace Durable Object. */
export interface QuotaLimits {
  readonly requestsPerMinute: number;
  readonly bytesPerMinute: number;
}

export const PRINCIPAL_QUOTA: QuotaLimits = { requestsPerMinute: 240, bytesPerMinute: 16 * 1024 * 1024 };
export const WORKSPACE_QUOTA: QuotaLimits = { requestsPerMinute: 2_400, bytesPerMinute: 64 * 1024 * 1024 };
export const ENDPOINT_QUOTA: QuotaLimits = { requestsPerMinute: 1_200, bytesPerMinute: 32 * 1024 * 1024 };
export const QUOTA_WINDOW_MS = 60_000;

/** Repeated clock-skew offenders are quarantined per device (ADR-0003 A1 §D). */
export const SKEW_STRIKES = 5;
export const SKEW_WINDOW_MS = 10 * 60_000;
export const SKEW_QUARANTINE_MS = 60 * 60_000;

export interface QuotaWindow {
  readonly windowStart: number;
  readonly requests: number;
  readonly bytes: number;
}

export type QuotaResult =
  { readonly ok: true; readonly next: QuotaWindow } | { readonly ok: false; readonly retryAfterSec: number };

export function consume(
  current: QuotaWindow | undefined,
  limits: QuotaLimits,
  bytes: number,
  nowMs: number,
): QuotaResult {
  const window =
    current && nowMs - current.windowStart < QUOTA_WINDOW_MS
      ? current
      : { windowStart: nowMs, requests: 0, bytes: 0 };
  const next = {
    windowStart: window.windowStart,
    requests: window.requests + 1,
    bytes: window.bytes + bytes,
  };
  if (next.requests > limits.requestsPerMinute || next.bytes > limits.bytesPerMinute) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((window.windowStart + QUOTA_WINDOW_MS - nowMs) / 1000)),
    };
  }
  return { ok: true, next };
}

/** An env override may only lower a limit, never raise it. */
export function lowered(
  limits: QuotaLimits,
  requestsPerMinute: string | undefined,
  bytesPerMinute?: string,
): QuotaLimits {
  const override = Number(requestsPerMinute);
  const bytes = Number(bytesPerMinute);
  return {
    requestsPerMinute:
      Number.isInteger(override) && override > 0 && override < limits.requestsPerMinute
        ? override
        : limits.requestsPerMinute,
    bytesPerMinute:
      Number.isInteger(bytes) && bytes > 0 && bytes < limits.bytesPerMinute ? bytes : limits.bytesPerMinute,
  };
}
