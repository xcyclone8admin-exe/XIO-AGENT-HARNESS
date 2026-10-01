import { z } from 'zod';

/** Domain event envelope (ARCHITECTURE §5). Payload schemas live in module contracts. */
export const EventEnvelope = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/),
  v: z.number().int().positive(),
  ts: z.iso.datetime({ offset: true }),
  tenantId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  actor: z.object({ kind: z.enum(['user', 'agent', 'system']), id: z.uuid() }),
  traceId: z.string().optional(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export interface EventDescriptor<P extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly v: number;
  readonly payload: P;
  /** Events containing personal data are minimized (Protocol 05 §176). */
  readonly containsPersonalData?: boolean;
}

export function defineEvent<P extends z.ZodType>(
  type: string,
  v: number,
  payload: P,
  opts?: { containsPersonalData?: boolean },
): EventDescriptor<P> {
  return { type, v, payload, ...(opts ?? {}) };
}

/** Messages pushed to the UI over the sidecar WebSocket. */
export const StreamMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: EventEnvelope }),
  z.object({ kind: z.literal('hello'), sessionId: z.string(), serverTime: z.string() }),
  z.object({ kind: z.literal('ping'), t: z.number() }),
]);
export type StreamMessage = z.infer<typeof StreamMessage>;
