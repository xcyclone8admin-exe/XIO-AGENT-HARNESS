import { databaseUrl, withNeonTransaction } from './neon';
import { markInvestSignalNotificationSucceeded } from './invest-signals';
import type { Env } from './index';
import type { WorkspaceHub } from './hub';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ROUTE = 'https://workspace-hub/internal/membership/revoke';
export const MAX_JOB_ATTEMPTS = 4;
const MAX_DLQ_ENVELOPE_BYTES = 100_000;

interface RevocationJobMessage {
  readonly jobId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

interface QueueNotification extends RevocationJobMessage {
  readonly payloadDigest?: string;
}

export function parseRevocationJob(value: unknown): RevocationJobMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    typeof row['jobId'] !== 'string' ||
    !UUID.test(row['jobId']) ||
    typeof row['tenantId'] !== 'string' ||
    !UUID.test(row['tenantId']) ||
    typeof row['workspaceId'] !== 'string' ||
    !UUID.test(row['workspaceId'])
  )
    return null;
  return row as unknown as RevocationJobMessage;
}

function parseQueueNotification(value: unknown): QueueNotification | null {
  const basic = parseRevocationJob(value);
  if (basic) return basic;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    typeof row['jobId'] !== 'string' ||
    !UUID.test(row['jobId']) ||
    typeof row['tenantId'] !== 'string' ||
    !UUID.test(row['tenantId']) ||
    typeof row['workspaceId'] !== 'string' ||
    !UUID.test(row['workspaceId']) ||
    typeof row['payloadDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row['payloadDigest'])
  )
    return null;
  return row as unknown as QueueNotification;
}

async function deadLetter(env: Env, body: unknown, reason: string, jobId?: string): Promise<void> {
  if (!env.DEAD_LETTER_JOBS) throw new Error('DEAD_LETTER_QUEUE_UNAVAILABLE');
  const raw = JSON.stringify(body);
  const tooLarge = new TextEncoder().encode(raw).byteLength > MAX_DLQ_ENVELOPE_BYTES;
  const envelope = {
    kind: 'cloud.dead-letter.v1',
    reason,
    receivedAt: new Date().toISOString(),
    ...(jobId ? { jobId } : {}),
    payload: tooLarge ? { truncated: true, sha256: await sha256(raw), prefix: raw.slice(0, 4096) } : body,
  };
  await env.DEAD_LETTER_JOBS.send(envelope);
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function consumeQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  fetchHub: (workspaceId: string) => DurableObjectStub<WorkspaceHub>,
): Promise<void> {
  const connectionString = databaseUrl(env);
  for (const message of batch.messages) {
    const input = parseQueueNotification(message.body);
    if (!input) {
      try {
        await deadLetter(env, message.body, 'INVALID_MESSAGE');
        message.ack();
      } catch {
        message.retry();
      }
      continue;
    }
    // A missing DB/auth binding is operational failure, so preserve the provider retry path.
    if (!connectionString || !env.HUB_INTERNAL_TOKEN) {
      message.retry();
      continue;
    }

    let terminalReason: string | null = null;
    try {
      const job = await withNeonTransaction(
        connectionString,
        { tenantId: input.tenantId, workspaceId: input.workspaceId },
        async (client) => {
          const result = await client.query<{
            job_type: string;
            payload: unknown;
            status: string;
            attempts: number;
          }>(`SELECT job_type,payload,status,attempts FROM cloud_queue_jobs WHERE id=$1 FOR UPDATE`, [
            input.jobId,
          ]);
          const row = result.rows[0];
          if (!row) return { kind: 'missing' as const };
          if (row.status === 'succeeded') return { kind: 'done' as const };
          if (row.status === 'dead') return { kind: 'dead' as const, reason: 'PREVIOUSLY_TERMINAL' };
          if (row.job_type === 'invest.signal.received') return { kind: 'signal' as const };
          const principalId =
            row.payload && typeof row.payload === 'object'
              ? (row.payload as Record<string, unknown>)['principalId']
              : undefined;
          if (
            row.job_type !== 'membership.revoked' ||
            typeof principalId !== 'string' ||
            !UUID.test(principalId)
          ) {
            await client.query(
              `UPDATE cloud_queue_jobs SET status='dead',locked_until=NULL,last_error_code='INVALID_STORED_JOB',updated_at=now()
                WHERE id=$1`,
              [input.jobId],
            );
            return { kind: 'dead' as const, reason: 'INVALID_STORED_JOB' };
          }
          const attempts = row.attempts + 1;
          if (attempts > MAX_JOB_ATTEMPTS) {
            await client.query(
              `UPDATE cloud_queue_jobs SET status='dead',attempts=$2,locked_until=NULL,last_error_code='RETRY_BUDGET_EXHAUSTED',updated_at=now()
                WHERE id=$1`,
              [input.jobId, attempts],
            );
            return { kind: 'dead' as const, reason: 'RETRY_BUDGET_EXHAUSTED' };
          }
          await client.query(
            `UPDATE cloud_queue_jobs SET status='running',attempts=$2,updated_at=now()
              WHERE id=$1 AND status IN ('pending','running')`,
            [input.jobId, attempts],
          );
          return { kind: 'work' as const, principalId };
        },
      );

      if (job.kind === 'missing') terminalReason = 'UNKNOWN_JOB';
      else if (job.kind === 'dead') terminalReason = job.reason;
      else if (job.kind === 'done') {
        message.ack();
        continue;
      } else if (job.kind === 'signal') {
        if (!input.payloadDigest) terminalReason = 'INVALID_MESSAGE';
        else {
          const accepted = await markInvestSignalNotificationSucceeded(
            connectionString,
            input.tenantId,
            input.workspaceId,
            input.jobId,
            input.payloadDigest,
          );
          if (!accepted) terminalReason = 'INVALID_STORED_JOB';
          else {
            message.ack();
            continue;
          }
        }
      } else {
        const response = await fetchHub(input.workspaceId).fetch(INTERNAL_ROUTE, {
          method: 'POST',
          body: JSON.stringify({ principalId: job.principalId }),
          headers: {
            'content-type': 'application/json',
            'x-hub-internal-token': env.HUB_INTERNAL_TOKEN,
          },
        });
        if (!response.ok) throw new Error('HUB_REVOCATION_FAILED');
        await withNeonTransaction(
          connectionString,
          { tenantId: input.tenantId, workspaceId: input.workspaceId },
          async (client) => {
            await client.query(
              `UPDATE cloud_queue_jobs SET status='succeeded',locked_until=NULL,last_error_code=NULL,updated_at=now()
                WHERE id=$1 AND status='running'`,
              [input.jobId],
            );
          },
        );
        message.ack();
        continue;
      }
    } catch {
      // Counted attempts are durable. At exhaustion, the terminal row is committed before DLQ send.
      try {
        const isTerminal = await withNeonTransaction(
          connectionString,
          { tenantId: input.tenantId, workspaceId: input.workspaceId },
          async (client) => {
            const row = await client.query<{ attempts: number; status: string }>(
              'SELECT attempts,status FROM cloud_queue_jobs WHERE id=$1 FOR UPDATE',
              [input.jobId],
            );
            if (!row.rows[0] || row.rows[0].status === 'succeeded') return false;
            const terminal = row.rows[0].attempts >= MAX_JOB_ATTEMPTS;
            await client.query(
              `UPDATE cloud_queue_jobs SET status=$2,locked_until=NULL,last_error_code=$3,updated_at=now()
                WHERE id=$1 AND status <> 'succeeded'`,
              [
                input.jobId,
                terminal ? 'dead' : 'running',
                terminal ? 'RETRY_BUDGET_EXHAUSTED' : 'DELIVERY_FAILED',
              ],
            );
            return terminal;
          },
        );
        if (isTerminal) terminalReason = 'RETRY_BUDGET_EXHAUSTED';
      } catch {
        message.retry();
        continue;
      }
      if (!terminalReason) {
        message.retry();
        continue;
      }
    }

    try {
      if (terminalReason) {
        await deadLetter(env, message.body, terminalReason, input.jobId);
        message.ack();
      } else {
        message.retry();
      }
    } catch {
      // Keep the source delivery until its durable dead-letter handoff succeeds.
      message.retry();
    }
  }
}
