import { z } from 'zod';

/** Honest connector states (XIO README §5; ADR-0011). There is deliberately no "demo" or "simulated" state. */
export const CONNECTOR_STATES = ['CONNECTED', 'NOT_CONFIGURED', 'DEGRADED', 'ERROR', 'REAUTH_REQUIRED', 'DISABLED'] as const;
export const ConnectorState = z.enum(CONNECTOR_STATES);
export type ConnectorState = z.infer<typeof ConnectorState>;

export const ConnectorStatus = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string(),
  state: ConnectorState,
  /** Human explanation; never contains secret material. */
  detail: z.string(),
  /** When the live probe that justifies CONNECTED ran. Required for CONNECTED. */
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Implementation availability in this build. */
  availability: z.enum(['available', 'not-yet-available']),
  custody: z.enum(['local-keychain', 'cloud-envelope', 'none']),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/** Default freshness window for CONNECTED (provisional threshold, XIO-REQ-PLT-003). */
export const CONNECTED_TTL_MS = 15 * 60_000;

/** A status is honest when CONNECTED is backed by a fresh probe and unavailable connectors never claim a live state. */
export function isHonestStatus(s: ConnectorStatus, now: Date, ttlMs = CONNECTED_TTL_MS): boolean {
  if (s.availability === 'not-yet-available') return s.state === 'NOT_CONFIGURED' || s.state === 'DISABLED';
  if (s.state !== 'CONNECTED') return true;
  if (!s.checkedAt) return false;
  return now.getTime() - new Date(s.checkedAt).getTime() <= ttlMs;
}
