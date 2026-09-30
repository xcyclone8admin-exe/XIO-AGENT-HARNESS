import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { consumeQueueBatch, parseRevocationJob } from './jobs';
import type { Env } from './index';

const config = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');

describe('Cloud queue safety', () => {
  it('uses bounded retries and a configured dead-letter queue for poison deliveries', () => {
    expect(config).toContain('"max_retries": 3');
    expect(config).toContain('"dead_letter_queue": "xyra-agent-os-local-jobs-dlq"');
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
    expect(parseRevocationJob({
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '55555555-5555-4555-8555-555555555555',
      principalId: '33333333-3333-4333-8333-333333333333',
    })).toBeNull();
  });
});
