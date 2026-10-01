import { createHash } from 'node:crypto';
import { notionalUnits } from './risk';

export type OhlcBar = { at: string; openUnits: string; highUnits: string; lowUnits: string; closeUnits: string };
export type MomentumStopTargetStrategy = { id: string; version: number; quantityUnits: string; stopBps: number; targetBps: number; feeBps: number };
export type BacktestTrade = { entryBar: number; exitBar: number; entryPriceUnits: string; exitPriceUnits: string; quantityUnits: string; grossPnlUnits: string; feesUnits: string; netPnlUnits: string; exitReason: 'stop'|'target'|'end_of_data' };
export type BacktestResult = { engineVersion: 'momentum-next-bar-v1'; dataHash: string; strategyHash: string; trades: BacktestTrade[]; totalFeesUnits: string; netPnlUnits: string };
export const BACKTEST_ENGINE_VERSION = 'momentum-next-bar-v1' as const;
export const BACKTEST_IDENTITY_VERSION = 'invest-strategy-identity-v2' as const;

export function backtestStrategyIdentity(strategy: MomentumStopTargetStrategy, quantityScale: number) {
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 18) throw new RangeError('Invalid quantity scale');
  return { identityVersion: BACKTEST_IDENTITY_VERSION, engineVersion: BACKTEST_ENGINE_VERSION, strategy, quantityScale };
}

const integer = (value: string, label: string, positive = true) => {
  if (!/^(0|[1-9]\d{0,37})$/.test(value) || (positive && BigInt(value) <= 0n)) throw new RangeError(`${label} must be a canonical ${positive ? 'positive' : 'non-negative'} integer`);
  return BigInt(value);
};
const feeFor = (notional: bigint, bps: number) => (notional * BigInt(bps) + 9_999n) / 10_000n;
const canonicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * A deliberately small long-only benchmark strategy. A rising completed close
 * signals entry on the next bar's open. Exits use intrabar stop/target bounds;
 * when both are touched the stop wins. All prices and fees are integer units.
 */
export function runMomentumStopTargetBacktest(barsInput: readonly OhlcBar[], strategyInput: MomentumStopTargetStrategy, quantityScale: number): BacktestResult {
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 18) throw new RangeError('Invalid quantity scale');
  if (barsInput.length < 2 || barsInput.length > 10_000) throw new RangeError('Backtest requires 2 to 10000 bars');
  if (!Number.isInteger(strategyInput.version) || strategyInput.version < 1 || strategyInput.version > 2_147_483_647) throw new RangeError('Invalid strategy version');
  if (!strategyInput.id.trim() || strategyInput.id.length > 120) throw new RangeError('Invalid strategy id');
  if (!Number.isInteger(strategyInput.stopBps) || strategyInput.stopBps < 1 || strategyInput.stopBps > 9_999 ||
      !Number.isInteger(strategyInput.targetBps) || strategyInput.targetBps < 1 || strategyInput.targetBps > 100_000 ||
      !Number.isInteger(strategyInput.feeBps) || strategyInput.feeBps < 0 || strategyInput.feeBps > 2_000) throw new RangeError('Invalid stop, target, or fee basis points');
  const quantity = integer(strategyInput.quantityUnits, 'quantity');
  const bars = barsInput.map((bar, index) => {
    const time = Date.parse(bar.at);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== bar.at) throw new RangeError(`Bar ${index} time must be canonical UTC ISO`);
    const open = integer(bar.openUnits, `bar ${index} open`); const high = integer(bar.highUnits, `bar ${index} high`);
    const low = integer(bar.lowUnits, `bar ${index} low`); const close = integer(bar.closeUnits, `bar ${index} close`);
    if (high < open || high < close || low > open || low > close || low > high) throw new RangeError(`Bar ${index} OHLC values are inconsistent`);
    if (index && Date.parse(barsInput[index - 1]!.at) >= time) throw new RangeError('Bars must be strictly increasing by time');
    return { open, high, low, close, at: bar.at };
  });
  const stopBps = BigInt(strategyInput.stopBps); const targetBps = BigInt(strategyInput.targetBps);
  const trades: BacktestTrade[] = [];
  let position: { entryBar: number; entry: bigint; stop: bigint; target: bigint; entryFee: bigint } | undefined;
  let totalFees = 0n; let netPnl = 0n;
  const closeTrade = (barIndex: number, exitPrice: bigint, exitReason: BacktestTrade['exitReason']) => {
    if (!position) return;
    const cost = notionalUnits(quantity.toString(), position.entry.toString(), quantityScale);
    const proceeds = notionalUnits(quantity.toString(), exitPrice.toString(), quantityScale);
    const exitFee = feeFor(proceeds, strategyInput.feeBps); const fees = position.entryFee + exitFee;
    const gross = proceeds - cost; const net = gross - fees;
    trades.push({ entryBar: position.entryBar, exitBar: barIndex, entryPriceUnits: position.entry.toString(), exitPriceUnits: exitPrice.toString(),
      quantityUnits: quantity.toString(), grossPnlUnits: gross.toString(), feesUnits: fees.toString(), netPnlUnits: net.toString(), exitReason });
    totalFees += fees; netPnl += net; position = undefined;
  };

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index]!; let exited = false;
    if (position) {
      const stopped = bar.low <= position.stop; const targeted = bar.high >= position.target;
      if (stopped) {
        // A gap below the stop receives the worse open; simultaneous stop and
        // target touch always resolves at the stop for pessimistic accounting.
        closeTrade(index, bar.open < position.stop ? bar.open : position.stop, 'stop'); exited = true;
      } else if (targeted) {
        closeTrade(index, position.target, 'target'); exited = true;
      } else if (index === bars.length - 1) {
        closeTrade(index, bar.close, 'end_of_data'); exited = true;
      }
    }
    if (!position && !exited && index >= 2 && bars[index - 1]!.close > bars[index - 2]!.close) {
      const entry = bar.open;
      const stop = entry * (10_000n - stopBps) / 10_000n;
      const target = (entry * (10_000n + targetBps) + 9_999n) / 10_000n;
      if (stop <= 0n) throw new RangeError('Stop price rounds to zero');
      const entryNotional = notionalUnits(quantity.toString(), entry.toString(), quantityScale);
      const entryFee = feeFor(entryNotional, strategyInput.feeBps);
      position = { entryBar: index, entry, stop, target, entryFee };
      // The entry bar is itself the first bar after the signal and may hit a
      // stop/target. Resolve that range without using its close as an entry.
      const stopped = bar.low <= stop; const targeted = bar.high >= target;
      if (stopped) closeTrade(index, bar.open < stop ? bar.open : stop, 'stop');
      else if (targeted) closeTrade(index, target, 'target');
      else if (index === bars.length - 1) closeTrade(index, bar.close, 'end_of_data');
    }
  }
  const identity = backtestStrategyIdentity(strategyInput, quantityScale);
  return { engineVersion: BACKTEST_ENGINE_VERSION, dataHash: canonicalHash(barsInput), strategyHash: canonicalHash(identity), trades,
    totalFeesUnits: totalFees.toString(), netPnlUnits: netPnl.toString() };
}
