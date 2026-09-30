import { databaseUrl, withNeonTransaction } from './neon';
import type { Env } from './index';
import type { WorkspaceHub } from './hub';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ROUTE = 'https://workspace-hub/internal/membership/revoke';

interface RevocationJobMessage {
  readonly jobId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
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

export async function consumeQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  fetchHub: (workspaceId: string) => DurableObjectStub<WorkspaceHub>,
): Promise<void> {
  const connectionString = databaseUrl(env);
  for (const message of batch.messages) {
    const input = parseRevocationJob(message.body);
    if (!input || !connectionString || !env.HUB_INTERNAL_TOKEN) {
      message.retry();
      continue;
    }
    try {
      const job = await withNeonTransaction(
        connectionString,
        { tenantId: input.tenantId, workspaceId: input.workspaceId },
        async (client) => {
          const result = await client.query<{
            job_type: string;
            payload: unknown;
            status: string;
          }>(
            `SELECT job_type,payload,status FROM cloud_queue_jobs WHERE id=$1 FOR UPDATE`,
            [input.jobId],
          );
          const row = result.rows[0];
          if (!row) return { kind: 'invalid' as const };
          if (row.status === 'succeeded') return { kind: 'done' as const };
          if (
            row.job_type !== 'membership.revoked' ||
            !row.payload ||
            typeof row.payload !== 'object' ||
            typeof (row.payload as Record<string, unknown>)['principalId'] !== 'string' ||
            !UUID.test((row.payload as Record<string, unknown>)['principalId'] as string)
          )
            return { kind: 'invalid' as const };
          await client.query(
            `UPDATE cloud_queue_jobs SET status='running',attempts=attempts+1,updated_at=now()
              WHERE id=$1 AND status IN ('pending','running')`,
            [input.jobId],
          );
          return {
            kind: 'work' as const,
            principalId: (row.payload as Record<string, string>)['principalId'] as string,
          };
        },
      );
      if (job.kind === 'invalid') {
        message.retry();
        continue;
      }
      if (job.kind === 'work') {
        const hub = fetchHub(input.workspaceId);
        const response = await hub.fetch(INTERNAL_ROUTE, {
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
      }
      message.ack();
    } catch {
      // The Queue owns bounded retry and DLQ delivery; the DB operation and Hub revoke are idempotent.
      message.retry();
    }
  }
}
