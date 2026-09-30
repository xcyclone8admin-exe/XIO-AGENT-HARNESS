import { describe, expect, it } from 'vitest';
import { compareHlc, encodeHlc, MAX_DRIFT_MS } from '@xyra/core';
import { HLC_PATTERN, MAX_HLC_DRIFT_MS, PullResponse, PushRequest, PushResponse } from './sync';

const tenantId = '019a0000-0000-7000-8000-000000000001';
const workspaceId = '019a0000-0000-7000-8000-000000000011';
const hlc = encodeHlc({ ms: 1_790_000_000_000, counter: 3, node: 'devicea' });
const change = {
  table: 'ops_tasks',
  id: '019a0000-0000-7000-8000-000000000101',
  tenantId,
  workspaceId,
  op: 'upsert',
  fields: { title: { value: 'Ship', hlc, baseHlc: null } },
  hlc,
} as const;
const push = {
  protocolVersion: 1,
  schemaVersion: 'cloud-sync-v1',
  nodeId: 'devicea',
  idempotencyKey: 'push-0000000000000001',
  changes: [change],
};

describe('cloud-sync-v1 wire contract', () => {
  it('accepts clocks produced by the shared HLC encoder, in code-point order', () => {
    expect(HLC_PATTERN.test(hlc)).toBe(true);
    expect(MAX_HLC_DRIFT_MS).toBe(MAX_DRIFT_MS);
    const later = encodeHlc({ ms: 1_790_000_000_000, counter: 3, node: 'deviceb' });
    expect(compareHlc(hlc, later)).toBeLessThan(0);
  });

  it('requires protocol, schema version and an idempotency key', () => {
    expect(PushRequest.parse(push).changes).toHaveLength(1);
    expect(() => PushRequest.parse({ ...push, protocolVersion: 2 })).toThrow();
    expect(() => PushRequest.parse({ ...push, schemaVersion: 'cloud-sync-v0' })).toThrow();
    expect(() => PushRequest.parse({ ...push, idempotencyKey: 'short' })).toThrow();
    expect(() =>
      PushRequest.parse({ ...push, changes: [{ ...change, hlc: '2026-09-30T00:00:00Z' }] }),
    ).toThrow();
  });

  it('carries per-row rejections, conflict history and decimal sequence numbers', () => {
    const response = PushResponse.parse({
      accepted: 0,
      conflicts: 0,
      serverSeq: '18446744073709551615',
      rejected: [{ index: 0, changeId: change.id, code: 'KILL_SWITCH_ENGAGED' }],
      conflictHistory: [],
      replayed: false,
    });
    expect(response.rejected[0]?.code).toBe('KILL_SWITCH_ENGAGED');
    expect(() => PullResponse.parse({ changes: [], cursor: '', more: false, serverSeq: '0' })).toThrow();
    expect(
      PullResponse.parse({ changes: [{ seq: '1', change }], cursor: 'djE6MQ', more: false, serverSeq: '1' })
        .changes[0]?.seq,
    ).toBe('1');
  });
});
