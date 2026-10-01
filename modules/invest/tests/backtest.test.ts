import { expect, test } from 'vitest';
import { runMomentumStopTargetBacktest, type OhlcBar } from '../server/backtest';

const bar = (at: string, openUnits: string, highUnits: string, lowUnits: string, closeUnits: string): OhlcBar => ({ at, openUnits, highUnits, lowUnits, closeUnits });
const strategy = { id: 'golden-momentum', version: 3, quantityUnits: '1', stopBps: 500, targetBps: 1000, feeBps: 100 };
const rising = [
  bar('2026-01-01T00:00:00.000Z','100','105','95','100'),
  bar('2026-01-02T00:00:00.000Z','100','112','99','110'),
];

test('signals use completed bars and enter at the next bar open; costs are explicit and bit-identical', () => {
  const noNextBar = runMomentumStopTargetBacktest(rising,strategy,0);
  expect(noNextBar.trades).toEqual([]);
  const bars = [...rising,bar('2026-01-03T00:00:00.000Z','120','140','115','130')];
  const first = runMomentumStopTargetBacktest(bars,strategy,0);
  const second = runMomentumStopTargetBacktest(bars,strategy,0);
  expect(first).toEqual(second);
  expect(first.trades).toEqual([{entryBar:2,exitBar:2,entryPriceUnits:'120',exitPriceUnits:'132',quantityUnits:'1',grossPnlUnits:'12',feesUnits:'4',netPnlUnits:'8',exitReason:'target'}]);
  expect(first.totalFeesUnits).toBe('4');
});

test('same-bar stop and target resolves pessimistically at stop', () => {
  const bars = [...rising,bar('2026-01-03T00:00:00.000Z','120','140','100','130')];
  const result = runMomentumStopTargetBacktest(bars,strategy,0);
  expect(result.trades[0]).toMatchObject({entryPriceUnits:'120',exitPriceUnits:'114',exitReason:'stop',grossPnlUnits:'-6',feesUnits:'4',netPnlUnits:'-10'});
});

test('invalid ordering, OHLC ranges, versions and quantity are rejected', () => {
  expect(() => runMomentumStopTargetBacktest([rising[1]!,rising[0]!],strategy,0)).toThrow(/strictly increasing/);
  expect(() => runMomentumStopTargetBacktest([...rising,bar('2026-01-03T00:00:00.000Z','120','110','100','130')],strategy,0)).toThrow(/inconsistent/);
  expect(() => runMomentumStopTargetBacktest(rising,{...strategy,version:0},0)).toThrow(/strategy version/);
  expect(() => runMomentumStopTargetBacktest(rising,{...strategy,quantityUnits:'0'},0)).toThrow(/positive integer/);
});
