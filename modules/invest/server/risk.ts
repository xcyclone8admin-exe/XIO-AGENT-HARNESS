import { z } from 'zod';
import { MinorUnits } from '@xyra/ledger/contracts';

const Units = MinorUnits;
const NonNegativeUnits = Units.refine((value) => BigInt(value) >= 0n);
const PositiveUnits = Units.refine((value) => BigInt(value) > 0n);

export const InvestOrderIntent = z.object({
  id: z.uuid(), portfolioId: z.uuid(), instrumentId: z.uuid(),
  symbol: z.string().trim().min(1).max(32),
  assetClass: z.enum(['equity', 'crypto', 'fixed_income', 'fund']),
  side: z.enum(['buy', 'sell']), orderType: z.enum(['market', 'limit']),
  quantityUnits: PositiveUnits, limitPriceUnits: PositiveUnits.optional(),
  environment: z.literal('paper').default('paper'),
}).superRefine((order, ctx) => {
  if (order.orderType === 'market' && order.limitPriceUnits !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['limitPriceUnits'], message: 'Market orders cannot carry a limit price' });
  }
});
export type InvestOrderIntent = z.input<typeof InvestOrderIntent>;

export const RiskPosition = z.object({ instrumentId: z.uuid(), symbol: z.string(), quantityUnits: NonNegativeUnits, marketValueUnits: NonNegativeUnits, sector: z.string().nullable() });
export type RiskPosition = z.infer<typeof RiskPosition>;
export const RiskSnapshot = z.object({
  now: z.iso.datetime({ offset: true }), marketOpen: z.boolean(), navUnits: PositiveUnits, cashUnits: Units,
  dailyLossUnits: NonNegativeUnits, highWaterNavUnits: PositiveUnits, grossExposureUnits: NonNegativeUnits,
  ordersInHour: z.int().min(0), positions: z.array(RiskPosition).max(500),
  recentInstrumentOrders: z.array(z.object({ instrumentId: z.uuid(), createdAt: z.iso.datetime({ offset: true }) })).max(1000),
  correlations: z.array(z.object({ instrumentId: z.uuid(), correlationBps: z.int().min(-10_000).max(10_000) })).max(500),
});
export type RiskSnapshot = z.infer<typeof RiskSnapshot>;
export const GuardrailLimits = z.object({
  maxOrderNotionalUnits: PositiveUnits, maxPositionNotionalUnits: PositiveUnits, maxDailyLossUnits: PositiveUnits,
  maxOrdersPerHour: z.int().min(1).max(10_000), maxPriceDeviationBps: z.int().min(0).max(10_000),
  quoteFreshnessSeconds: z.int().min(1).max(86_400), duplicateWindowSeconds: z.int().min(1).max(86_400),
  maxConcentrationBps: z.int().min(1).max(10_000), maxCorrelatedExposureBps: z.int().min(1).max(100_000),
  maxLeverageBps: z.int().min(10_000).max(100_000), maxDrawdownBps: z.int().min(1).max(10_000),
  targetVolatilityBps: z.int().min(1).max(100_000), blockedSymbols: z.array(z.string().trim().min(1).max(32)).max(1000).default([]),
  watchSymbols: z.array(z.string().trim().min(1).max(32)).max(1000).default([]),
});
export type GuardrailLimits = z.input<typeof GuardrailLimits>;
export const RiskQuote = z.object({ priceUnits: PositiveUnits, sourceAt: z.iso.datetime({ offset: true }), receivedAt: z.iso.datetime({ offset: true }), volatilityBps: z.int().min(0).max(1_000_000) });
export type RiskQuote = z.infer<typeof RiskQuote>;
export const GuardrailVerdict = z.object({ allowed: z.boolean(), reasons: z.array(z.string()), notionalUnits: Units.nullable(), effectiveOrderCapUnits: Units, watchlisted: z.boolean() });
export type GuardrailVerdict = z.infer<typeof GuardrailVerdict>;

const BPS = 10_000n;
const quantityFactor = (scale: number) => 10n ** BigInt(scale);
const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

export function notionalUnits(quantity: string, price: string, quantityScale: number): bigint {
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 18) throw new RangeError('Invalid quantity scale');
  return BigInt(Units.parse(ceilDiv(BigInt(PositiveUnits.parse(quantity)) * BigInt(PositiveUnits.parse(price)), quantityFactor(quantityScale)).toString()));
}

export function checkInvestOrder(rawOrder: InvestOrderIntent, rawQuote: RiskQuote, rawSnapshot: RiskSnapshot, rawLimits: GuardrailLimits,
  options: { readonly quantityScale: number; readonly restricted: boolean }): GuardrailVerdict {
  const order = InvestOrderIntent.parse(rawOrder); const quote = RiskQuote.parse(rawQuote);
  const snapshot = RiskSnapshot.parse(rawSnapshot); const limits = GuardrailLimits.parse(rawLimits);
  if (!Number.isInteger(options.quantityScale) || options.quantityScale < 0 || options.quantityScale > 18) throw new RangeError('Invalid risk options');
  const reasons: string[] = []; const symbol = order.symbol.toUpperCase();
  const quantity = BigInt(order.quantityUnits); const price = BigInt(quote.priceUnits); const nav = BigInt(snapshot.navUnits);
  const cash = BigInt(snapshot.cashUnits); const dailyLoss = BigInt(snapshot.dailyLossUnits);
  const held = snapshot.positions.find((position) => position.instrumentId === order.instrumentId);
  const heldQuantity = held ? BigInt(held.quantityUnits) : 0n; const heldValue = held ? BigInt(held.marketValueUnits) : 0n;
  const notional = notionalUnits(order.quantityUnits, quote.priceUnits, options.quantityScale);
  const vol = BigInt(quote.volatilityBps); const targetVol = BigInt(limits.targetVolatilityBps);
  const volCap = vol > targetVol ? BigInt(limits.maxOrderNotionalUnits) * targetVol / vol : BigInt(limits.maxOrderNotionalUnits);
  const effectiveCap = volCap < BigInt(limits.maxOrderNotionalUnits) ? volCap : BigInt(limits.maxOrderNotionalUnits);
  const sideSign = order.side === 'buy' ? 1n : -1n; const postQuantity = heldQuantity + sideSign * quantity;
  const positionValue = order.side === 'buy' ? heldValue + notional : heldValue - notional;
  const exposure = BigInt(snapshot.grossExposureUnits) + sideSign * notional;
  const now = Date.parse(snapshot.now); const quoteAge = now - Date.parse(quote.receivedAt);
  const duplicateWindow = limits.duplicateWindowSeconds * 1000;
  const duplicate = snapshot.recentInstrumentOrders.some((row) => row.instrumentId === order.instrumentId && now - Date.parse(row.createdAt) >= 0 && now - Date.parse(row.createdAt) <= duplicateWindow);
  if (order.symbol.trim() !== symbol) reasons.push('symbol must be canonical uppercase');
  if (options.restricted || limits.blockedSymbols.some((value) => value.toUpperCase() === symbol)) reasons.push(`${symbol} is restricted`);
  if (limits.watchSymbols.some((value) => value.toUpperCase() === symbol)) reasons.push(`${symbol} is watch-listed and requires approval`);
  if (order.orderType === 'limit' && !order.limitPriceUnits) reasons.push('limit orders require a positive limit price');
  if (quoteAge < 0 || quoteAge > limits.quoteFreshnessSeconds * 1000) reasons.push('market quote is stale or future-dated');
  if (order.assetClass !== 'crypto' && !snapshot.marketOpen) reasons.push('market session is closed');
  if (snapshot.ordersInHour >= limits.maxOrdersPerHour) reasons.push('orders-per-hour limit reached');
  if (dailyLoss >= BigInt(limits.maxDailyLossUnits) && order.side === 'buy') reasons.push('daily-loss halt blocks new exposure');
  if (duplicate) reasons.push('duplicate-order window is active for this instrument');
  if (order.limitPriceUnits) {
    const limitPrice = BigInt(order.limitPriceUnits); const deviation = limitPrice > price ? limitPrice - price : price - limitPrice;
    if (deviation * BPS > price * BigInt(limits.maxPriceDeviationBps)) reasons.push('limit price exceeds the market-data sanity band');
  }
  if (notional > effectiveCap || notional > BigInt(limits.maxOrderNotionalUnits)) reasons.push('order notional exceeds the volatility-adjusted order cap');
  if (order.side === 'buy') {
    if (notional > cash) reasons.push('insufficient portfolio cash');
    if (positionValue > BigInt(limits.maxPositionNotionalUnits)) reasons.push('position-size limit exceeded');
    if (postQuantity < 0n) reasons.push('position cannot become short');
    if (positionValue * BPS > nav * BigInt(limits.maxConcentrationBps)) reasons.push('single-position concentration limit exceeded');
    if (exposure * BPS > nav * BigInt(limits.maxLeverageBps)) reasons.push('portfolio leverage limit exceeded');
    const correlations = new Map(snapshot.correlations.map((row) => [row.instrumentId, BigInt(Math.abs(row.correlationBps))]));
    let correlated = notional;
    for (const position of snapshot.positions) if (position.instrumentId !== order.instrumentId) correlated += BigInt(position.marketValueUnits) * (correlations.get(position.instrumentId) ?? 0n) / BPS;
    if (correlated * BPS > nav * BigInt(limits.maxCorrelatedExposureBps)) reasons.push('correlated exposure limit exceeded');
    const drawdown = BigInt(snapshot.highWaterNavUnits) - nav;
    if (drawdown > 0n && drawdown * BPS >= BigInt(snapshot.highWaterNavUnits) * BigInt(limits.maxDrawdownBps)) reasons.push('drawdown circuit breaker is active');
  } else if (!held || quantity > heldQuantity || postQuantity < 0n) reasons.push('sell quantity exceeds the long position; shorting is disabled');
  return GuardrailVerdict.parse({ allowed: reasons.length === 0, reasons, notionalUnits: Units.parse(notional.toString()),
    effectiveOrderCapUnits: Units.parse(effectiveCap.toString()), watchlisted: limits.watchSymbols.some((value) => value.toUpperCase() === symbol) });
}

export function sizeForStopRisk(input: { readonly navUnits: string; readonly maxRiskBps: number; readonly entryPriceUnits: string; readonly stopPriceUnits: string; readonly quantityScale: number }): string {
  const nav = BigInt(PositiveUnits.parse(input.navUnits)); const entry = BigInt(PositiveUnits.parse(input.entryPriceUnits)); const stop = BigInt(PositiveUnits.parse(input.stopPriceUnits));
  if (!Number.isInteger(input.maxRiskBps) || input.maxRiskBps < 1 || input.maxRiskBps > 10_000) throw new RangeError('Invalid risk budget');
  if (!Number.isInteger(input.quantityScale) || input.quantityScale < 0 || input.quantityScale > 18) throw new RangeError('Invalid quantity scale');
  if (stop >= entry) throw new RangeError('A long stop must be below entry');
  return Units.parse((nav * BigInt(input.maxRiskBps) / BPS * quantityFactor(input.quantityScale) / (entry - stop)).toString());
}
