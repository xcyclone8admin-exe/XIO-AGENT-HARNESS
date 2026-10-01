import { withNeonTransaction } from './neon';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export type MembershipRevokedEvent = {
  readonly id: string;
  readonly type: 'membership.revoked';
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
};

export class WebhookError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 409 | 413 | 503,
  ) {
    super(code);
  }
}

export async function parseAndVerifyMembershipWebhook(
  request: Request,
  secret: string,
  nowMs = Date.now(),
): Promise<{ event: MembershipRevokedEvent; bodyHash: string }> {
  if (!secret) throw new WebhookError('WEBHOOK_NOT_CONFIGURED', 503);
  const raw = await readBounded(request, MAX_WEBHOOK_BYTES);
  const timestampText = request.headers.get('x-xyra-timestamp') ?? '';
  const signatureText = request.headers.get('x-xyra-signature') ?? '';
  if (!/^\d{10}$/.test(timestampText) || !/^[0-9a-f]{64}$/i.test(signatureText))
    throw new WebhookError('WEBHOOK_SIGNATURE_INVALID', 401);
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS)
    throw new WebhookError('WEBHOOK_TIMESTAMP_INVALID', 401);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = Uint8Array.from(signatureText.match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  const signed = new Uint8Array(new TextEncoder().encode(`${timestampText}.`).length + raw.length);
  const prefix = new TextEncoder().encode(`${timestampText}.`);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  if (!(await crypto.subtle.verify('HMAC', key, signature, signed)))
    throw new WebhookError('WEBHOOK_SIGNATURE_INVALID', 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new WebhookError('WEBHOOK_BODY_INVALID', 400);
  }
  if (!isMembershipRevokedEvent(parsed)) throw new WebhookError('WEBHOOK_EVENT_UNSUPPORTED', 400);
  const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw.slice().buffer as ArrayBuffer))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return { event: parsed, bodyHash };
}

function isMembershipRevokedEvent(value: unknown): value is MembershipRevokedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    event['type'] === 'membership.revoked' &&
    typeof event['id'] === 'string' &&
    EVENT_ID.test(event['id']) &&
    typeof event['tenantId'] === 'string' &&
    UUID.test(event['tenantId']) &&
    typeof event['workspaceId'] === 'string' &&
    UUID.test(event['workspaceId']) &&
    typeof event['principalId'] === 'string' &&
    UUID.test(event['principalId']) &&
    Object.keys(event).every((key) => ['id', 'type', 'tenantId', 'workspaceId', 'principalId'].includes(key))
  );
}

async function readBounded(request: Request, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length < 0) throw new WebhookError('WEBHOOK_LENGTH_REQUIRED', 400);
  if (length > limit) throw new WebhookError('WEBHOOK_BODY_TOO_LARGE', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new WebhookError('WEBHOOK_BODY_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== length) throw new WebhookError('WEBHOOK_LENGTH_MISMATCH', 400);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Persist receipt + idempotent outbox row atomically; Queue send is retried on webhook duplicates. */
export async function acceptMembershipRevokedWebhook(
  connectionString: string,
  event: MembershipRevokedEvent,
  bodyHash: string,
): Promise<string> {
  const jobId = await withNeonTransaction(
    connectionString,
    { tenantId: event.tenantId, workspaceId: event.workspaceId },
    async (client) => {
      const receipt = await client.query(
        `INSERT INTO cloud_webhook_receipts(provider,event_id,payload_hash)
         VALUES ('xyra-membership',$1,decode($2,'hex'))
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [event.id, bodyHash],
      );
      if (!receipt.rows.length) {
        const existing = await client.query<{ payload_hash: string }>(
          `SELECT encode(payload_hash,'hex') AS payload_hash FROM cloud_webhook_receipts
            WHERE provider='xyra-membership' AND event_id=$1`,
          [event.id],
        );
        if (existing.rows[0]?.payload_hash !== bodyHash) throw new WebhookError('WEBHOOK_EVENT_ID_REUSED', 409);
      }
      await client.query(
        `INSERT INTO cloud_queue_jobs
          (id,tenant_id,workspace_id,job_type,idempotency_key,payload,status)
         VALUES (gen_random_uuid(),$1,$2,'membership.revoked',$3,$4::jsonb,'pending')
         ON CONFLICT (tenant_id,workspace_id,job_type,idempotency_key) DO NOTHING`,
        [event.tenantId, event.workspaceId, event.id, JSON.stringify({ principalId: event.principalId })],
      );
      const job = await client.query<{ id: string }>(
        `SELECT id::text FROM cloud_queue_jobs
          WHERE tenant_id=$1 AND workspace_id=$2 AND job_type='membership.revoked' AND idempotency_key=$3`,
        [event.tenantId, event.workspaceId, event.id],
      );
      if (!job.rows[0]) throw new WebhookError('WEBHOOK_QUEUE_UNAVAILABLE', 503);
      return job.rows[0].id;
    },
  );
  return jobId;
}
