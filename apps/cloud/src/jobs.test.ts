import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { consumeQueueBatch, MAX_JOB_ATTEMPTS, parseRevocationJob } from './jobs';
import type { Env } from './index';

const db = vi.hoisted(() => ({
  job: {
    status: 'pending',
    attempts: 0,
    job_type: 'membership.revoked',
    payload: { principalId: '33333333-3333-4333-8333-333333333333' },
  },
  databaseUrl: vi.fn(),
  withNeonTransaction: vi.fn(),
}));
vi.mock('./neon', () => ({ databaseUrl: db.databaseUrl, withNeonTransaction: db.withNeonTransaction }));

const config = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');

describe('Cloud queue safety', () => {
  it('uses bounded retries and a configured dead-letter queue for poison deliveries', () => {
    expect(config).toContain('"max_retries": 3');
    expect(config).toContain('"dead_letter_queue": "xyra-agent-os-local-jobs-dlq"');
    expect(config).toContain('"binding": "DEAD_LETTER_JOBS", "queue": "xyra-agent-os-local-jobs-dlq"');
  });

  it('retries a valid job instead of acknowledging it when durable dependencies are missing', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      body: {
        jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tenantId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '55555555-5555-4555-8555-555555555555',
      },
      ack,
      retry,
    };
    const batch = { messages: [message] } as unknown as MessageBatch<unknown>;
    await consumeQueueBatch(batch, {} as Env, vi.fn());
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  });

  it('rejects message field injection before it can identify a stored job', () => {
    expect(
      parseRevocationJob({
        jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tenantId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '55555555-5555-4555-8555-555555555555',
        principalId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toBeNull();
  });

  it('durably sends malformed poison to the explicit DLQ before acknowledging it', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const batch = {
      messages: [{ body: { surprise: true }, ack, retry }],
    } as unknown as MessageBatch<unknown>;
    await consumeQueueBatch(batch, { DEAD_LETTER_JOBS: { send } } as unknown as Env, vi.fn());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'INVALID_MESSAGE', payload: { surprise: true } }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries transient failures only within the durable attempt budget, then terminalizes and DLQs', async () => {
    db.job = {
      status: 'pending',
      attempts: 0,
      job_type: 'membership.revoked',
      payload: { principalId: '33333333-3333-4333-8333-333333333333' },
    };
    db.databaseUrl.mockReturnValue('postgres://test');
    db.withNeonTransaction.mockImplementation(
      async (_url: string, _scope: unknown, work: (client: unknown) => Promise<unknown>) => {
        const client = {
          query: async (sql: string, values: unknown[] = []) => {
            if (sql.includes('SELECT job_type,payload,status,attempts')) return { rows: [{ ...db.job }] };
            if (sql.includes('SELECT attempts,status'))
              return { rows: [{ attempts: db.job.attempts, status: db.job.status }] };
            if (sql.includes("SET status='running',attempts")) {
              db.job = { ...db.job, status: 'running', attempts: values[1] as number };
            } else if (sql.includes('SET status=$2')) {
              db.job = { ...db.job, status: values[1] as string };
            } else if (sql.includes("SET status='succeeded'")) {
              db.job = { ...db.job, status: 'succeeded' };
            }
            return { rows: [] };
          },
        };
        return work(client);
      },
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const retried: ReturnType<typeof vi.fn>[] = [];
    const acked: ReturnType<typeof vi.fn>[] = [];
    const fetchHub = vi.fn(() => ({ fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })) }));
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) {
      const ack = vi.fn();
      const retry = vi.fn();
      acked.push(ack);
      retried.push(retry);
      await consumeQueueBatch(
        {
          messages: [
            {
              body: {
                jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                tenantId: '11111111-1111-4111-8111-111111111111',
                workspaceId: '55555555-5555-4555-8555-555555555555',
              },
              ack,
              retry,
            },
          ],
        } as unknown as MessageBatch<unknown>,
        {
          NEON_DATABASE_URL: 'postgres://test',
          HUB_INTERNAL_TOKEN: 'token',
          DEAD_LETTER_JOBS: { send },
        } as unknown as Env,
        fetchHub as never,
      );
    }
    expect(db.job.status).toBe('dead');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ reason: 'RETRY_BUDGET_EXHAUSTED' }));
    expect(acked.at(-1)).toHaveBeenCalledOnce();
    expect(retried.slice(0, -1).every((retry) => retry.mock.calls.length === 1)).toBe(true);
    expect(retried.at(-1)).not.toHaveBeenCalled();
  });

  it('keeps the source message for retry if durable dead-letter handoff is unavailable', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeQueueBatch(
      { messages: [{ body: null, ack, retry }] } as unknown as MessageBatch<unknown>,
      {} as Env,
      vi.fn(),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  });
});
