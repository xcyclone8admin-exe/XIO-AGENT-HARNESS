import { describe, expect, it } from 'vitest';
import { compareHlc as coreCompareHlc } from '@xyra/core';
import { compareHlc } from './sync';
import { acquireLease, renewLease } from './leases';

describe('shared ordering and lease invariants', () => {
  it('uses the same total HLC order as devices for mixed node ids', () => {
    const nodes = ['a', 'b0', 'b', '0', '9', 'a9', 'a10', 'z'];
    const stamps = nodes.flatMap((node) => [`1800000000000-0000-${node}`, `1800000000000-0001-${node}`]);
    for (const a of stamps)
      for (const b of stamps) expect(Math.sign(compareHlc(a, b))).toBe(coreCompareHlc(a, b));
  });

  it('binds renewal to the device and lease token and increases the next fence', () => {
    const a = { principalId: 'u', deviceId: 'device-a' };
    const b = { principalId: 'u', deviceId: 'device-b' };
    const first = acquireLease(undefined, 'job:x', a, 10_000, 1_000, 'token-a', 1);
    expect(first?.fence).toBe(1);
    expect(acquireLease(first ?? undefined, 'job:x', b, 10_000, 1_001, 'token-b', 2)).toBeNull();
    expect(renewLease(first ?? undefined, b, 'token-a', 10_000, 1_001)).toBeNull();
    expect(renewLease(first ?? undefined, a, 'token-b', 10_000, 1_001)).toBeNull();
    expect(renewLease(first ?? undefined, a, 'token-a', 10_000, 1_001)?.fence).toBe(1);
    expect(acquireLease(first ?? undefined, 'job:x', b, 10_000, 11_000, 'token-b', 2)?.fence).toBe(2);
  });
});
