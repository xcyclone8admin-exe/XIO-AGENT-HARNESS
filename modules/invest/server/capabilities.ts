import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';
import { GuardrailLimits } from './risk';

const Uuid = z.uuid();
const Units = z.string().regex(/^(0|-?[1-9]\d{0,37})$/);
const ReturnBps = z.string().regex(/^-?\d{1,43}$/);
const OrderView = z.object({
  id: Uuid, portfolio_id: Uuid, instrument_id: Uuid, symbol: z.string(), side: z.enum(['buy', 'sell']), order_type: z.enum(['market', 'limit']),
  quantity_units: Units, filled_units: Units.optional(), limit_price_units: Units.nullable(), status: z.enum(['proposed', 'approved', 'rejected', 'submitted', 'partially_filled', 'filled', 'cancelled', 'expired']),
  environment: z.literal('paper'), created_at: z.string(),
});
const PortfolioView = z.object({ id: Uuid, name: z.string(), base_asset: z.string(), book_id: Uuid, environment: z.literal('paper'), status: z.enum(['active','paused','closed']) });
const InstrumentView = z.object({ id: Uuid, symbol: z.string(), asset_class: z.string(), quantity_scale: z.number(), exchange_code: z.string().nullable() });
const Summary = z.object({ portfolioId: Uuid, environment: z.literal('paper'), cashUnits: Units, navUnits: Units, positions: z.array(z.object({ instrumentId: Uuid, symbol: z.string(), quantityUnits: Units, priceUnits: Units, marketValueUnits: Units })) });
const BacktestBar = z.object({ at:z.iso.datetime({offset:true}),openUnits:z.string().regex(/^[1-9]\d{0,37}$/),highUnits:z.string().regex(/^[1-9]\d{0,37}$/),lowUnits:z.string().regex(/^[1-9]\d{0,37}$/),closeUnits:z.string().regex(/^[1-9]\d{0,37}$/) }).strict();
const BacktestTrade = z.object({entryBar:z.number().int(),exitBar:z.number().int(),entryPriceUnits:Units,exitPriceUnits:Units,quantityUnits:Units,grossPnlUnits:Units,feesUnits:Units,netPnlUnits:Units,exitReason:z.enum(['stop','target','end_of_data'])});
const BacktestResultView = z.object({runId:Uuid,engineVersion:z.literal('momentum-next-bar-v1'),dataVersion:z.number(),strategyId:z.string(),strategyVersion:z.number(),dataHash:z.string().regex(/^[0-9a-f]{64}$/),strategyHash:z.string().regex(/^[0-9a-f]{64}$/),trades:z.array(BacktestTrade),totalFeesUnits:Units,netPnlUnits:Units});
const BacktestHistoryRow = z.object({id:Uuid,data_version:z.number(),source_name:z.string(),source_ref:z.string(),data_hash:z.string(),strategy_key:z.string(),strategy_version:z.number(),strategy_hash:z.string(),engine_version:z.string(),total_fees_units:Units,net_pnl_units:Units,created_at:z.string()});
const PerformanceMarkView = z.object({id:Uuid,portfolio_id:Uuid,captured_at:z.string(),nav_units:Units,cash_units:Units,benchmark_index_units:Units,benchmark_source:z.string(),benchmark_ref:z.string(),external_flow_units:Units, cumulative_fee_units:Units});
const PerformanceStatementData = z.object({calculationVersion:z.literal('invest-twr-fixed-v1'),fromMarkId:Uuid,toMarkId:Uuid,startNavUnits:Units,endNavUnits:Units,netExternalFlowUnits:Units,feesUnits:Units,twrBps:ReturnBps,benchmarkReturnBps:ReturnBps,relativeReturnBps:ReturnBps,markCount:z.number().int()});
const PerformanceStatementView = z.object({id:Uuid,portfolio_id:Uuid,created_at:z.string(),report:PerformanceStatementData});
const Empty = z.object({});

export const investCapabilities = {
  performanceMarks: defineCapability({id:'invest.performance.marks',title:'PAPER valuation marks',description:'List immutable ledger-derived PAPER valuation and benchmark marks',kind:'read',permission:'invest:portfolio:read',input:z.object({portfolioId:Uuid}).strict(),output:z.array(PerformanceMarkView)}),
  capturePerformanceMark: defineCapability({id:'invest.performance.capture-mark',title:'Capture PAPER performance mark',description:'Capture ledger NAV, capital flows and fees against a sourced benchmark level in one scoped transaction',kind:'write',permission:'invest:performance:report',agentCallable:false,
    input:z.object({portfolioId:Uuid,benchmarkIndexUnits:z.string().regex(/^[1-9]\d{0,37}$/),benchmarkSource:z.string().trim().min(1).max(120),benchmarkRef:z.string().trim().min(1).max(500)}).strict(),output:PerformanceMarkView}),
  createPerformanceStatement: defineCapability({id:'invest.performance.statement',title:'Generate PAPER performance statement',description:'Persist versioned time-weighted return, fees and benchmark attribution from stored ledger-derived marks',kind:'write',permission:'invest:performance:report',agentCallable:false,
    input:z.object({portfolioId:Uuid,fromMarkId:Uuid,toMarkId:Uuid}).strict(),output:PerformanceStatementView}),
  performanceStatements: defineCapability({id:'invest.performance.statements',title:'PAPER performance statements',description:'List immutable versioned portfolio performance statements',kind:'read',permission:'invest:portfolio:read',input:z.object({portfolioId:Uuid}).strict(),output:z.array(PerformanceStatementView)}),
  backtestRuns: defineCapability({id:'invest.backtests.list',title:'PAPER backtest history',description:'Read immutable versioned PAPER backtest runs and their input provenance',kind:'read',permission:'invest:market:read',
    input:z.object({instrumentId:Uuid}).strict(),output:z.array(BacktestHistoryRow)}),
  runBacktest: defineCapability({ id:'invest.backtests.run-paper',title:'Run versioned PAPER backtest',description:'Run a deterministic long-only next-bar OHLC simulation with pessimistic stops, explicit fees and immutable inputs/results',
    kind:'write',permission:'invest:backtest:run',agentCallable:false,input:z.object({instrumentId:Uuid,dataVersion:z.int().min(1),sourceName:z.string().trim().min(1).max(120),sourceRef:z.string().trim().min(1).max(500),
      bars:z.array(BacktestBar).min(2).max(10000),strategy:z.object({id:z.string().trim().min(1).max(120),version:z.int().min(1),quantityUnits:z.string().regex(/^[1-9]\d{0,37}$/),stopBps:z.int().min(1).max(9999),targetBps:z.int().min(1).max(100000),feeBps:z.int().min(0).max(2000)}).strict()}).strict(),
    output:BacktestResultView}),
  portfolios: defineCapability({ id: 'invest.portfolios.list', title: 'Portfolios', description: 'List PAPER investment portfolios',
    kind: 'read', permission: 'invest:portfolio:read', input: Empty, output: z.array(PortfolioView) }),
  summary: defineCapability({ id: 'invest.portfolios.summary', title: 'PAPER portfolio summary', description: 'Ledger-derived cash, positions and NAV for one PAPER portfolio',
    kind: 'read', permission: 'invest:portfolio:read', input: z.object({ portfolioId: Uuid }), output: Summary }),
  riskState: defineCapability({ id: 'invest.portfolios.risk-state', title: 'PAPER portfolio risk state', description: 'Read persisted PAPER trading halt and daily risk state',
    kind: 'read', permission: 'invest:breach:manage', input: z.object({ portfolioId: Uuid }),
    output: z.object({ portfolioId: Uuid, killSwitch: z.boolean(), killReason: z.string().nullable(), dailyLossUnits: Units, riskDate: z.string() }) }),
  breaches: defineCapability({ id: 'invest.breaches.list', title: 'PAPER breach queue', description: 'List owner-actionable post-trade alerts', kind: 'read', permission: 'invest:breach:manage', input: Empty,
    output: z.array(z.object({ id: Uuid, portfolio_id: Uuid, instrument_id: Uuid.nullable(), kind: z.string(), severity: z.enum(['warning','high','critical']), status: z.enum(['open','acknowledged','resolved']), owner_id: Uuid.nullable(), detail: z.record(z.string(), z.unknown()), opened_at: z.string() })) }),
  manageBreach: defineCapability({ id: 'invest.breaches.manage', title: 'Assign and resolve risk alert', description: 'Assign, acknowledge or resolve a post-trade alert with an immutable owner audit event', kind: 'write', permission: 'invest:breach:manage', agentCallable: false,
    input: z.object({ breachId: Uuid, action: z.enum(['assign','acknowledge','resolve']), reason: z.string().trim().min(1).max(1000) }).strict(),
    output: z.object({ id: Uuid, status: z.enum(['open','acknowledged','resolved']), ownerId: Uuid.nullable() }) }),
  reconcileStatement: defineCapability({ id: 'invest.reconciliation.import-paper-statement', title: 'Reconcile PAPER custodian statement', description: 'Compare a human-submitted custodian statement snapshot with ledger-derived cash and positions', kind: 'write', permission: 'invest:breach:manage', agentCallable: false,
    input: z.object({ portfolioId: Uuid, sourceName: z.string().trim().min(1).max(120), sourceRef: z.string().trim().min(1).max(500), statementDate: z.iso.date(),
      statementHash: z.string().regex(/^[0-9a-f]{64}$/), cashUnits: Units,
      positions: z.array(z.object({ symbol: z.string().trim().toUpperCase().min(1).max(32), units: Units.refine((value) => BigInt(value) >= 0n) })).max(500) }).strict()
      .superRefine((value, ctx) => { if (new Set(value.positions.map((position) => position.symbol)).size !== value.positions.length) ctx.addIssue({ code: 'custom', path: ['positions'], message: 'Statement must contain at most one row per instrument symbol' }); }),
    output: z.object({ runId: Uuid, status: z.enum(['matched','needs_review']), discrepancyCount: z.number().int().min(0), idempotent: z.boolean() }) }),
  reconciliationQueue: defineCapability({ id: 'invest.reconciliation.queue', title: 'PAPER reconciliation queue', description: 'List immutable statement discrepancies and their assigned owner', kind: 'read', permission: 'invest:breach:manage', input: Empty,
    output: z.array(z.object({ id: Uuid, run_id: Uuid, portfolio_id: Uuid, source_name: z.string(), source_ref: z.string(), statement_date: z.string(), discrepancy_key: z.string(), kind: z.enum(['cash_mismatch','position_mismatch','unknown_position']), expected_units: Units, observed_units: Units, difference_units: Units, owner_id: Uuid, created_at: z.string() })) }),
  instruments: defineCapability({ id: 'invest.instruments.list', title: 'Instruments', description: 'List active investment instruments',
    kind: 'read', permission: 'invest:market:read', input: Empty, output: z.array(InstrumentView) }),
  orders: defineCapability({ id: 'invest.orders.list', title: 'Paper orders', description: 'List PAPER orders and their fills',
    kind: 'read', permission: 'invest:order:read', input: z.object({ portfolioId: Uuid.optional() }), output: z.array(OrderView) }),
  taxLots: defineCapability({ id: 'invest.tax-lots.list', title: 'PAPER tax lots', description: 'List open FIFO tax lots with remaining units and cost basis',
    kind: 'read', permission: 'invest:order:read', input: z.object({ portfolioId: Uuid }),
    output: z.array(z.object({ id: Uuid, instrumentId: Uuid, symbol: z.string(), acquiredUnits: Units, remainingUnits: Units, costBasisUnits: Units, remainingBasisUnits: Units, openedAt: z.string() })) }),
  createPortfolio: defineCapability({ id: 'invest.portfolios.create', title: 'Create PAPER portfolio', description: 'Create isolated PAPER book and ledger accounts',
    kind: 'write', permission: 'invest:portfolio:write', agentCallable: false,
    input: z.object({ name: z.string().trim().min(1).max(160), baseAsset: z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,31}$/) }).strict(), output: PortfolioView }),
  fundPortfolio: defineCapability({ id: 'invest.portfolios.fund-paper', title: 'Fund PAPER portfolio', description: 'Record an explicit PAPER-only opening cash journal',
    kind: 'write', permission: 'invest:portfolio:fund', agentCallable: false,
    input: z.object({ portfolioId: Uuid, units: z.string().regex(/^[1-9]\d{0,37}$/), reference: z.string().min(1).max(200) }).strict(),
    output: z.object({ transactionId: Uuid, environment: z.literal('paper') }) }),
  createInstrument: defineCapability({ id: 'invest.instruments.create', title: 'Register instrument', description: 'Register an instrument and position accounting asset',
    kind: 'write', permission: 'invest:market:ingest', agentCallable: false,
    input: z.object({ symbol: z.string().trim().min(1).max(32), assetClass: z.enum(['equity','crypto','fixed_income','fund']), quantityScale: z.int().min(0).max(18), exchangeCode: z.string().max(32).nullable() }).strict(), output: z.object({ id: Uuid, symbol: z.string() }) }),
  recordPrice: defineCapability({ id: 'invest.market.record-price', title: 'Record market price', description: 'Append source-stamped market data for PAPER risk and simulation',
    kind: 'write', permission: 'invest:market:ingest', agentCallable: false,
    input: z.object({ instrumentId: Uuid, priceUnits: Units.refine((v) => BigInt(v) > 0n), source: z.string().min(1).max(80), sourceAt: z.iso.datetime({ offset: true }), volatilityBps: z.int().min(0).max(1_000_000), payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    output: z.object({ id: Uuid, received_at: z.string() }) }),
  recordMarketSession: defineCapability({ id: 'invest.market.record-session', title: 'Record market session', description: 'Append exchange session calendar data for fail-closed pre-trade checks',
    kind: 'write', permission: 'invest:market:ingest', agentCallable: false,
    input: z.object({ exchangeCode: z.string().min(1).max(32), sessionDate: z.iso.date(), opensAt: z.iso.datetime({ offset: true }), closesAt: z.iso.datetime({ offset: true }), isOpen: z.boolean(), source: z.string().min(1).max(80) }).strict(),
    output: z.object({ received_at: z.string() }) }),
  createMandate: defineCapability({ id: 'invest.mandates.create', title: 'Draft mandate for IC review', description: 'Submit a source-cited, effective-dated investment policy memo for independent IC review',
    kind: 'write', permission: 'invest:mandate:manage', agentCallable: true,
    input: z.object({ portfolioId: Uuid, version: z.int().min(1), title: z.string().trim().min(1).max(240), thesis: z.string().trim().min(1).max(20000),
      sources: z.array(z.object({ label: z.string().trim().min(1).max(240), ref: z.string().trim().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(100),
      effectiveFrom: z.iso.datetime({ offset: true }), effectiveUntil: z.iso.datetime({ offset: true }).nullable(),
      allowedAssetClasses: z.array(z.enum(['equity','crypto','fixed_income','fund'])).min(1), allowedInstrumentIds: z.array(Uuid).max(500), benchmark: z.string().min(1).max(32), limits: GuardrailLimits }).strict(),
    output: z.object({ id: Uuid, version: z.number(), status: z.literal('in_review') }) }),
  icQueue: defineCapability({ id: 'invest.mandates.ic-queue', title: 'Investment committee queue', description: 'List pending investment policy memos and vote totals',
    kind: 'read', permission: 'invest:mandate:read', input: Empty,
    output: z.array(z.object({ id: Uuid, portfolio_id: Uuid, version: z.number(), title: z.string(), status: z.enum(['draft','in_review','approved','rejected','expired']), approvals: z.number(), rejections: z.number(), recusals: z.number(), created_at: z.string() })) }),
  voteMemo: defineCapability({ id: 'invest.mandates.vote', title: 'Cast IC vote', description: 'Record an immutable owner/admin vote or recusal on an investment committee memo',
    kind: 'write', permission: 'invest:mandate:vote', agentCallable: false,
    input: z.object({ memoId: Uuid, vote: z.enum(['approve','reject','recuse']), reason: z.string().trim().min(1).max(1000) }).strict(),
    output: z.object({ memoId: Uuid, vote: z.enum(['approve','reject','recuse']), approvals: z.number(), rejections: z.number(), recusals: z.number() }) }),
  activateMandate: defineCapability({ id: 'invest.mandates.activate', title: 'Approve mandate by IC quorum', description: 'Activate a versioned mandate after two independent, non-recused owner/admin approvals',
    kind: 'write', permission: 'invest:mandate:approve', agentCallable: false,
    input: z.object({ memoId: Uuid }).strict(), output: z.object({ id: Uuid, version: z.number(), status: z.literal('approved'), expiresAt: z.string() }) }),
  propose: defineCapability({ id: 'invest.orders.propose', title: 'Propose PAPER order', description: 'Size and risk-check an order from stored ledger and market data',
    kind: 'write', permission: 'invest:order:propose', agentCallable: false,
    input: z.object({ portfolioId: Uuid, instrumentId: Uuid, side: z.enum(['buy','sell']), orderType: z.enum(['market','limit']),
      limitPriceUnits: Units.optional(), stopPriceUnits: Units, riskBps: z.int().min(1).max(1000), idempotencyKey: z.string().min(1).max(200) }).strict(),
    output: OrderView }),
  approve: defineCapability({ id: 'invest.orders.approve', title: 'Approve PAPER order', description: 'Approve a risk-cleared PAPER order',
    kind: 'write', permission: 'invest:order:approve', agentCallable: false,
    input: z.object({ orderId: Uuid }), output: OrderView }),
  execute: defineCapability({ id: 'invest.orders.execute-paper', title: 'Execute PAPER fill', description: 'Fill an approved order at a stored PAPER market quote and post ledger entries atomically',
    kind: 'write', permission: 'invest:order:execute', agentCallable: false,
    input: z.object({ orderId: Uuid, quantityUnits: Units.refine((value) => BigInt(value) > 0n).optional() }).strict(), output: z.object({ order: OrderView, fillId: Uuid, transactionId: Uuid, environment: z.literal('paper') }) }),
  cancel: defineCapability({ id: 'invest.orders.cancel', title: 'Cancel PAPER order', description: 'Cancel an unfilled PAPER order',
    kind: 'write', permission: 'invest:order:cancel', agentCallable: false, input: z.object({ orderId: Uuid }), output: OrderView }),
  killSwitch: defineCapability({ id: 'invest.orders.set-kill-switch', title: 'Halt PAPER trading', description: 'Halt new orders and cancel open PAPER orders for a portfolio; resuming requires this explicit action',
    kind: 'write', permission: 'invest:order:kill_switch', agentCallable: false,
    input: z.object({ portfolioId: Uuid, engaged: z.boolean(), reason: z.string().min(1).max(500) }).strict(),
    output: z.object({ portfolioId: Uuid, engaged: z.boolean(), cancelledOrders: z.number() }) }),
};
