import { describe, expect, it } from 'vitest';
import {
  HybridClock,
  MAX_DRIFT_MS,
  XyraError,
  add,
  allocate,
  canonicalJson,
  compareHlc,
  createLogger,
  decodeHlc,
  divRound,
  formatAmount,
  isUuid,
  mulRatio,
  parseAmount,
  redact,
  sha256Hex,
  toProblem,
  uuidv7,
  uuidv7Time,
} from './index';

describe('uuidv7', () => {
  it('is a valid v7 uuid carrying its timestamp', () => {
    const id = uuidv7(1_700_000_000_000);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(uuidv7Time(id)).toBe(1_700_000_000_000);
  });
  it('is monotonic within the same millisecond', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7(1_800_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('HybridClock', () => {
  it('orders local events even when the wall clock stalls', () => {
    const c = new HybridClock('a1', () => 1000);
    const a = c.now();
    const b = c.now();
    expect(compareHlc(a, b)).toBe(-1);
    expect(decodeHlc(b)).toEqual({ ms: 1000, counter: 1, node: 'a1' });
  });
  it('advances past a received remote stamp', () => {
    const local = new HybridClock('a1', () => 1000);
    const remote = new HybridClock('b2', () => 5000).now();
    const merged = local.receive(remote);
    expect(compareHlc(merged, remote)).toBe(1);
    expect(compareHlc(local.now(), merged)).toBe(1);
  });
  it('rejects remote stamps beyond the drift bound (ADR-0003 A1 §D)', () => {
    const local = new HybridClock('a1', () => 0);
    const far = new HybridClock('b2', () => MAX_DRIFT_MS + 10).now();
    expect(() => local.receive(far)).toThrow(/drift/);
  });
  it('rejects invalid node ids', () => {
    expect(() => new HybridClock('Bad Node')).toThrow();
  });
});

describe('decimal amounts', () => {
  it('parses and formats without floating point', () => {
    const a = parseAmount('1234.5', 2);
    expect(a.units).toBe(123450n);
    expect(formatAmount(a)).toBe('1234.50');
    expect(formatAmount(parseAmount('-0.07', 2))).toBe('-0.07');
    expect(formatAmount(parseAmount('0.1', 2))).toBe('0.10');
  });
  it('refuses excess precision unless a rounding mode is given', () => {
    expect(() => parseAmount('1.005', 2)).toThrow();
    expect(formatAmount(parseAmount('1.005', 2, 'half-even'))).toBe('1.00');
    expect(formatAmount(parseAmount('1.015', 2, 'half-even'))).toBe('1.02');
    expect(formatAmount(parseAmount('1.005', 2, 'half-up'))).toBe('1.01');
  });
  it('adds exactly (0.1 + 0.2 = 0.3)', () => {
    expect(formatAmount(add(parseAmount('0.1', 2), parseAmount('0.2', 2)))).toBe('0.30');
  });
  it('rejects scale mismatch', () => {
    expect(() => add(parseAmount('1', 2), parseAmount('1', 8))).toThrow(/scale/);
  });
  it('multiplies quantity by price into a target scale with banker rounding', () => {
    // 3 shares (scale 6) × $10.125 → $30.375 → $30.38 (half-even rounds 30.375 → 30.38 since 7 is odd)
    const qty = parseAmount('3', 6);
    const r = mulRatio(qty, 10125n, 1000n, 2);
    expect(formatAmount(r)).toBe('30.38');
  });
  it('divRound handles negatives symmetrically', () => {
    expect(divRound(-5n, 2n, 'half-up')).toBe(-3n);
    expect(divRound(-5n, 2n, 'half-even')).toBe(-2n);
    expect(divRound(5n, -2n, 'down')).toBe(-2n);
  });
  it('allocates without losing a cent', () => {
    const parts = allocate(parseAmount('100.00', 2), 3);
    expect(parts.map(formatAmount)).toEqual(['33.34', '33.33', '33.33']);
    expect(parts.reduce((s, p) => s + p.units, 0n)).toBe(10000n);
  });
});

describe('problems', () => {
  it('maps known errors to stable codes and hides unknown errors', () => {
    expect(toProblem(new XyraError('FORBIDDEN', 'no')).status).toBe(403);
    const p = toProblem(new Error('secret stack detail'));
    expect(p.code).toBe('INTERNAL');
    expect(JSON.stringify(p)).not.toContain('secret stack detail');
  });
});

describe('redaction', () => {
  it('masks secrets by key and by value pattern', () => {
    const out = JSON.stringify(
      redact({
        apiKey: 'plain',
        nested: { note: 'use sk-ant-abcdefghijklmnopqrstuvwx now', dsn: 'x' },
        url: 'postgres://user:hunter2@host/db',
        auth: 'Bearer abc.def.ghi.jkl',
      }),
    );
    expect(out).not.toContain('plain');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('postgres://user:[redacted]@host/db');
  });
  it('logger emits redacted JSON lines and never throws', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), now: () => new Date(0) });
    log.info('connect', { token: 'ghp_abcdefghijklmnopqrstuvwxyz123456' });
    expect(lines[0]).not.toContain('ghp_');
    const bad = createLogger({ sink: () => { throw new Error('disk full'); } });
    expect(() => bad.error('x')).not.toThrow();
  });
});

describe('canonical json + hashing', () => {
  it('is key-order independent', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
