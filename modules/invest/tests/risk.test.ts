import { expect, test } from 'vitest';
import {
  checkInvestOrder,
  GuardrailLimits,
  InvestOrderIntent,
  notionalUnits,
  sizeForStopRisk,
  type GuardrailLimits as GuardrailLimitsInput,
  type InvestOrderIntent as InvestOrderIntentInput,
  type RiskQuote as RiskQuoteInput,
  type RiskSnapshot as RiskSnapshotInput,
} from '../server/risk';

const instrument = '019a0000-0000-7000-8000-000000000101';
const otherInstrument = '019a0000-0000-7000-8000-000000000102';
const order = {
  id: '019a0000-0000-7000-8000-000000000201',
  portfolioId: '019a0000-0000-7000-8000-000000000301',
  instrumentId: instrument,
  symbol: 'ACME',
  assetClass: 'equity' as const,
  side: 'buy' as const,
  orderType: 'market' as const,
  quantityUnits: '1000000',
  environment: 'paper' as const,
};
const quote = {
  priceUnits: '10000',
  sourceAt: '2026-09-30T10:00:00.000Z',
  receivedAt: '2026-09-30T10:00:00.000Z',
  volatilityBps: 1000,
};
const snapshot = {
  now: '2026-09-30T10:00:10.000Z',
  marketOpen: true,
  navUnits: '1000000',
  cashUnits: '500000',
  dailyLossUnits: '0',
  highWaterNavUnits: '1000000',
  grossExposureUnits: '0',
  ordersInHour: 0,
  positions: [],
  recentInstrumentOrders: [],
  correlations: [],
};
const limits = GuardrailLimits.parse({
  maxOrderNotionalUnits: '250000',
  maxPositionNotionalUnits: '400000',
  maxDailyLossUnits: '100000',
  maxOrdersPerHour: 10,
  maxPriceDeviationBps: 500,
  quoteFreshnessSeconds: 300,
  duplicateWindowSeconds: 600,
  maxConcentrationBps: 4000,
  maxCorrelatedExposureBps: 5000,
  maxLeverageBps: 15000,
  maxDrawdownBps: 2500,
  targetVolatilityBps: 2000,
});
const check = (
  changes: {
    order?: Partial<InvestOrderIntentInput>;
    quote?: Partial<RiskQuoteInput>;
    snapshot?: Partial<RiskSnapshotInput>;
    limits?: Partial<GuardrailLimitsInput>;
    restricted?: boolean;
    quantityScale?: number;
  } = {},
) => checkInvestOrder(
  { ...order, ...changes.order },
  { ...quote, ...changes.quote },
  { ...snapshot, ...changes.snapshot },
  { ...limits, ...changes.limits },
  { quantityScale: changes.quantityScale ?? 6, restricted: changes.restricted ?? false },
);

test('risk math stays exact in minor units and stop sizing rounds quantity down', () => {
  expect(notionalUnits('1000000', '12345', 6)).toBe(12345n);
  expect(notionalUnits('1', '1', 0)).toBe(1n);
  expect(sizeForStopRisk({ navUnits: '1000000', maxRiskBps: 100, entryPriceUnits: '10000', stopPriceUnits: '9000', quantityScale: 6 }))
    .toBe('10000000');
  expect(() => sizeForStopRisk({ navUnits: '1000000', maxRiskBps: 100, entryPriceUnits: '9000', stopPriceUnits: '10000', quantityScale: 6 }))
    .toThrow(/below entry/);
  expect(check().allowed).toBe(true);
  expect(InvestOrderIntent.safeParse({ ...order, environment: 'live' }).success).toBe(false);
  expect(InvestOrderIntent.safeParse({ ...order, orderType: 'market', limitPriceUnits: '10000' }).success).toBe(false);
});

test('each hard pre-trade guardrail denies its isolated violating input', () => {
  expect(check({ restricted: true }).reasons).toContain('ACME is restricted');
  expect(check({ limits: { blockedSymbols: ['ACME'] } }).allowed).toBe(false);
  expect(check({ limits: { watchSymbols: ['ACME'] } }).watchlisted).toBe(true);
  expect(check({ snapshot: { marketOpen: false } }).reasons).toContain('market session is closed');
  expect(check({ quote: { receivedAt: '2026-09-30T09:50:00.000Z' } }).reasons).toContain('market quote is stale or future-dated');
  expect(check({ snapshot: { ordersInHour: 10 } }).reasons).toContain('orders-per-hour limit reached');
  expect(check({ snapshot: { dailyLossUnits: '100000' } }).reasons).toContain('daily-loss halt blocks new exposure');
  expect(check({ snapshot: { recentInstrumentOrders: [{ instrumentId: instrument, createdAt: '2026-09-30T09:59:30.000Z' }] } }).reasons)
    .toContain('duplicate-order window is active for this instrument');
  expect(check({ order: { orderType: 'limit', limitPriceUnits: '20000' } }).reasons).toContain('limit price exceeds the market-data sanity band');
  expect(check({ order: { quantityUnits: '30000000' } }).reasons).toContain('order notional exceeds the volatility-adjusted order cap');
  expect(check({ snapshot: { cashUnits: '5000' } }).reasons).toContain('insufficient portfolio cash');
  expect(check({ order: { quantityUnits: '6000000' }, limits: { maxPositionNotionalUnits: '50000' } }).reasons)
    .toContain('position-size limit exceeded');
  expect(check({ order: { quantityUnits: '2000000' }, limits: { maxConcentrationBps: 100 } }).reasons)
    .toContain('single-position concentration limit exceeded');
  expect(check({ snapshot: { grossExposureUnits: '1000000' }, limits: { maxLeverageBps: 10000 } }).reasons)
    .toContain('portfolio leverage limit exceeded');
  expect(check({ snapshot: { correlations: [{ instrumentId: otherInstrument, correlationBps: 10000 }],
    positions: [{ instrumentId: otherInstrument, symbol: 'OTHER', quantityUnits: '1000000', marketValueUnits: '400000', sector: 'technology' }] },
    limits: { maxCorrelatedExposureBps: 2000 } }).reasons).toContain('correlated exposure limit exceeded');
  expect(check({ snapshot: { navUnits: '700000', highWaterNavUnits: '1000000' } }).reasons).toContain('drawdown circuit breaker is active');
  expect(check({ quote: { volatilityBps: 5000 }, order: { quantityUnits: '15000000' } }).reasons)
    .toContain('order notional exceeds the volatility-adjusted order cap');
});

test('risk-reducing sells cannot short and stay available through drawdown and daily-loss halts', () => {
  const selling = {
    order: { side: 'sell' as const },
    snapshot: {
      dailyLossUnits: '100000', navUnits: '700000', highWaterNavUnits: '1000000', marketOpen: true,
      positions: [{ instrumentId: instrument, symbol: 'ACME', quantityUnits: '2000000', marketValueUnits: '20000', sector: null }],
    },
  };
  expect(check(selling).allowed).toBe(true);
  expect(check({ order: { side: 'sell', quantityUnits: '3000000' }, snapshot: selling.snapshot }).reasons)
    .toContain('sell quantity exceeds the long position; shorting is disabled');
});
