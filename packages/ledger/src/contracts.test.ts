import { describe, expect, test } from 'vitest';
import { defineModule, validateColumnValue } from '@xyra/contracts';
import {
  Asset,
  BalanceQuery,
  DiscrepancyQuery,
  LEDGER_PERMISSIONS,
  LEDGER_TABLES,
  MinorUnits,
  NonZeroMinorUnits,
  PostTransactionInput,
  ReconcileInput,
  TotalsQuery,
  TransactionQuery,
  TrialBalanceQuery,
  ledgerCapabilities,
} from './index';
import {
  MAX_UNITS,
  applyBps,
  decimalToUnits,
  fromUnits,
  multiplyUnits,
  rescaleUnits,
  sumUnits,
  toUnits,
  unitsToDecimal,
} from './index';

const id = '0199aaba-0000-7000-8000-000000000001';

describe('frozen ledger wire contract', () => {
  test('rejects lossy encodings, negative zero and numeric(38,0) overflow', () => {
    for (const bad of ['-0', '+1', '01', '1.0', '1e3', '', ' 1', '1' + '0'.repeat(38), 1, 0.1]) {
      expect(MinorUnits.safeParse(bad).success, String(bad)).toBe(false);
    }
    for (const good of ['0', '1', '-1', MAX_UNITS.toString(), (-MAX_UNITS).toString()]) {
      expect(MinorUnits.parse(good)).toBe(good);
      expect(fromUnits(toUnits(good))).toBe(good);
    }
    expect(NonZeroMinorUnits.safeParse('0').success).toBe(false);
    expect(NonZeroMinorUnits.safeParse('-0').success).toBe(false);
  });

  test('every aggregate requires an explicit environment', () => {
    for (const schema of [
      BalanceQuery,
      TrialBalanceQuery,
      TotalsQuery,
      ReconcileInput,
      TransactionQuery,
      DiscrepancyQuery,
    ]) {
      expect(schema.safeParse({ bookId: id, asset: 'USD' }).success).toBe(false);
      expect(schema.safeParse({ bookId: id, asset: 'USD', environment: 'actual' }).success).toBe(true);
      expect(schema.safeParse({ bookId: id, asset: 'USD', environment: 'paper' }).success).toBe(true);
    }
  });

  test('asset scale is an integer bounded at 18', () => {
    for (const scale of [-1, 0.5, 19])
      expect(Asset.safeParse({ code: 'USD', name: 'Dollar', kind: 'fiat', scale }).success).toBe(false);
    for (const scale of [0, 2, 8, 18])
      expect(Asset.parse({ code: 'USD', name: 'Dollar', kind: 'fiat', scale }).scale).toBe(scale);
  });

  test('one posting fits the 500-row atomic sync limit', () => {
    const input = {
      id,
      bookId: id,
      environment: 'paper',
      effectiveDate: '2026-09-30',
      description: 'Posting',
      source: 'invest',
    };
    const entry = { accountId: id, asset: 'USD', units: '1' };
    expect(PostTransactionInput.safeParse({ ...input, entries: Array(499).fill(entry) }).success).toBe(true);
    expect(PostTransactionInput.safeParse({ ...input, entries: Array(500).fill(entry) }).success).toBe(false);
    expect(PostTransactionInput.safeParse({ ...input, entries: [entry] }).success).toBe(false);
  });

  test('table declarations meet the shared typed sync and permission contract', () => {
    const manifest = defineModule({
      id: 'money',
      version: '1.0.0',
      title: 'Money',
      description: 'Ledger',
      pillar: 'MONEY',
      icon: 'wallet',
      permissions: [...LEDGER_PERMISSIONS],
      tables: [...LEDGER_TABLES],
    });
    expect(manifest.tables).toHaveLength(8);
    for (const table of manifest.tables) {
      expect(table.readPermission).toBe('money:ledger:read');
      if (table.authority === 'append') {
        expect(table.receivedAtField).toBeTruthy();
        expect(table.actorField).toBeTruthy();
      }
    }
    const spec = manifest.tables.find((t) => t.name === 'ledger_entries')?.columns?.units;
    expect(spec).toBeDefined();
    if (!spec) throw new Error('missing units spec');
    expect(validateColumnValue(spec, MAX_UNITS.toString())).toBeNull();
    expect(validateColumnValue(spec, '0.1')).toBe('SCALE');
    expect(validateColumnValue(spec, (MAX_UNITS + 1n).toString())).toBe('RANGE');
    for (const cap of Object.values(ledgerCapabilities))
      expect(manifest.permissions).toContain(cap.permission);
  });
});

describe('exact minor-unit arithmetic', () => {
  test('balances 10,000 deterministic generated journals independently per asset', () => {
    // Xorshift64* gives a reproducible integer-only corpus; no floating-point oracle is involved.
    let state = 0x9e3779b97f4a7c15n;
    const next = () => {
      state ^= state >> 12n; state ^= state << 25n; state ^= state >> 27n;
      return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn);
    };
    const assets = ['USD', 'BTC', 'EQ:ACME'];
    for (let index = 0; index < 10_000; index++) {
      const entries = assets.flatMap((asset, assetIndex) => {
        const magnitude = next() % 1_000_000_000_000n + 1n;
        const units = assetIndex % 2 ? -magnitude : magnitude;
        return [
          { accountId: id, asset, units: units.toString() },
          { accountId: `0199aaba-0000-7000-8000-${(assetIndex + 2).toString().padStart(12, '0')}`, asset, units: (-units).toString() },
        ];
      });
      const journal = PostTransactionInput.parse({ id, bookId: id, environment: 'paper', effectiveDate: '2026-09-30',
        description: `generated journal ${index}`, source: 'property-test', entries });
      const totals = new Map<string, bigint>();
      for (const entry of journal.entries) totals.set(entry.asset, (totals.get(entry.asset) ?? 0n) + BigInt(entry.units));
      expect([...totals.values()].every((total) => total === 0n), `journal ${index}`).toBe(true);
    }
  });

  test('round trips amounts well beyond Number.MAX_SAFE_INTEGER at every supported scale', () => {
    // Deterministic generated cases, no dependency on a random seed or a floating-point oracle.
    for (let scale = 0; scale <= 18; scale++) {
      for (let i = -100n; i <= 100n; i++) {
        const amount = i * 9_007_199_254_740_993n + i;
        expect(decimalToUnits(unitsToDecimal(amount, scale), scale)).toBe(amount);
        expect(toUnits(fromUnits(amount))).toBe(amount);
      }
    }
  });

  test('rounding is explicit and symmetric for negative values', () => {
    expect(() => decimalToUnits('1.005', 2)).toThrow(/exceeds scale/);
    expect(decimalToUnits('1.005', 2, 'half-even')).toBe(100n);
    expect(decimalToUnits('1.015', 2, 'half-even')).toBe(102n);
    expect(decimalToUnits('-1.005', 2, 'half-up')).toBe(-101n);
    expect(rescaleUnits(-105n, 2, 1, 'down')).toBe(-10n);
    expect(rescaleUnits(-105n, 2, 1, 'up')).toBe(-11n);
    expect(multiplyUnits(1_500_000n, 6, 10_001n, 2, 2, 'half-even')).toBe(15_002n);
    expect(applyBps(-10_000n, 25n, 'half-even')).toBe(-25n);
  });

  test('all storage-facing results reject overflow', () => {
    for (const compute of [
      () => fromUnits(MAX_UNITS + 1n),
      () => unitsToDecimal(MAX_UNITS + 1n, 0),
      () => decimalToUnits(MAX_UNITS.toString(), 1),
      () => rescaleUnits(MAX_UNITS, 0, 1, 'down'),
      () => multiplyUnits(MAX_UNITS, 0, 2n, 0, 0, 'down'),
      () => applyBps(MAX_UNITS, 20_000n, 'down'),
      () => sumUnits([MAX_UNITS, 1n]),
    ])
      expect(compute).toThrow(/numeric\(38,0\)/);
    expect(sumUnits([MAX_UNITS, MAX_UNITS, -MAX_UNITS])).toBe(MAX_UNITS);
  });
});
