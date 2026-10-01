import { createHash } from 'node:crypto';
import { HybridClock, uuidv7 } from '@xyra/core';
import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import type { LocalScopedStore, Scope, ScopedTransaction } from '@xyra/db';
import type { Asset, LedgerApi, LedgerScope, PaperTradeLedgerApi } from '@xyra/ledger/contracts';
import type { KillSwitchReader } from '@xyra/mod-swarm/contracts';
import { BUILTIN_ASSETS } from '@xyra/ledger/contracts';
import { GuardrailLimits, RiskQuote, RiskSnapshot, checkInvestOrder, notionalUnits, sizeForStopRisk } from './risk';
import { allocateFifoTaxLots } from './tax-lots';
import { backtestStrategyIdentity, runMomentumStopTargetBacktest, type OhlcBar, type MomentumStopTargetStrategy } from './backtest';
import { calculateTimeWeightedStatement, type PerformanceMark, type PerformanceStatement } from './performance';
import { investCapabilities } from './capabilities';
import manifest from '../manifest';
import { validateScheduledCustodyContext, type PersistedCustodyStatementInbox, type PersistedCustodyStatement, type TrustedFlowStepContext } from './scheduled-reconciliation';

type Call = { readonly principal: Principal; readonly workspaceId: string };
type Registrar = { register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call: Call) => Promise<unknown>): void };
type QueryTx = Pick<ScopedTransaction, 'query'>;
type KillSwitchSnapshot = Awaited<ReturnType<KillSwitchReader['getKillSwitch']>>;
type OrderRow = {
  id: string; portfolio_id: string; instrument_id: string; symbol: string; side: 'buy'|'sell'; order_type: 'market'|'limit';
  quantity_units: string; limit_price_units: string|null; status: 'proposed'|'approved'|'submitted'|'partially_filled'|'filled'|'cancelled'|'expired';
  environment: 'paper'; created_at: string; filled_units?: string;
};
type PortfolioRow = { id: string; name: string; base_asset: string; book_id: string; environment: 'paper'; status: 'active'|'paused'|'closed' };
type InvestScope = Scope & LedgerScope;
type MandateDraft = { version: number; effectiveFrom: string; effectiveUntil: string|null; limits: Record<string, unknown>; allowedAssetClasses: Array<'equity'|'crypto'|'fixed_income'|'fund'>; allowedInstrumentIds: string[]; benchmark: string };
type MandateDraftInput = MandateDraft & { portfolioId: string; title: string; thesis: string; sources: Array<{label:string;ref:string;sha256:string}> };

/** Trusted local PAPER service. Scope and actor always come from the authenticated sidecar call. */
export class InvestService {
  private readonly clock = new HybridClock('invest');
  constructor(
    private readonly scoped: LocalScopedStore,
    private readonly ledger: LedgerApi,
    private readonly paperLedger: PaperTradeLedgerApi,
    private readonly killSwitchReader: KillSwitchReader | null = null,
    private readonly custodyInbox: PersistedCustodyStatementInbox | null = null,
  ) {}

  private async assertGlobalTradingEnabled(scope: InvestScope): Promise<void> {
    if (!this.killSwitchReader) throw new Error('INVEST_GLOBAL_KILL_SWITCH_UNAVAILABLE');
    let state: KillSwitchSnapshot;
    try { state = await this.killSwitchReader.getKillSwitch(scope); }
    catch { throw new Error('INVEST_GLOBAL_KILL_SWITCH_UNAVAILABLE'); }
    if (state.engaged) throw new Error('INVEST_GLOBAL_KILL_SWITCH_ENGAGED');
  }

  register(bus: Registrar, moduleManifest: ModuleManifest = manifest): void {
    const reg = (descriptor: AnyCapability, handler: (input: unknown, call: Call) => Promise<unknown>) => bus.register(moduleManifest, descriptor, handler);
    reg(investCapabilities.portfolios, (_input, call) => this.portfolios(this.scope(call)));
    reg(investCapabilities.summary, (input, call) => this.summary(this.scope(call), input as { portfolioId: string }));
    reg(investCapabilities.riskState, (input, call) => this.riskState(this.scope(call), input as { portfolioId: string }));
    reg(investCapabilities.breaches, (_input, call) => this.breaches(this.scope(call)));
    reg(investCapabilities.manageBreach, (input, call) => this.manageBreach(this.scope(call), call, input as { breachId: string; action: 'assign'|'acknowledge'|'resolve'; reason: string }));
    reg(investCapabilities.reconcileStatement, (input, call) => this.reconcileStatement(this.scope(call), call, input as { portfolioId:string;sourceName:string;sourceRef:string;statementDate:string;statementHash:string;cashUnits:string;positions:Array<{symbol:string;units:string}> }));
    reg(investCapabilities.reconciliationQueue, (_input, call) => this.reconciliationQueue(this.scope(call)));
    reg(investCapabilities.instruments, (_input, call) => this.instruments(this.scope(call)));
    reg(investCapabilities.orders, (input, call) => this.orders(this.scope(call), input as { portfolioId?: string }));
    reg(investCapabilities.taxLots, (input, call) => this.taxLots(this.scope(call), input as { portfolioId: string }));
    reg(investCapabilities.createPortfolio, (input, call) => this.createPortfolio(this.scope(call), this.actor(call), input as { name: string; baseAsset: string }));
    reg(investCapabilities.fundPortfolio, (input, call) => this.fundPortfolio(this.scope(call), this.actor(call), input as { portfolioId: string; units: string; reference: string }));
    reg(investCapabilities.createInstrument, (input, call) => this.createInstrument(this.scope(call), this.actor(call), input as { symbol: string; assetClass: 'equity'|'crypto'|'fixed_income'|'fund'; quantityScale: number; exchangeCode: string|null }));
    reg(investCapabilities.recordPrice, (input, call) => this.recordPrice(this.scope(call), this.actor(call), input as { instrumentId: string; priceUnits: string; source: string; sourceAt: string; volatilityBps: number; payloadHash: string }));
    reg(investCapabilities.recordMarketSession, (input, call) => this.recordMarketSession(this.scope(call), input as { exchangeCode: string; sessionDate: string; opensAt: string; closesAt: string; isOpen: boolean; source: string }));
    reg(investCapabilities.runBacktest, (input, call) => this.runBacktest(this.scope(call), this.actor(call), input as {instrumentId:string;dataVersion:number;sourceName:string;sourceRef:string;bars:OhlcBar[];strategy:MomentumStopTargetStrategy}));
    reg(investCapabilities.backtestRuns, (input, call) => this.backtestRuns(this.scope(call),input as {instrumentId:string}));
    reg(investCapabilities.performanceMarks, (input, call) => this.performanceMarks(this.scope(call),input as {portfolioId:string}));
    reg(investCapabilities.capturePerformanceMark, (input, call) => this.capturePerformanceMark(this.scope(call),call,input as {portfolioId:string;benchmarkIndexUnits:string;benchmarkSource:string;benchmarkRef:string}));
    reg(investCapabilities.createPerformanceStatement, (input, call) => this.createPerformanceStatement(this.scope(call),call,input as {portfolioId:string;fromMarkId:string;toMarkId:string}));
    reg(investCapabilities.performanceStatements, (input, call) => this.performanceStatements(this.scope(call),input as {portfolioId:string}));
    reg(investCapabilities.createMandate, (input, call) => this.createMandate(this.scope(call), this.actor(call), input as MandateDraftInput));
    reg(investCapabilities.icQueue, (_input, call) => this.icQueue(this.scope(call)));
    reg(investCapabilities.voteMemo, (input, call) => this.voteMemo(this.scope(call), call, input as { memoId: string; vote: 'approve'|'reject'|'recuse'; reason: string }));
    reg(investCapabilities.activateMandate, (input, call) => this.activateMandate(this.scope(call), call, input as { memoId: string }));
    reg(investCapabilities.propose, (input, call) => this.propose(this.scope(call), this.actor(call), input as { portfolioId: string; instrumentId: string; side: 'buy'|'sell'; orderType: 'market'|'limit'; limitPriceUnits?: string; stopPriceUnits: string; riskBps: number; idempotencyKey: string }));
    reg(investCapabilities.approve, (input, call) => this.approve(this.scope(call), this.actor(call), input as { orderId: string }));
    reg(investCapabilities.execute, (input, call) => this.execute(this.scope(call), this.actor(call), input as { orderId: string }));
    reg(investCapabilities.cancel, (input, call) => this.cancel(this.scope(call), this.actor(call), input as { orderId: string }));
    reg(investCapabilities.killSwitch, (input, call) => this.setKillSwitch(this.scope(call), this.actor(call), input as { portfolioId: string; engaged: boolean; reason: string }));
  }

  private scope(call: Call): InvestScope {
    if (!call.principal.workspaces.some((workspace) => workspace.id === call.workspaceId)) throw new Error('Workspace is outside authenticated principal scope');
    return { tenantId: call.principal.tenantId, workspaceId: call.workspaceId, hlc: this.clock.now() };
  }
  private actor(call: Call): string { return call.principal.delegatedBy ?? call.principal.id; }
  private requireHumanOwner(scope: InvestScope, call: Call): string {
    const member = call.principal.workspaces.find((workspace) => workspace.id === scope.workspaceId);
    if (call.principal.kind !== 'user' || call.principal.delegatedBy || !member || !['owner','admin'].includes(member.role)) {
      throw new Error('IC votes and mandate approval require a direct owner or admin action');
    }
    return call.principal.id;
  }

  async portfolios(scope: InvestScope): Promise<PortfolioRow[]> {
    return (await this.scoped.query<PortfolioRow>(scope,
      `SELECT id,name,base_asset,book_id,environment,status FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND deleted_hlc IS NULL ORDER BY created_at DESC`,
      [scope.tenantId, scope.workspaceId])).rows;
  }
  async summary(scope: InvestScope, input: { portfolioId:string }): Promise<{portfolioId:string;environment:'paper';cashUnits:string;navUnits:string;positions:Array<{instrumentId:string;symbol:string;quantityUnits:string;priceUnits:string;marketValueUnits:string}>}> {
    const portfolio = (await this.scoped.query<{book_id:string;base_asset:string}>(scope, `SELECT book_id,base_asset FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_hlc IS NULL`,
      [scope.tenantId, scope.workspaceId, input.portfolioId])).rows[0];
    if (!portfolio) throw new Error('Portfolio not found');
    const [accounts, balances, instruments] = await Promise.all([
      this.ledger.accounts(scope, portfolio.book_id), this.ledger.balances(scope, { environment: 'paper', bookId: portfolio.book_id }),
      this.instruments(scope),
    ]);
    const codes = new Map(accounts.map((account) => [account.id, account.code]));
    const cashUnits = balances.find((balance) => codes.get(balance.accountId) === 'cash' && balance.asset === portfolio.base_asset)?.units ?? '0';
    const positions = [] as Array<{instrumentId:string;symbol:string;quantityUnits:string;priceUnits:string;marketValueUnits:string}>;
    for (const instrument of instruments) {
      const accountCode = `position:${instrument.id}`;
      const balance = balances.find((candidate) => codes.get(candidate.accountId) === accountCode);
      if (!balance || BigInt(balance.units) <= 0n) continue;
      const quote = (await this.scoped.query<{price_units:string}>(scope, `SELECT price_units::text FROM invest_market_prices WHERE tenant_id=$1 AND workspace_id=$2 AND instrument_id=$3 ORDER BY received_at DESC LIMIT 1`,
        [scope.tenantId, scope.workspaceId, instrument.id])).rows[0];
      if (!quote) throw new Error(`Missing quote for held instrument ${instrument.symbol}`);
      positions.push({ instrumentId: instrument.id, symbol: instrument.symbol, quantityUnits: balance.units, priceUnits: quote.price_units,
        marketValueUnits: notionalUnits(balance.units, quote.price_units, instrument.quantity_scale).toString() });
    }
    const nav = positions.reduce((sum, position) => sum + BigInt(position.marketValueUnits), BigInt(cashUnits));
    return { portfolioId: input.portfolioId, environment: 'paper', cashUnits, navUnits: nav.toString(), positions };
  }
  async orders(scope: InvestScope, filter: { portfolioId?: string }): Promise<OrderRow[]> {
    return (await this.scoped.query<OrderRow>(scope,
      `SELECT o.id,o.portfolio_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text,
         COALESCE((SELECT sum(f.quantity_units) FROM invest_fills f WHERE f.tenant_id=o.tenant_id AND f.workspace_id=o.workspace_id AND f.order_id=o.id),0)::text AS filled_units
       FROM invest_orders o JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
       WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.deleted_hlc IS NULL AND ($3::uuid IS NULL OR o.portfolio_id=$3)
       ORDER BY o.created_at DESC LIMIT 200`, [scope.tenantId, scope.workspaceId, filter.portfolioId ?? null])).rows;
  }

  async riskState(scope: InvestScope, input: { portfolioId: string }): Promise<{portfolioId:string;killSwitch:boolean;killReason:string|null;dailyLossUnits:string;riskDate:string}> {
    const row = await this.scoped.query<{kill_switch:boolean;kill_reason:string|null;daily_loss_units:string;risk_date:string}>(scope,
      `SELECT kill_switch,kill_reason,daily_loss_units::text,risk_date::text FROM invest_portfolio_risk_state
       WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date()`,
      [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const state = row.rows[0];
    if (!state) {
      const previous = await this.scoped.query<{kill_switch:boolean;kill_reason:string|null}>(scope,
        `SELECT kill_switch,kill_reason FROM invest_latest_risk_halt($1,$2,$3)`, [scope.tenantId,scope.workspaceId,input.portfolioId]);
      return { portfolioId: input.portfolioId, killSwitch: previous.rows[0]?.kill_switch ?? false, killReason: previous.rows[0]?.kill_reason ?? null,
        dailyLossUnits: '0', riskDate: new Date().toISOString().slice(0,10) };
    }
    return { portfolioId: input.portfolioId, killSwitch: state.kill_switch, killReason: state.kill_reason,
      dailyLossUnits: state.daily_loss_units, riskDate: state.risk_date };
  }
  async taxLots(scope: InvestScope, input: { portfolioId: string }): Promise<Array<{id:string;instrumentId:string;symbol:string;acquiredUnits:string;remainingUnits:string;costBasisUnits:string;remainingBasisUnits:string;openedAt:string}>> {
    return (await this.scoped.query<{id:string;instrumentId:string;symbol:string;acquiredUnits:string;remainingUnits:string;costBasisUnits:string;remainingBasisUnits:string;openedAt:string}>(scope, `SELECT l.id,l.instrument_id AS "instrumentId",i.symbol,l.acquired_units::text AS "acquiredUnits",
      l.remaining_units::text AS "remainingUnits",l.cost_basis_units::text AS "costBasisUnits",l.remaining_basis_units::text AS "remainingBasisUnits",l.opened_at::text AS "openedAt"
      FROM invest_tax_lots l JOIN invest_instruments i ON i.tenant_id=l.tenant_id AND i.workspace_id=l.workspace_id AND i.id=l.instrument_id
      WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.portfolio_id=$3 AND l.remaining_units>0 ORDER BY l.opened_at,l.id`,
      [scope.tenantId, scope.workspaceId, input.portfolioId])).rows;
  }
  async breaches(scope: InvestScope): Promise<Array<{id:string;portfolio_id:string;instrument_id:string|null;kind:string;severity:'warning'|'high'|'critical';status:'open'|'acknowledged'|'resolved';owner_id:string|null;detail:Record<string,unknown>;opened_at:string}>> {
    return (await this.scoped.query<{id:string;portfolio_id:string;instrument_id:string|null;kind:string;severity:'warning'|'high'|'critical';status:'open'|'acknowledged'|'resolved';owner_id:string|null;detail:Record<string,unknown>;opened_at:string}>(scope, `SELECT id,portfolio_id,instrument_id,kind,severity,status,owner_id,detail,opened_at::text
      FROM invest_breaches WHERE tenant_id=$1 AND workspace_id=$2 AND status<>'resolved' ORDER BY opened_at DESC LIMIT 200`,
      [scope.tenantId, scope.workspaceId])).rows;
  }
  async manageBreach(scope: InvestScope, call: Call, input: {breachId:string;action:'assign'|'acknowledge'|'resolve';reason:string}): Promise<{id:string;status:'open'|'acknowledged'|'resolved';ownerId:string|null}> {
    const actorId = this.requireHumanOwner(scope, call);
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const result = await tx.query<{id:string;status:'open'|'acknowledged'|'resolved';owner_id:string|null}>(`SELECT id,status,owner_id FROM invest_breaches
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, input.breachId]);
      const breach = result.rows[0]; if (!breach || breach.status === 'resolved') throw new Error('Open breach not found');
      let status: 'open'|'acknowledged'|'resolved' = breach.status; let ownerId = breach.owner_id;
      if (input.action === 'assign') {
        if (status !== 'open') throw new Error('Only open breaches can be assigned');
        ownerId = actorId;
        await tx.query(`UPDATE invest_breaches SET owner_id=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, breach.id, actorId]);
      } else {
        if (ownerId !== actorId) throw new Error('Breach action requires its assigned owner');
        if (input.action === 'acknowledge') {
          if (status !== 'open') throw new Error('Only open breaches can be acknowledged');
          status = 'acknowledged';
          await tx.query(`UPDATE invest_breaches SET status='acknowledged' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, breach.id]);
        } else {
          if (status !== 'acknowledged') throw new Error('Breach must be acknowledged before resolution');
          status = 'resolved';
          await tx.query(`UPDATE invest_breaches SET status='resolved',resolved_at=now(),resolution_reason=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
            [scope.tenantId, scope.workspaceId, breach.id, input.reason]);
        }
      }
      await tx.query(`INSERT INTO invest_breach_events(id,tenant_id,workspace_id,breach_id,event_type,detail,actor_id)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [uuidv7(), scope.tenantId, scope.workspaceId, breach.id,
        input.action === 'assign' ? 'assigned' : input.action === 'acknowledge' ? 'acknowledged' : 'resolved', JSON.stringify({ reason: input.reason, ownerId }), actorId]);
      return { id: breach.id, status, ownerId };
    });
  }
  private async createBreach(tx: QueryTx, scope: InvestScope, actorId: string, portfolioId: string, instrumentId: string|null, severity: string, kind: string, detail: Record<string,string>): Promise<void> {
    const id = uuidv7();
    await tx.query(`INSERT INTO invest_breaches(id,tenant_id,workspace_id,portfolio_id,instrument_id,severity,kind,detail,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [id, scope.tenantId, scope.workspaceId, portfolioId, instrumentId, severity, kind, JSON.stringify(detail), actorId]);
    await tx.query(`INSERT INTO invest_breach_events(id,tenant_id,workspace_id,breach_id,event_type,detail,actor_id)
      VALUES($1,$2,$3,$4,'alerted',$5::jsonb,$6)`, [uuidv7(), scope.tenantId, scope.workspaceId, id, JSON.stringify({ severity, kind }), actorId]);
  }
  async reconcileStatement(scope: InvestScope, call: Call, input: {portfolioId:string;sourceName:string;sourceRef:string;statementDate:string;statementHash:string;cashUnits:string;positions:Array<{symbol:string;units:string}>}): Promise<{runId:string;status:'matched'|'needs_review';discrepancyCount:number;idempotent:boolean}> {
    const actorId = this.requireHumanOwner(scope, call);
    return this.reconcilePersistedStatement(scope, actorId, input);
  }

  private async reconcilePersistedStatement(scope: InvestScope, actorId: string, input: {portfolioId:string;sourceName:string;sourceRef:string;statementDate:string;statementHash:string;cashUnits:string;positions:readonly {symbol:string;units:string}[]}, transaction?: QueryTx): Promise<{runId:string;status:'matched'|'needs_review';discrepancyCount:number;idempotent:boolean}> {
    const normalizedPositions = input.positions.map((position) => ({ symbol: position.symbol.trim().toUpperCase(), units: position.units })).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    const canonical = JSON.stringify({ portfolioId:input.portfolioId,source:input.sourceName,ref:input.sourceRef,statementDate:input.statementDate,cashUnits:input.cashUnits,positions:normalizedPositions });
    const computedHash = createHash('sha256').update(canonical).digest('hex');
    if (computedHash !== input.statementHash) throw new Error('Statement content hash does not match the submitted snapshot');
    const priorQuery = transaction
      ? transaction.query<{id:string;status:'matched'|'needs_review';discrepancy_count:number}>(
        `SELECT r.id,r.status,count(d.id)::int AS discrepancy_count FROM invest_reconciliation_runs r
         LEFT JOIN invest_reconciliation_discrepancies d ON d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.run_id=r.id
         WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.portfolio_id=$3 AND r.statement_hash=$4 GROUP BY r.id`,
        [scope.tenantId, scope.workspaceId, input.portfolioId, input.statementHash])
      : this.scoped.query<{id:string;status:'matched'|'needs_review';discrepancy_count:number}>(scope,
      `SELECT r.id,r.status,count(d.id)::int AS discrepancy_count FROM invest_reconciliation_runs r
       LEFT JOIN invest_reconciliation_discrepancies d ON d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.run_id=r.id
       WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.portfolio_id=$3 AND r.statement_hash=$4 GROUP BY r.id`,
      [scope.tenantId, scope.workspaceId, input.portfolioId, input.statementHash]);
    const prior = await priorQuery;
    if (prior.rows[0]) return { runId: prior.rows[0].id, status: prior.rows[0].status, discrepancyCount: prior.rows[0].discrepancy_count, idempotent: true };
    const portfolio = await this.scoped.query<{base_asset:string}>(scope, `SELECT base_asset FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='active'`,
      [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const baseAsset = portfolio.rows[0]?.base_asset; if (!baseAsset) throw new Error('Active PAPER portfolio not found');
    const ledger = await this.summary(scope, { portfolioId: input.portfolioId });
    const recorded = new Map(ledger.positions.map((position) => [position.symbol.toUpperCase(), BigInt(position.quantityUnits)]));
    const external = new Map(normalizedPositions.map((position) => [position.symbol, BigInt(position.units)]));
    const mismatches: Array<{key:string;kind:'cash_mismatch'|'position_mismatch'|'unknown_position';expected:bigint;observed:bigint}> = [];
    if (BigInt(ledger.cashUnits) !== BigInt(input.cashUnits)) mismatches.push({ key:`cash:${baseAsset}`,kind:'cash_mismatch',expected:BigInt(ledger.cashUnits),observed:BigInt(input.cashUnits) });
    for (const [symbol, units] of external) {
      const expected = recorded.get(symbol);
      if (expected === undefined) mismatches.push({ key:`position:${symbol}`,kind:'unknown_position',expected:0n,observed:units });
      else if (expected !== units) mismatches.push({ key:`position:${symbol}`,kind:'position_mismatch',expected,observed:units });
    }
    for (const [symbol, units] of recorded) if (!external.has(symbol)) mismatches.push({ key:`position:${symbol}`,kind:'position_mismatch',expected:units,observed:0n });
    const runId = uuidv7(); const status = mismatches.length ? 'needs_review' : 'matched';
    const ledgerSnapshot = { cashAsset: baseAsset, cashUnits: ledger.cashUnits, positions: ledger.positions.map(({symbol,quantityUnits}) => ({symbol,units:quantityUnits})) };
    const statementSnapshot = { sourceName: input.sourceName, sourceRef: input.sourceRef, statementDate: input.statementDate, cashUnits: input.cashUnits, positions: normalizedPositions };
    const persist = async (tx: QueryTx): Promise<void> => {
      await tx.query(`INSERT INTO invest_reconciliation_runs(id,tenant_id,workspace_id,portfolio_id,source_name,source_ref,statement_date,statement_hash,status,ledger_snapshot,statement_snapshot,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`, [runId,scope.tenantId,scope.workspaceId,input.portfolioId,input.sourceName,input.sourceRef,input.statementDate,input.statementHash,status,JSON.stringify(ledgerSnapshot),JSON.stringify(statementSnapshot),actorId]);
      await tx.query(`INSERT INTO invest_reconciliation_events(id,tenant_id,workspace_id,run_id,event_type,detail,actor_id) VALUES($1,$2,$3,$4,'run_recorded',$5::jsonb,$6)`,
        [uuidv7(),scope.tenantId,scope.workspaceId,runId,JSON.stringify({status,discrepancyCount:mismatches.length,statementHash:input.statementHash}),actorId]);
      for (const discrepancy of mismatches) {
        const id=uuidv7(); const difference=discrepancy.observed-discrepancy.expected;
        await tx.query(`INSERT INTO invest_reconciliation_discrepancies(id,tenant_id,workspace_id,run_id,discrepancy_key,kind,expected_units,observed_units,difference_units,owner_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id,scope.tenantId,scope.workspaceId,runId,discrepancy.key,discrepancy.kind,discrepancy.expected.toString(),discrepancy.observed.toString(),difference.toString(),actorId]);
        await tx.query(`INSERT INTO invest_reconciliation_events(id,tenant_id,workspace_id,run_id,event_type,detail,actor_id) VALUES($1,$2,$3,$4,'discrepancy_detected',$5::jsonb,$6)`,
          [uuidv7(),scope.tenantId,scope.workspaceId,runId,JSON.stringify({discrepancyId:id,key:discrepancy.key,kind:discrepancy.kind,differenceUnits:difference.toString()}),actorId]);
      }
    };
    if (transaction) await persist(transaction);
    else await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, persist);
    return { runId, status, discrepancyCount:mismatches.length, idempotent:false };
  }

  /**
   * Callable only from the trusted FLOW host handler. FLOW derives scheduledFor
   * from persisted run detail; no schedule data is accepted from workflow input.
   */
  async dispatchScheduledCustody(context: TrustedFlowStepContext): Promise<{
    status:'completed'; idempotent:boolean; utcDay:string;
    inputs:Array<{statementId:string;runId:string;reconciliation:'matched'|'needs_review';discrepancyCount:number}>;
  }> {
    const dispatch = validateScheduledCustodyContext(context);
    const scope: InvestScope = { ...dispatch.scope, hlc:this.clock.now() };
    type DispatchOutput = {utcDay:string;inputs:Array<{statementId:string;runId:string;reconciliation:'matched'|'needs_review';discrepancyCount:number}>};
    const completed = await this.scoped.withServerScope(scope,'invest_paper',scope.hlc,(tx)=>tx.query<{result:DispatchOutput}>(
      `SELECT result FROM invest_custody_dispatches WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3 AND status='completed'`,
      [scope.tenantId,scope.workspaceId,dispatch.idempotencyKey]));
    if (completed.rows[0]) {
      const output = completed.rows[0].result;
      if (this.custodyInbox) {
        try { await this.custodyInbox.acknowledgeProcessed(dispatch.scope,output.inputs.map((input)=>input.statementId),dispatch.dispatchId); }
        catch { throw new Error('INVEST_CUSTODY_ACK_PENDING'); }
      }
      return {status:'completed',...output,idempotent:true};
    }
    if (!this.custodyInbox) {
      await this.recordCustodyDispatchFailure(scope,dispatch,'connector_unavailable','INVEST_CUSTODY_CONNECTOR_UNAVAILABLE');
      throw new Error('INVEST_CUSTODY_CONNECTOR_UNAVAILABLE');
    }
    let statements: readonly PersistedCustodyStatement[];
    try { statements = await this.custodyInbox.listEligible(dispatch.scope,dispatch.scheduledFor); }
    catch {
      await this.recordCustodyDispatchFailure(scope,dispatch,'connector_unavailable','INVEST_CUSTODY_CONNECTOR_UNAVAILABLE');
      throw new Error('INVEST_CUSTODY_CONNECTOR_UNAVAILABLE');
    }
    if (statements.length > 500 || new Set(statements.map((statement)=>statement.id)).size !== statements.length) {
      await this.recordCustodyDispatchFailure(scope,dispatch,'failed','INVEST_CUSTODY_INPUT_SET_INVALID');
      throw new Error('INVEST_CUSTODY_INPUT_SET_INVALID');
    }
    for (const statement of statements) {
      if (![statement.id,statement.ownerId,statement.portfolioId].every((value)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
        await this.recordCustodyDispatchFailure(scope,dispatch,'failed','INVEST_CUSTODY_INPUT_ID_INVALID');
        throw new Error('INVEST_CUSTODY_INPUT_ID_INVALID');
      }
    }
    const claimed = await this.scoped.withServerScope(scope,'invest_paper',scope.hlc,async(tx)=>{
      const prior=await tx.query<{status:string;result:DispatchOutput|null;lease_until:string|null}>(`SELECT status,result,lease_until::text FROM invest_custody_dispatches
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3 FOR UPDATE`,[scope.tenantId,scope.workspaceId,dispatch.idempotencyKey]);
      if(prior.rows[0]?.status==='completed' && prior.rows[0].result) return {state:'completed' as const,result:prior.rows[0].result};
      if(prior.rows[0]?.status==='running' && prior.rows[0].lease_until && Date.parse(prior.rows[0].lease_until)>Date.now()) return {state:'running' as const};
      const acquired=await tx.query<{id:string}>(`INSERT INTO invest_custody_dispatches(id,tenant_id,workspace_id,workflow_id,run_id,step_id,dispatch_id,idempotency_key,scheduled_for,status,result,error_code,attempts,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',NULL,NULL,1,now()+interval '15 minutes')
        ON CONFLICT(tenant_id,workspace_id,idempotency_key) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,run_id=EXCLUDED.run_id,
          step_id=EXCLUDED.step_id,dispatch_id=EXCLUDED.dispatch_id,scheduled_for=EXCLUDED.scheduled_for,status='running',result=NULL,error_code=NULL,
          completed_at=NULL,lease_until=EXCLUDED.lease_until,attempts=invest_custody_dispatches.attempts+1,updated_at=now()
        WHERE invest_custody_dispatches.status<>'completed' AND (invest_custody_dispatches.status<>'running' OR invest_custody_dispatches.lease_until<=now())
        RETURNING id`,
        [uuidv7(),scope.tenantId,scope.workspaceId,dispatch.workflowId,dispatch.runId,dispatch.stepId,dispatch.dispatchId,dispatch.idempotencyKey,dispatch.scheduledFor]);
      if(!acquired.rows[0]) return {state:'running' as const};
      return {state:'claimed' as const};
    });
    if(claimed.state==='completed'){
      try { await this.custodyInbox.acknowledgeProcessed(dispatch.scope,claimed.result.inputs.map((input)=>input.statementId),dispatch.dispatchId); }
      catch { throw new Error('INVEST_CUSTODY_ACK_PENDING'); }
      return {status:'completed',...claimed.result,idempotent:true};
    }
    if(claimed.state==='running') throw new Error('INVEST_CUSTODY_DISPATCH_IN_PROGRESS');
    let result: DispatchOutput;
    try {
      const inputs:DispatchOutput['inputs']=[];
      for(const statement of statements){
        const reconciliation=await this.reconcilePersistedStatement(scope,statement.ownerId,statement);
        inputs.push({statementId:statement.id,runId:reconciliation.runId,reconciliation:reconciliation.status,discrepancyCount:reconciliation.discrepancyCount});
      }
      result={utcDay:dispatch.utcDay,inputs};
      await this.scoped.withServerScope(scope,'invest_paper',scope.hlc,(tx)=>tx.query(`UPDATE invest_custody_dispatches
        SET status='completed',result=$4::jsonb,error_code=NULL,completed_at=now(),lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3 AND status='running' AND dispatch_id=$5`,
        [scope.tenantId,scope.workspaceId,dispatch.idempotencyKey,JSON.stringify(result),dispatch.dispatchId]));
    } catch(error) {
      const code=error instanceof Error && error.message==='INVEST_CUSTODY_CONNECTOR_UNAVAILABLE' ? 'INVEST_CUSTODY_CONNECTOR_UNAVAILABLE' : 'INVEST_CUSTODY_RECONCILIATION_FAILED';
      await this.recordCustodyDispatchFailure(scope,dispatch,code==='INVEST_CUSTODY_CONNECTOR_UNAVAILABLE'?'connector_unavailable':'failed',code);
      throw error;
    }
    try { await this.custodyInbox.acknowledgeProcessed(dispatch.scope,result.inputs.map((input)=>input.statementId),dispatch.dispatchId); }
    catch { throw new Error('INVEST_CUSTODY_ACK_PENDING'); }
    return {status:'completed',...result,idempotent:false};
  }

  private async recordCustodyDispatchFailure(scope:InvestScope,dispatch:ReturnType<typeof validateScheduledCustodyContext>,status:'connector_unavailable'|'failed',code:string):Promise<void>{
    await this.scoped.withServerScope(scope,'invest_paper',scope.hlc,async(tx)=>{
      await tx.query(`INSERT INTO invest_custody_dispatches(id,tenant_id,workspace_id,workflow_id,run_id,step_id,dispatch_id,idempotency_key,scheduled_for,status,result,error_code,attempts,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,1,NULL)
        ON CONFLICT(tenant_id,workspace_id,idempotency_key) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,run_id=EXCLUDED.run_id,
          step_id=EXCLUDED.step_id,dispatch_id=EXCLUDED.dispatch_id,scheduled_for=EXCLUDED.scheduled_for,
          status=EXCLUDED.status,error_code=EXCLUDED.error_code,lease_until=NULL,
          attempts=invest_custody_dispatches.attempts + CASE WHEN invest_custody_dispatches.dispatch_id=EXCLUDED.dispatch_id THEN 0 ELSE 1 END,updated_at=now()
        WHERE invest_custody_dispatches.status<>'completed' AND (invest_custody_dispatches.status<>'running' OR invest_custody_dispatches.lease_until<=now() OR invest_custody_dispatches.dispatch_id=EXCLUDED.dispatch_id)`,
        [uuidv7(),scope.tenantId,scope.workspaceId,dispatch.workflowId,dispatch.runId,dispatch.stepId,dispatch.dispatchId,dispatch.idempotencyKey,dispatch.scheduledFor,status,code]);
    });
  }

  async reconciliationQueue(scope: InvestScope): Promise<Array<{id:string;run_id:string;portfolio_id:string;source_name:string;source_ref:string;statement_date:string;discrepancy_key:string;kind:'cash_mismatch'|'position_mismatch'|'unknown_position';expected_units:string;observed_units:string;difference_units:string;owner_id:string;created_at:string}>> {
    return (await this.scoped.query<{id:string;run_id:string;portfolio_id:string;source_name:string;source_ref:string;statement_date:string;discrepancy_key:string;kind:'cash_mismatch'|'position_mismatch'|'unknown_position';expected_units:string;observed_units:string;difference_units:string;owner_id:string;created_at:string}>(scope,`SELECT d.id,d.run_id,r.portfolio_id,r.source_name,r.source_ref,r.statement_date::text,d.discrepancy_key,d.kind,
        d.expected_units::text,d.observed_units::text,d.difference_units::text,d.owner_id,d.created_at::text
      FROM invest_reconciliation_discrepancies d
      JOIN invest_reconciliation_runs r ON r.tenant_id=d.tenant_id AND r.workspace_id=d.workspace_id AND r.id=d.run_id
      WHERE d.tenant_id=$1 AND d.workspace_id=$2
      ORDER BY d.created_at DESC,d.id`,[scope.tenantId,scope.workspaceId])).rows;
  }

  async instruments(scope: InvestScope): Promise<Array<{id:string;symbol:string;asset_class:string;quantity_scale:number;exchange_code:string|null}>> {
    return (await this.scoped.query<{id:string;symbol:string;asset_class:string;quantity_scale:number;exchange_code:string|null}>(scope, `SELECT id,symbol,asset_class,quantity_scale,exchange_code FROM invest_instruments
      WHERE tenant_id=$1 AND workspace_id=$2 AND active=true ORDER BY symbol`, [scope.tenantId, scope.workspaceId])).rows;
  }

  async recordPrice(scope: InvestScope, actorId: string, input: { instrumentId: string; priceUnits: string; source: string; sourceAt: string; volatilityBps: number; payloadHash: string }): Promise<{id:string;received_at:string}> {
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const insert = await tx.query<{id:string;received_at:string}>(
        `INSERT INTO invest_market_prices(id,tenant_id,workspace_id,instrument_id,price_units,source,source_at,volatility_bps,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,workspace_id,instrument_id,source,payload_hash) DO NOTHING RETURNING id,received_at::text`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.instrumentId, input.priceUnits, input.source, input.sourceAt, input.volatilityBps, input.payloadHash]);
      const row = insert.rows[0] ? insert : await tx.query<{id:string;received_at:string}>(`SELECT id,received_at::text FROM invest_market_prices WHERE tenant_id=$1 AND workspace_id=$2 AND instrument_id=$3 AND source=$4 AND payload_hash=$5`,
        [scope.tenantId, scope.workspaceId, input.instrumentId, input.source, input.payloadHash]);
      if (row.rows[0]) await this.monitorPaperPortfolios(tx, scope, actorId, input.instrumentId);
      return row;
    });
    if (!result.rows[0]) throw new Error('Market price insert failed'); return result.rows[0];
  }

  private async monitorPaperPortfolios(tx: QueryTx, scope: InvestScope, actorId: string, changedInstrumentId: string): Promise<void> {
    const portfolios = await tx.query<{id:string;book_id:string;base_asset:string;limits:unknown}>(
      `SELECT p.id,p.book_id,p.base_asset,m.limits FROM invest_portfolios p
       JOIN LATERAL (SELECT limits FROM invest_mandates WHERE tenant_id=p.tenant_id AND workspace_id=p.workspace_id AND portfolio_id=p.id
         AND status='approved' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) ORDER BY version DESC LIMIT 1) m ON true
       WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.status='active'`, [scope.tenantId, scope.workspaceId]);
    for (const portfolio of portfolios.rows) {
      const limits = GuardrailLimits.parse(portfolio.limits);
      const ledgerRows = await tx.query<{code:string;asset:string;units:string}>(
        `SELECT a.code,b.asset,b.units::text FROM ledger_balances b JOIN ledger_accounts a
           ON a.tenant_id=b.tenant_id AND a.workspace_id=b.workspace_id AND a.book_id=b.book_id AND a.id=b.account_id
         WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.book_id=$3`, [scope.tenantId, scope.workspaceId, portfolio.book_id]);
      const cash = BigInt(ledgerRows.rows.find((row) => row.code === 'cash' && row.asset === portfolio.base_asset)?.units ?? '0');
      const instruments = await tx.query<{id:string;quantity_scale:number;units:string;price_units:string|null}>(
        `SELECT i.id,i.quantity_scale,COALESCE(b.units,0)::text AS units,q.price_units::text
         FROM invest_instruments i JOIN ledger_accounts a ON a.tenant_id=i.tenant_id AND a.workspace_id=i.workspace_id
           AND a.book_id=$3 AND a.code='position:'||i.id::text
         LEFT JOIN ledger_balances b ON b.tenant_id=a.tenant_id AND b.workspace_id=a.workspace_id AND b.book_id=a.book_id AND b.account_id=a.id AND b.asset=i.asset_code
         LEFT JOIN LATERAL (SELECT price_units FROM invest_market_prices WHERE tenant_id=i.tenant_id AND workspace_id=i.workspace_id AND instrument_id=i.id ORDER BY received_at DESC LIMIT 1) q ON true
         WHERE i.tenant_id=$1 AND i.workspace_id=$2`, [scope.tenantId, scope.workspaceId, portfolio.book_id]);
      let gross = 0n;
      const positionValues: Array<{instrumentId:string;value:bigint}> = [];
      for (const instrument of instruments.rows) {
        const units = BigInt(instrument.units);
        if (units < 0n) throw new Error('Negative PAPER ledger position detected during price mark');
        if (!units) continue;
        if (!instrument.price_units) throw new Error(`Cannot risk-mark held instrument ${instrument.id} without a current quote`);
        const value = notionalUnits(units.toString(), instrument.price_units, instrument.quantity_scale);
        gross += value;
        positionValues.push({ instrumentId: instrument.id, value });
      }
      const nav = cash + gross;
      const prior = await tx.query<{day_open_nav_units:string;high_water_nav_units:string;daily_loss_units:string;kill_switch:boolean;kill_reason:string|null}>(
        `SELECT day_open_nav_units::text,high_water_nav_units::text,daily_loss_units::text,kill_switch FROM invest_portfolio_risk_state
         WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date() FOR UPDATE`,
        [scope.tenantId, scope.workspaceId, portfolio.id]);
      const state = prior.rows[0]; const opening = BigInt(state?.day_open_nav_units ?? nav.toString());
      const highWater = BigInt(state?.high_water_nav_units ?? nav.toString());
      const loss = [BigInt(state?.daily_loss_units ?? '0'), opening > nav ? opening-nav : 0n].reduce((a,b) => a>b ? a:b);
      const drawdownHit = highWater > nav && (highWater-nav)*10_000n >= highWater*BigInt(limits.maxDrawdownBps);
      const dailyLossHit = loss >= BigInt(limits.maxDailyLossUnits);
      const autoHalt = dailyLossHit || drawdownHit;
      const lastHalt = state ? undefined : (await tx.query<{kill_switch:boolean;kill_reason:string|null}>(`SELECT kill_switch,kill_reason FROM invest_latest_risk_halt($1,$2,$3)`, [scope.tenantId,scope.workspaceId,portfolio.id])).rows[0];
      const retainedHalt = state?.kill_switch ?? lastHalt?.kill_switch ?? false;
      const retainedReason = retainedHalt && !autoHalt ? state?.kill_reason ?? lastHalt?.kill_reason : null;
      const reason = dailyLossHit ? 'Automatic PAPER halt: daily-loss mandate exceeded' : drawdownHit ? 'Automatic PAPER halt: drawdown limit exceeded' : retainedReason;
      await tx.query(`INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
        VALUES($1,$2,$3,invest_utc_risk_date(),$4,$4,$5,$6,CASE WHEN $6 THEN $7 ELSE NULL END)
        ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET high_water_nav_units=GREATEST(invest_portfolio_risk_state.high_water_nav_units,EXCLUDED.high_water_nav_units),
          daily_loss_units=EXCLUDED.daily_loss_units,kill_switch=invest_portfolio_risk_state.kill_switch OR EXCLUDED.kill_switch,
          kill_reason=CASE WHEN EXCLUDED.kill_switch THEN EXCLUDED.kill_reason ELSE invest_portfolio_risk_state.kill_reason END,updated_at=now()`,
        [scope.tenantId, scope.workspaceId, portfolio.id, nav.toString(), loss.toString(), retainedHalt || autoHalt, reason]);
      const breaches: Array<{instrumentId:string|null;kind:string;detail:Record<string,string>}> = [];
      for (const position of positionValues) {
        if (position.value > BigInt(limits.maxPositionNotionalUnits)) breaches.push({ instrumentId:position.instrumentId, kind:'max_position_notional', detail:{value:position.value.toString(),limit:limits.maxPositionNotionalUnits} });
        if (nav > 0n && position.value*10_000n > nav*BigInt(limits.maxConcentrationBps)) breaches.push({ instrumentId:position.instrumentId, kind:'position_concentration', detail:{value:position.value.toString(),nav:nav.toString(),limitBps:String(limits.maxConcentrationBps)} });
      }
      if (nav > 0n && gross*10_000n > nav*BigInt(limits.maxLeverageBps)) breaches.push({ instrumentId:null, kind:'gross_leverage', detail:{exposure:gross.toString(),nav:nav.toString(),limitBps:String(limits.maxLeverageBps)} });
      if (loss > 0n) breaches.push({ instrumentId:null, kind:'daily_loss', detail:{lossUnits:loss.toString(),limitUnits:limits.maxDailyLossUnits} });
      if (drawdownHit) breaches.push({ instrumentId:null, kind:'drawdown', detail:{highWaterUnits:highWater.toString(),navUnits:nav.toString(),limitBps:String(limits.maxDrawdownBps)} });
      for (const breach of breaches) {
        const exists = await tx.query<{id:string}>(`SELECT id FROM invest_breaches WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3
          AND kind=$4 AND instrument_id IS NOT DISTINCT FROM $5 AND status<>'resolved'`,
          [scope.tenantId, scope.workspaceId, portfolio.id, breach.kind, breach.instrumentId]);
        if (!exists.rows.length) await this.createBreach(tx, scope, actorId, portfolio.id, breach.instrumentId, autoHalt ? 'critical' : 'high', breach.kind,
          { ...breach.detail, source: 'market_mark', instrumentId: changedInstrumentId });
      }
      if (autoHalt) {
        const cancelled = await tx.query<{id:string;status:string}>(`UPDATE invest_orders SET status='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND status IN ('proposed','approved','submitted','partially_filled') RETURNING id,status`,
          [scope.tenantId, scope.workspaceId, portfolio.id]);
        for (const order of cancelled.rows) await this.orderEvent(tx, scope, actorId, order.id, 'cancelled', order.status, 'cancelled', { reason: 'Automatic PAPER risk halt after market mark' });
      }
    }
  }

  async recordMarketSession(scope: InvestScope, input: { exchangeCode: string; sessionDate: string; opensAt: string; closesAt: string; isOpen: boolean; source: string }): Promise<{received_at:string}> {
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const insert = await tx.query<{received_at:string}>(`INSERT INTO invest_market_sessions(id,tenant_id,workspace_id,exchange_code,session_date,opens_at,closes_at,is_open,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,workspace_id,exchange_code,session_date,source) DO NOTHING RETURNING received_at::text`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.exchangeCode, input.sessionDate, input.opensAt, input.closesAt, input.isOpen, input.source]);
      if (insert.rows[0]) return insert;
      return tx.query<{received_at:string}>(`SELECT received_at::text FROM invest_market_sessions WHERE tenant_id=$1 AND workspace_id=$2 AND exchange_code=$3 AND session_date=$4 AND source=$5`,
        [scope.tenantId, scope.workspaceId, input.exchangeCode, input.sessionDate, input.source]);
    });
    if (!result.rows[0]) throw new Error('Market session insert failed'); return result.rows[0];
  }

  async runBacktest(scope: InvestScope, actorId: string, input: {instrumentId:string;dataVersion:number;sourceName:string;sourceRef:string;bars:OhlcBar[];strategy:MomentumStopTargetStrategy}): Promise<{
    runId:string;engineVersion:'momentum-next-bar-v1';dataVersion:number;strategyId:string;strategyVersion:number;dataHash:string;strategyHash:string;
    trades:Array<{entryBar:number;exitBar:number;entryPriceUnits:string;exitPriceUnits:string;quantityUnits:string;grossPnlUnits:string;feesUnits:string;netPnlUnits:string;exitReason:'stop'|'target'|'end_of_data'}>;totalFeesUnits:string;netPnlUnits:string;
  }> {
    const instrument = await this.scoped.query<{quantity_scale:number}>(scope,`SELECT quantity_scale FROM invest_instruments WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,[scope.tenantId,scope.workspaceId,input.instrumentId]);
    const row = instrument.rows[0]; if (!row) throw new Error('Backtest instrument is outside the authenticated workspace or does not exist');
    const result = runMomentumStopTargetBacktest(input.bars,input.strategy,row.quantity_scale);
    const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const stored = await this.scoped.withServerScope(scope,'invest_paper',scope.hlc,async (tx) => {
      const datasetInsert = await tx.query<{id:string}>(`INSERT INTO invest_backtest_datasets(id,tenant_id,workspace_id,instrument_id,data_version,source_name,source_ref,bars,data_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT(tenant_id,workspace_id,instrument_id,data_version) DO NOTHING RETURNING id`,
        [uuidv7(),scope.tenantId,scope.workspaceId,input.instrumentId,input.dataVersion,input.sourceName,input.sourceRef,JSON.stringify(input.bars),result.dataHash,actorId]);
      let datasetId=datasetInsert.rows[0]?.id;
      if (!datasetId) {
        const dataset = (await tx.query<{id:string;data_hash:string;source_name:string;source_ref:string}>(`SELECT id,data_hash,source_name,source_ref FROM invest_backtest_datasets WHERE tenant_id=$1 AND workspace_id=$2 AND instrument_id=$3 AND data_version=$4`,
          [scope.tenantId,scope.workspaceId,input.instrumentId,input.dataVersion])).rows[0];
        if (!dataset || dataset.data_hash !== result.dataHash || dataset.source_name !== input.sourceName || dataset.source_ref !== input.sourceRef) throw new Error('Backtest data version already exists with different content or provenance');
        datasetId=dataset.id;
      }
      const strategyConfig = backtestStrategyIdentity(input.strategy,row.quantity_scale);
      const strategyInsert = await tx.query<{id:string}>(`INSERT INTO invest_backtest_strategies(id,tenant_id,workspace_id,strategy_key,strategy_version,config,strategy_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(tenant_id,workspace_id,strategy_key,strategy_version) DO NOTHING RETURNING id`,
        [uuidv7(),scope.tenantId,scope.workspaceId,input.strategy.id,input.strategy.version,JSON.stringify(strategyConfig),result.strategyHash,actorId]);
      let strategyId=strategyInsert.rows[0]?.id;
      if (!strategyId) {
        const strategy = (await tx.query<{id:string;strategy_hash:string}>(`SELECT id,strategy_hash FROM invest_backtest_strategies WHERE tenant_id=$1 AND workspace_id=$2 AND strategy_key=$3 AND strategy_version=$4`,
          [scope.tenantId,scope.workspaceId,input.strategy.id,input.strategy.version])).rows[0];
        if (!strategy || strategy.strategy_hash !== result.strategyHash) throw new Error('Backtest strategy version already exists with different configuration');
        strategyId=strategy.id;
      }
      const prior = await tx.query<{id:string;result:typeof result}>(`SELECT id,result FROM invest_backtest_runs WHERE tenant_id=$1 AND workspace_id=$2 AND dataset_id=$3 AND strategy_id=$4`,
        [scope.tenantId,scope.workspaceId,datasetId,strategyId]);
      if (prior.rows[0]) return {runId:prior.rows[0].id,...prior.rows[0].result};
      const runId = uuidv7();
      await tx.query(`INSERT INTO invest_backtest_runs(id,tenant_id,workspace_id,dataset_id,strategy_id,engine_version,result,result_hash,total_fees_units,net_pnl_units,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,[runId,scope.tenantId,scope.workspaceId,datasetId,strategyId,result.engineVersion,JSON.stringify(result),resultHash,result.totalFeesUnits,result.netPnlUnits,actorId]);
      return {runId,...result};
    });
    return {runId:stored.runId,engineVersion:stored.engineVersion,dataVersion:input.dataVersion,strategyId:input.strategy.id,strategyVersion:input.strategy.version,
      dataHash:stored.dataHash,strategyHash:stored.strategyHash,trades:stored.trades,totalFeesUnits:stored.totalFeesUnits,netPnlUnits:stored.netPnlUnits};
  }

  async backtestRuns(scope:InvestScope,input:{instrumentId:string}):Promise<Array<{id:string;data_version:number;source_name:string;source_ref:string;data_hash:string;strategy_key:string;strategy_version:number;strategy_hash:string;engine_version:string;total_fees_units:string;net_pnl_units:string;created_at:string}>> {
    return (await this.scoped.query<{id:string;data_version:number;source_name:string;source_ref:string;data_hash:string;strategy_key:string;strategy_version:number;strategy_hash:string;engine_version:string;total_fees_units:string;net_pnl_units:string;created_at:string}>(scope,`SELECT r.id,d.data_version,d.source_name,d.source_ref,d.data_hash,s.strategy_key,s.strategy_version,s.strategy_hash,r.engine_version,
        r.total_fees_units::text,r.net_pnl_units::text,r.created_at::text
      FROM invest_backtest_runs r JOIN invest_backtest_datasets d ON d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.id=r.dataset_id
      JOIN invest_backtest_strategies s ON s.tenant_id=r.tenant_id AND s.workspace_id=r.workspace_id AND s.id=r.strategy_id
      WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND d.instrument_id=$3 ORDER BY r.created_at DESC LIMIT 100`,[scope.tenantId,scope.workspaceId,input.instrumentId])).rows;
  }

  async performanceMarks(scope:InvestScope,input:{portfolioId:string}):Promise<Array<{id:string;portfolio_id:string;captured_at:string;nav_units:string;cash_units:string;benchmark_index_units:string;benchmark_source:string;benchmark_ref:string;external_flow_units:string;cumulative_fee_units:string}>> {
    return (await this.scoped.query<{id:string;portfolio_id:string;captured_at:string;nav_units:string;cash_units:string;benchmark_index_units:string;benchmark_source:string;benchmark_ref:string;external_flow_units:string;cumulative_fee_units:string}>(scope,
      `SELECT id,portfolio_id,captured_at::text,nav_units::text,cash_units::text,benchmark_index_units::text,benchmark_source,benchmark_ref,external_flow_units::text,cumulative_fee_units::text
       FROM invest_performance_marks WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 ORDER BY captured_at,id LIMIT 10000`,[scope.tenantId,scope.workspaceId,input.portfolioId])).rows;
  }

  async capturePerformanceMark(scope:InvestScope,call:Call,input:{portfolioId:string;benchmarkIndexUnits:string;benchmarkSource:string;benchmarkRef:string}):Promise<{id:string;portfolio_id:string;captured_at:string;nav_units:string;cash_units:string;benchmark_index_units:string;benchmark_source:string;benchmark_ref:string;external_flow_units:string;cumulative_fee_units:string}> {
    const actorId=this.requireHumanOwner(scope,call);
    return this.paperLedger.withPaperTradeTransaction(scope,async (tx)=>{
      const portfolio=(await tx.query<{book_id:string;base_asset:string}>(`SELECT book_id,base_asset FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='active'`,
        [scope.tenantId,scope.workspaceId,input.portfolioId])).rows[0];
      if(!portfolio) throw new Error('Active PAPER portfolio not found');
      const cash=(await tx.query<{units:string}>(`SELECT COALESCE(b.units,0)::text AS units FROM ledger_accounts a LEFT JOIN ledger_balances b
        ON b.tenant_id=a.tenant_id AND b.workspace_id=a.workspace_id AND b.book_id=a.book_id AND b.account_id=a.id AND b.asset=$4
        WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.book_id=$3 AND a.code='cash'`,[scope.tenantId,scope.workspaceId,portfolio.book_id,portfolio.base_asset])).rows[0];
      if(!cash) throw new Error('PAPER cash account is missing');
      const holdings=(await tx.query<{instrument_id:string;quantity_units:string;quantity_scale:number;price_units:string|null}>(`SELECT i.id AS instrument_id,COALESCE(b.units,0)::text AS quantity_units,i.quantity_scale,q.price_units::text
        FROM invest_instruments i JOIN ledger_accounts a ON a.tenant_id=i.tenant_id AND a.workspace_id=i.workspace_id AND a.book_id=$3 AND a.code='position:'||i.id::text
        LEFT JOIN ledger_balances b ON b.tenant_id=a.tenant_id AND b.workspace_id=a.workspace_id AND b.book_id=a.book_id AND b.account_id=a.id AND b.asset=i.asset_code
        LEFT JOIN LATERAL(SELECT price_units FROM invest_market_prices WHERE tenant_id=i.tenant_id AND workspace_id=i.workspace_id AND instrument_id=i.id ORDER BY received_at DESC LIMIT 1) q ON true
        WHERE i.tenant_id=$1 AND i.workspace_id=$2 AND i.active=true`,[scope.tenantId,scope.workspaceId,portfolio.book_id])).rows;
      let nav=BigInt(cash.units);
      for(const holding of holdings){const qty=BigInt(holding.quantity_units);if(qty<0n)throw new Error('Negative PAPER ledger position detected');if(qty===0n)continue;
        if(!holding.price_units)throw new Error(`Missing quote for performance valuation instrument ${holding.instrument_id}`);
        nav+=notionalUnits(qty.toString(),holding.price_units,holding.quantity_scale);}
      if(nav<=0n)throw new Error('PAPER portfolio NAV must be positive to capture a performance mark');
      const capturedAt=(await tx.query<{captured_at:string}>(`SELECT now()::text AS captured_at`)).rows[0]!.captured_at;
      const prior=(await tx.query<{captured_at:string;cumulative_fee_units:string}>(`SELECT captured_at::text,cumulative_fee_units::text FROM invest_performance_marks
        WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 ORDER BY captured_at DESC,id DESC LIMIT 1`,[scope.tenantId,scope.workspaceId,input.portfolioId])).rows[0];
      let externalFlow='0';
      if(prior){const capital=(await tx.query<{id:string}>(`SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$3 AND code='capital'`,[scope.tenantId,scope.workspaceId,portfolio.book_id])).rows[0];
        if(capital)externalFlow=(await tx.query<{units:string}>(`SELECT (-COALESCE(sum(e.units),0))::text AS units FROM ledger_entries e JOIN ledger_transactions t
          ON t.tenant_id=e.tenant_id AND t.workspace_id=e.workspace_id AND t.id=e.transaction_id
          WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.book_id=$3 AND e.account_id=$4 AND e.asset=$5 AND t.environment='paper' AND t.posted_at>$6 AND t.posted_at<=$7`,
          [scope.tenantId,scope.workspaceId,portfolio.book_id,capital.id,portfolio.base_asset,prior.captured_at,capturedAt])).rows[0]?.units??'0';}
      const fees=(await tx.query<{units:string}>(`SELECT COALESCE(sum(f.fee_units),0)::text AS units FROM invest_fills f JOIN invest_orders o
        ON o.tenant_id=f.tenant_id AND o.workspace_id=f.workspace_id AND o.id=f.order_id WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND o.portfolio_id=$3 AND f.created_at<=$4`,
        [scope.tenantId,scope.workspaceId,input.portfolioId,capturedAt])).rows[0]?.units??'0';
      const id=uuidv7();
      const saved=await tx.query<{id:string;portfolio_id:string;captured_at:string;nav_units:string;cash_units:string;benchmark_index_units:string;benchmark_source:string;benchmark_ref:string;external_flow_units:string;cumulative_fee_units:string}>(
        `INSERT INTO invest_performance_marks(id,tenant_id,workspace_id,portfolio_id,captured_at,nav_units,cash_units,benchmark_index_units,benchmark_source,benchmark_ref,external_flow_units,cumulative_fee_units,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,portfolio_id,captured_at::text,nav_units::text,cash_units::text,benchmark_index_units::text,benchmark_source,benchmark_ref,external_flow_units::text,cumulative_fee_units::text`,
        [id,scope.tenantId,scope.workspaceId,input.portfolioId,capturedAt,nav.toString(),cash.units,input.benchmarkIndexUnits,input.benchmarkSource,input.benchmarkRef,externalFlow,fees,actorId]);
      if(!saved.rows[0])throw new Error('Performance mark was not recorded');return saved.rows[0];
    });
  }

  async createPerformanceStatement(scope:InvestScope,call:Call,input:{portfolioId:string;fromMarkId:string;toMarkId:string}):Promise<{id:string;portfolio_id:string;created_at:string;report:PerformanceStatement}> {
    const actorId=this.requireHumanOwner(scope,call);
    const marks=(await this.scoped.query<PerformanceMark>(scope,`SELECT id,captured_at::text AS "capturedAt",nav_units::text AS "navUnits",benchmark_index_units::text AS "benchmarkIndexUnits",
        external_flow_units::text AS "externalFlowUnits",cumulative_fee_units::text AS "cumulativeFeeUnits" FROM invest_performance_marks
      WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND captured_at BETWEEN
        (SELECT captured_at FROM invest_performance_marks WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND id=$4) AND
        (SELECT captured_at FROM invest_performance_marks WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND id=$5)
      ORDER BY captured_at,id`,[scope.tenantId,scope.workspaceId,input.portfolioId,input.fromMarkId,input.toMarkId])).rows;
    if(marks.length<2||marks[0]?.id!==input.fromMarkId||marks[marks.length-1]?.id!==input.toMarkId)throw new Error('Statement marks must be ordered marks from the same portfolio');
    const report=calculateTimeWeightedStatement(marks);const hash=createHash('sha256').update(JSON.stringify(report)).digest('hex');
    return this.scoped.withServerScope(scope,'invest_paper',scope.hlc,async(tx)=>{
      const prior=(await tx.query<{id:string;created_at:string;result:PerformanceStatement}>(`SELECT id,created_at::text,result FROM invest_performance_reports
        WHERE tenant_id=$1 AND workspace_id=$2 AND from_mark_id=$3 AND to_mark_id=$4`,[scope.tenantId,scope.workspaceId,input.fromMarkId,input.toMarkId])).rows[0];
      if(prior)return{id:prior.id,portfolio_id:input.portfolioId,created_at:prior.created_at,report:prior.result};
      const saved=(await tx.query<{id:string;created_at:string;result:PerformanceStatement}>(`INSERT INTO invest_performance_reports(id,tenant_id,workspace_id,portfolio_id,from_mark_id,to_mark_id,calculation_version,result,result_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id,created_at::text,result`,
        [uuidv7(),scope.tenantId,scope.workspaceId,input.portfolioId,input.fromMarkId,input.toMarkId,report.calculationVersion,JSON.stringify(report),hash,actorId])).rows[0];
      if(!saved)throw new Error('Performance statement was not stored');return{id:saved.id,portfolio_id:input.portfolioId,created_at:saved.created_at,report:saved.result};
    });
  }

  async performanceStatements(scope:InvestScope,input:{portfolioId:string}):Promise<Array<{id:string;portfolio_id:string;created_at:string;report:PerformanceStatement}>> {
    return (await this.scoped.query<{id:string;portfolio_id:string;created_at:string;report:PerformanceStatement}>(scope,`SELECT id,portfolio_id,created_at::text,result AS report FROM invest_performance_reports
      WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 ORDER BY created_at DESC LIMIT 100`,[scope.tenantId,scope.workspaceId,input.portfolioId])).rows;
  }

  async createMandate(scope: InvestScope, actorId: string, input: MandateDraftInput): Promise<{id:string;version:number;status:'in_review'}> {
    const limits = GuardrailLimits.parse(input.limits);
    if (input.effectiveUntil && Date.parse(input.effectiveUntil) <= Date.parse(input.effectiveFrom)) throw new Error('Mandate expiry must follow its effective date');
    const memoId = uuidv7();
    const mandateDraft = { version: input.version, effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil,
      limits, allowedAssetClasses: input.allowedAssetClasses, allowedInstrumentIds: input.allowedInstrumentIds, benchmark: input.benchmark };
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const memo = await tx.query<{id:string;version:number;status:'in_review'}>(
        `INSERT INTO invest_ic_memos(id,tenant_id,workspace_id,portfolio_id,version,title,thesis,sources,risk_review,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'in_review',$10) RETURNING id,version,status`,
        [memoId, scope.tenantId, scope.workspaceId, input.portfolioId, input.version, input.title, input.thesis,
          JSON.stringify(input.sources), JSON.stringify({ mandateDraft }), actorId]);
      await tx.query(`INSERT INTO invest_ic_memo_events(id,tenant_id,workspace_id,memo_id,event_type,detail,actor_id)
        VALUES($1,$2,$3,$4,'drafted',$5::jsonb,$6)`, [uuidv7(), scope.tenantId, scope.workspaceId, memoId,
        JSON.stringify({ version: input.version, sourceCount: input.sources.length }), actorId]);
      return memo;
    });
    if (!result.rows[0]) throw new Error('IC memo insert failed'); return result.rows[0];
  }

  async icQueue(scope: InvestScope): Promise<Array<{id:string;portfolio_id:string;version:number;title:string;status:string;approvals:number;rejections:number;recusals:number;created_at:string}>> {
    return (await this.scoped.query<{id:string;portfolio_id:string;version:number;title:string;status:'draft'|'in_review'|'approved'|'rejected'|'expired';approvals:number;rejections:number;recusals:number;created_at:string}>(scope, `SELECT m.id,m.portfolio_id,m.version,m.title,m.status,m.created_at::text,
        count(*) FILTER (WHERE v.vote='approve')::int AS approvals,
        count(*) FILTER (WHERE v.vote='reject')::int AS rejections,
        count(*) FILTER (WHERE v.vote='recuse')::int AS recusals
      FROM invest_ic_memos m LEFT JOIN invest_ic_votes v ON v.tenant_id=m.tenant_id AND v.workspace_id=m.workspace_id AND v.memo_id=m.id
      WHERE m.tenant_id=$1 AND m.workspace_id=$2 GROUP BY m.id ORDER BY m.created_at DESC LIMIT 200`, [scope.tenantId, scope.workspaceId])).rows;
  }

  async voteMemo(scope: InvestScope, call: Call, input: {memoId:string;vote:'approve'|'reject'|'recuse';reason:string}): Promise<{memoId:string;vote:'approve'|'reject'|'recuse';approvals:number;rejections:number;recusals:number}> {
    const voterId = this.requireHumanOwner(scope, call);
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const memo = await tx.query<{id:string;status:string}>(`SELECT id,status FROM invest_ic_memos WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, input.memoId]);
      if (!memo.rows[0] || memo.rows[0].status !== 'in_review') throw new Error('IC memo is not accepting votes');
      await tx.query(`INSERT INTO invest_ic_votes(id,tenant_id,workspace_id,memo_id,voter_id,vote,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.memoId, voterId, input.vote, input.reason]);
      await tx.query(`INSERT INTO invest_ic_memo_events(id,tenant_id,workspace_id,memo_id,event_type,detail,actor_id) VALUES($1,$2,$3,$4,'vote_recorded',$5::jsonb,$6)`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.memoId, JSON.stringify({ voterId, vote: input.vote }), voterId]);
      const counts = await tx.query<{approvals:number;rejections:number;recusals:number}>(`SELECT count(*) FILTER(WHERE vote='approve')::int AS approvals,
        count(*) FILTER(WHERE vote='reject')::int AS rejections,count(*) FILTER(WHERE vote='recuse')::int AS recusals
        FROM invest_ic_votes WHERE tenant_id=$1 AND workspace_id=$2 AND memo_id=$3`, [scope.tenantId, scope.workspaceId, input.memoId]);
      const totals = counts.rows[0] ?? { approvals: 0, rejections: 0, recusals: 0 };
      if (totals.rejections >= 2) {
        await tx.query(`UPDATE invest_ic_memos SET status='rejected' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.memoId]);
        await tx.query(`INSERT INTO invest_ic_memo_events(id,tenant_id,workspace_id,memo_id,event_type,detail,actor_id) VALUES($1,$2,$3,$4,'rejected',$5::jsonb,$6)`,
          [uuidv7(), scope.tenantId, scope.workspaceId, input.memoId, JSON.stringify({ approvals: totals.approvals, rejections: totals.rejections }), voterId]);
      }
      return { memoId: input.memoId, vote: input.vote, ...totals };
    });
  }

  async activateMandate(scope: InvestScope, call: Call, input: {memoId:string}): Promise<{id:string;version:number;status:'approved';expiresAt:string}> {
    const approverId = this.requireHumanOwner(scope, call);
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const memo = await tx.query<{portfolio_id:string;version:number;title:string;created_by:string;risk_review:Record<string,unknown>;status:string}>(
        `SELECT portfolio_id,version,title,created_by,risk_review,status FROM invest_ic_memos WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
        [scope.tenantId, scope.workspaceId, input.memoId]);
      const row = memo.rows[0]; if (!row || row.status !== 'in_review') throw new Error('IC memo is not approvable');
      const votes = await tx.query<{approvals:number;rejections:number}>(`SELECT count(*) FILTER(WHERE vote='approve')::int AS approvals,
        count(*) FILTER(WHERE vote='reject')::int AS rejections FROM invest_ic_votes WHERE tenant_id=$1 AND workspace_id=$2 AND memo_id=$3`,
        [scope.tenantId, scope.workspaceId, input.memoId]);
      const total = votes.rows[0] ?? { approvals: 0, rejections: 0 };
      if (total.approvals < 2 || total.rejections > 0) throw new Error('Mandate requires two independent approvals and no rejection');
      const draft = row.risk_review['mandateDraft'] as MandateDraft;
      if (!draft) throw new Error('IC memo has no mandate draft');
      const previousMandate = await tx.query<{limits:Record<string,unknown>}>(`SELECT limits FROM invest_mandates
        WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND status='approved' AND effective_from<=now() AND effective_until>now()
        ORDER BY version DESC LIMIT 1 FOR UPDATE`, [scope.tenantId,scope.workspaceId,row.portfolio_id]);
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
      const effectiveUntil = draft.effectiveUntil ?? expiresAt;
      const mandate = await tx.query<{id:string;version:number}>(`INSERT INTO invest_mandates(id,tenant_id,workspace_id,portfolio_id,version,effective_from,effective_until,limits,status,approved_by,approved_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'approved',$9,now(),$10) RETURNING id,version`,
        [uuidv7(), scope.tenantId, scope.workspaceId, row.portfolio_id, row.version, draft.effectiveFrom, effectiveUntil,
          JSON.stringify({ ...draft.limits, allowedAssetClasses: draft.allowedAssetClasses, allowedInstrumentIds: draft.allowedInstrumentIds, benchmark: draft.benchmark }), approverId, approverId]);
      if (!mandate.rows[0]) throw new Error('Approved mandate insert failed');
      const proposedLimits = { ...draft.limits, allowedAssetClasses: draft.allowedAssetClasses, allowedInstrumentIds: draft.allowedInstrumentIds, benchmark: draft.benchmark };
      if (previousMandate.rows[0] && JSON.stringify(previousMandate.rows[0].limits) !== JSON.stringify(proposedLimits)) {
        await tx.query(`INSERT INTO invest_limit_changes(id,tenant_id,workspace_id,portfolio_id,mandate_id,previous_limits,proposed_limits,reason,approved_by,approved_at,created_by)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,now(),$10)`,
          [uuidv7(),scope.tenantId,scope.workspaceId,row.portfolio_id,mandate.rows[0].id,JSON.stringify(previousMandate.rows[0].limits),JSON.stringify(proposedLimits),
            `IC-approved mandate v${row.version}: ${row.title}`.slice(0,1000),approverId,row.created_by]);
      }
      await tx.query(`UPDATE invest_ic_memos SET status='approved',expires_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [scope.tenantId, scope.workspaceId, input.memoId, expiresAt]);
      await tx.query(`INSERT INTO invest_ic_memo_events(id,tenant_id,workspace_id,memo_id,event_type,detail,actor_id) VALUES($1,$2,$3,$4,'approved',$5::jsonb,$6)`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.memoId, JSON.stringify({ mandateId: mandate.rows[0].id, expiresAt, approvals: total.approvals }), approverId]);
      return { ...mandate.rows[0], status: 'approved' as const, expiresAt };
    });
  }

  async fundPortfolio(scope: InvestScope, actorId: string, input: { portfolioId: string; units: string; reference: string }): Promise<{transactionId:string;environment:'paper'}> {
    const portfolio = await this.scoped.query<{book_id:string;base_asset:string}>(scope,
      `SELECT book_id,base_asset FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='active'`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const row = portfolio.rows[0]; if (!row) throw new Error('Active portfolio not found');
    const accounts = await this.ledger.accounts(scope, row.book_id);
    const cash = accounts.find((account) => account.code === 'cash'); const capital = accounts.find((account) => account.code === 'capital');
    if (!cash || !capital) throw new Error('PAPER opening accounts are missing');
    const transactionId = uuidv7();
    await this.ledger.post(scope, actorId, { id: transactionId, bookId: row.book_id, environment: 'paper', effectiveDate: new Date().toISOString().slice(0,10),
      description: `PAPER opening funding: ${input.reference}`, source: 'invest', correlationId: uuidv7(), entries: [
        { accountId: cash.id, asset: row.base_asset, units: input.units, memo: 'PAPER simulated opening capital' },
        { accountId: capital.id, asset: row.base_asset, units: `-${input.units}`, memo: 'PAPER simulated opening capital' },
      ] });
    const navNow = (await this.summary(scope,{portfolioId:input.portfolioId})).navUnits;
    await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query(
      `INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
       SELECT $1,$2,$3,invest_utc_risk_date(),$4,$4,0,COALESCE((SELECT kill_switch FROM invest_latest_risk_halt($1,$2,$3)),false),
         (SELECT kill_reason FROM invest_latest_risk_halt($1,$2,$3)) FROM (SELECT 1) seed
       ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET day_open_nav_units=invest_portfolio_risk_state.day_open_nav_units+$5,high_water_nav_units=GREATEST(invest_portfolio_risk_state.high_water_nav_units,invest_portfolio_risk_state.day_open_nav_units+$5),updated_at=now()`,
      [scope.tenantId, scope.workspaceId, input.portfolioId, navNow, input.units]));
    return { transactionId, environment: 'paper' };
  }

  async setKillSwitch(scope: InvestScope, actorId: string, input: { portfolioId:string; engaged:boolean; reason:string }): Promise<{portfolioId:string;engaged:boolean;cancelledOrders:number}> {
    const openingNav = (await this.summary(scope,{portfolioId:input.portfolioId})).navUnits;
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const portfolio = await tx.query<{id:string}>(`SELECT id FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
      if (!portfolio.rows[0]) throw new Error('Portfolio not found');
      await tx.query(`INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
        VALUES($1,$2,$3,invest_utc_risk_date(),$4,$4,0,$5,$6) ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET kill_switch=EXCLUDED.kill_switch,kill_reason=EXCLUDED.kill_reason,updated_at=now()`,
        [scope.tenantId, scope.workspaceId, input.portfolioId, openingNav, input.engaged, input.engaged ? input.reason : null]);
      if (!input.engaged) return { portfolioId: input.portfolioId, engaged: false, cancelledOrders: 0 };
      const open = await tx.query<{id:string;status:string}>(`UPDATE invest_orders SET status='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND status IN ('proposed','approved','submitted','partially_filled') RETURNING id,status`,
        [scope.tenantId, scope.workspaceId, input.portfolioId]);
      for (const order of open.rows) await this.orderEvent(tx, scope, actorId, order.id, 'cancelled', order.status, 'cancelled', { reason: input.reason, killSwitch: true });
      return { portfolioId: input.portfolioId, engaged: true, cancelledOrders: open.rows.length };
    });
  }

  async createPortfolio(scope: InvestScope, actorId: string, input: { name: string; baseAsset: string }): Promise<PortfolioRow> {
    const id = uuidv7();
    const builtIn = BUILTIN_ASSETS.find((asset) => asset.code === input.baseAsset);
    if (builtIn) await this.ledger.ensureAssets(scope, actorId, [builtIn]);
    const book = await this.ledger.createBook(scope, actorId, { name: `${input.name} PAPER`, environment: 'paper', baseAsset: input.baseAsset,
      ownerModule: 'invest', purpose: 'portfolio', subjectId: id });
    await this.ledger.createAccount(scope, actorId, { bookId: book.id, code: 'cash', name: `${input.name} cash`, type: 'asset' });
    await this.ledger.createAccount(scope, actorId, { bookId: book.id, code: 'cash-clearing', name: `${input.name} settlement clearing`, type: 'asset' });
    await this.ledger.createAccount(scope, actorId, { bookId: book.id, code: 'capital', name: `${input.name} simulated capital`, type: 'equity' });
    const inserted = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query<PortfolioRow>(
      `INSERT INTO invest_portfolios(id,tenant_id,workspace_id,name,book_id,environment,base_asset,created_by)
       VALUES($1,$2,$3,$4,$5,'paper',$6,$7) RETURNING id,name,base_asset,book_id,environment,status`,
      [id, scope.tenantId, scope.workspaceId, input.name, book.id, input.baseAsset, actorId]));
    if (!inserted.rows[0]) throw new Error('Portfolio insert failed');
    await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query(
      `INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units)
       VALUES($1,$2,$3,invest_utc_risk_date(),0,0,0)`, [scope.tenantId, scope.workspaceId, id]));
    return inserted.rows[0];
  }

  async createInstrument(scope: InvestScope, actorId: string, input: { symbol: string; assetClass: 'equity'|'crypto'|'fixed_income'|'fund'; quantityScale: number; exchangeCode: string|null }): Promise<{ id: string; symbol: string }> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9.:-]{1,32}$/.test(symbol)) throw new Error('Invalid instrument symbol');
    const id = uuidv7(); const code = `EQ:${symbol}`;
    const asset: Asset = { code, scale: input.quantityScale, kind: 'security', name: `${symbol} units` };
    await this.ledger.ensureAssets(scope, actorId, [asset]);
    const books = await this.ledger.books(scope, { environment: 'paper', ownerModule: 'invest' });
    for (const book of books) {
      await this.ledger.createAccount(scope, actorId, { bookId: book.id, code: `position:${id}`, name: `${symbol} position`, type: 'asset' });
      await this.ledger.createAccount(scope, actorId, { bookId: book.id, code: `position-clearing:${id}`, name: `${symbol} position clearing`, type: 'equity' });
    }
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query<{id:string;symbol:string}>(
      `INSERT INTO invest_instruments(id,tenant_id,workspace_id,asset_code,symbol,asset_class,quantity_scale,exchange_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,symbol`,
      [id, scope.tenantId, scope.workspaceId, code, symbol, input.assetClass, input.quantityScale, input.exchangeCode]));
    if (!result.rows[0]) throw new Error('Instrument insert failed'); return result.rows[0];
  }

  async propose(scope: InvestScope, actorId: string, input: { portfolioId: string; instrumentId: string; side: 'buy'|'sell'; orderType: 'market'|'limit'; limitPriceUnits?: string; stopPriceUnits: string; riskBps: number; idempotencyKey: string }): Promise<OrderRow> {
    await this.assertGlobalTradingEnabled(scope);
    const duplicate = await this.scoped.query<OrderRow>(scope,
      `SELECT o.id,o.portfolio_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text
       FROM invest_orders o JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
       WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.idempotency_key=$3`, [scope.tenantId, scope.workspaceId, input.idempotencyKey]);
    if (duplicate.rows[0]) return duplicate.rows[0];
    const data = await this.scoped.query<Record<string, unknown>>(scope,
      `SELECT p.book_id,p.base_asset,p.status AS portfolio_status,i.symbol,i.asset_code,i.asset_class,i.quantity_scale,i.exchange_code,m.id AS mandate_id,m.limits,q.id AS quote_id,q.price_units::text,q.source_at,q.received_at,q.volatility_bps,r.kind AS rule_kind
       FROM invest_portfolios p JOIN invest_instruments i ON i.tenant_id=p.tenant_id AND i.workspace_id=p.workspace_id
       JOIN LATERAL (SELECT * FROM invest_mandates WHERE tenant_id=p.tenant_id AND workspace_id=p.workspace_id AND portfolio_id=p.id
          AND status='approved' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) ORDER BY version DESC LIMIT 1) m ON true
       JOIN LATERAL (SELECT * FROM invest_market_prices WHERE tenant_id=i.tenant_id AND workspace_id=i.workspace_id AND instrument_id=i.id ORDER BY received_at DESC LIMIT 1) q ON true
       LEFT JOIN LATERAL (SELECT kind FROM invest_restricted_rules WHERE tenant_id=i.tenant_id AND workspace_id=i.workspace_id AND instrument_id=i.id AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) ORDER BY version DESC LIMIT 1) r ON true
       WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND i.id=$4 AND p.status='active' AND i.active=true`,
      [scope.tenantId, scope.workspaceId, input.portfolioId, input.instrumentId]);
    const row = data.rows[0]; if (!row) throw new Error('No active portfolio, instrument, approved mandate, or quote');
    if (row['rule_kind'] === 'restricted') throw new Error('Instrument is restricted');
    const mandateLimits = GuardrailLimits.parse(row['limits']);
    const limitRecord = row['limits'] as Record<string, unknown>;
    const allowedClasses = limitRecord['allowedAssetClasses'];
    const allowedInstruments = limitRecord['allowedInstrumentIds'];
    if (!Array.isArray(allowedClasses) || !allowedClasses.includes(row['asset_class'])) throw new Error('Instrument asset class is outside the active mandate');
    if (!Array.isArray(allowedInstruments) || !allowedInstruments.includes(input.instrumentId)) throw new Error('Instrument is not explicitly allowed by the active mandate');
    if (Date.now() - new Date(row['received_at'] as string | Date).getTime() > mandateLimits.quoteFreshnessSeconds * 1000) throw new Error('Market quote is stale');
    const bookId = String(row['book_id']);
    const accounts = await this.ledger.accounts(scope, bookId);
    const balances = await this.ledger.balances(scope, { environment: 'paper', bookId });
    const accountCodeById = new Map(accounts.map((account) => [account.id, account.code]));
    const cash = BigInt(balances.find((balance) => accountCodeById.get(balance.accountId) === 'cash' && balance.asset === row['base_asset'] )?.units ?? '0');
    const instruments = (await this.scoped.query<{id:string;symbol:string;quantity_scale:number;asset_code:string}>(scope,
      `SELECT id,symbol,quantity_scale,asset_code FROM invest_instruments WHERE tenant_id=$1 AND workspace_id=$2 AND active=true`, [scope.tenantId, scope.workspaceId])).rows;
    const positionRows: Array<{ instrumentId: string; symbol: string; quantityUnits: string; marketValueUnits: string; sector: string|null }> = [];
    for (const item of instruments) {
      const accountCode = `position:${item.id}`;
      const balance = balances.find((candidate) => accountCodeById.get(candidate.accountId) === accountCode && candidate.asset === item.asset_code);
      if (!balance || BigInt(balance.units) <= 0n) continue;
      const quoteRow = item.id === input.instrumentId ? row : (await this.scoped.query<Record<string, unknown>>(scope,
        `SELECT price_units::text,received_at,source_at,volatility_bps FROM invest_market_prices WHERE tenant_id=$1 AND workspace_id=$2 AND instrument_id=$3 ORDER BY received_at DESC LIMIT 1`, [scope.tenantId, scope.workspaceId, item.id])).rows[0];
      if (!quoteRow) continue;
      positionRows.push({ instrumentId: item.id, symbol: item.symbol, quantityUnits: balance.units,
        marketValueUnits: notionalUnits(balance.units, String(quoteRow['price_units']), item.quantity_scale).toString(), sector: null });
    }
    const quote = RiskQuote.parse({ priceUnits: String(row['price_units']), sourceAt: new Date(row['source_at'] as string).toISOString(),
      receivedAt: new Date(row['received_at'] as string).toISOString(), volatilityBps: Number(row['volatility_bps']) });
    const now = new Date().toISOString();
    const positionValue = positionRows.reduce((sum, position) => sum + BigInt(position.marketValueUnits), 0n);
    const nav = cash + positionValue;
    if (nav <= 0n) throw new Error('Portfolio must have positive PAPER cash or holdings');
    const limits = mandateLimits;
    const stop = String(input.stopPriceUnits); const entry = String(input.limitPriceUnits ?? quote.priceUnits);
    const quantity = input.side === 'buy'
      ? sizeForStopRisk({ navUnits: nav.toString(), maxRiskBps: input.riskBps, entryPriceUnits: entry, stopPriceUnits: stop, quantityScale: Number(row['quantity_scale']) })
      : positionRows.find((p) => p.instrumentId === input.instrumentId)?.quantityUnits ?? '0';
    if (BigInt(quantity) <= 0n) throw new Error('Computed order size is zero');
    const recent = await this.scoped.query<{instrument_id:string;created_at:string}>(scope,
      `SELECT instrument_id,created_at::text FROM invest_orders WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND created_at>=now()-interval '1 hour' AND status NOT IN ('rejected','cancelled','expired') ORDER BY created_at DESC LIMIT 1000`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const sessionOpen = String(row['asset_class']) === 'crypto' || await this.isMarketOpen(scope, String(row['exchange_code'] ?? ''), now);
    const currentRisk = await this.scoped.query<{day_open_nav_units:string;high_water_nav_units:string;daily_loss_units:string;kill_switch:boolean}>(scope,
      `SELECT day_open_nav_units::text,high_water_nav_units::text,daily_loss_units::text,kill_switch FROM invest_portfolio_risk_state
       WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date()`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const currentState = currentRisk.rows[0];
    const lastHalt = currentState ? undefined : (await this.scoped.query<{kill_switch:boolean;kill_reason:string|null}>(scope,
      `SELECT kill_switch,kill_reason FROM invest_latest_risk_halt($1,$2,$3)`,[scope.tenantId,scope.workspaceId,input.portfolioId])).rows[0];
    const state = currentState ?? (lastHalt?.kill_switch ? { day_open_nav_units:nav.toString(),high_water_nav_units:nav.toString(),daily_loss_units:'0',kill_switch:true,kill_reason:lastHalt.kill_reason } : undefined);
    if (state?.kill_switch) throw new Error('PAPER trading kill switch is engaged');
    const drawdownLoss = state && BigInt(state.high_water_nav_units) > nav ? BigInt(state.high_water_nav_units) - nav : 0n;
    const dailyLoss = state ? (BigInt(state.daily_loss_units) > drawdownLoss ? BigInt(state.daily_loss_units) : drawdownLoss) : 0n;
    const snapshot = RiskSnapshot.parse({ now, marketOpen: sessionOpen, navUnits: nav.toString(), cashUnits: cash.toString(), dailyLossUnits: dailyLoss.toString(), highWaterNavUnits: state?.high_water_nav_units ?? nav.toString(),
      grossExposureUnits: positionValue.toString(), ordersInHour: recent.rows.length, positions: positionRows,
      recentInstrumentOrders: recent.rows.map((order) => ({ instrumentId: order.instrument_id, createdAt: new Date(order.created_at).toISOString() })), correlations: [] });
    const orderId = uuidv7();
    const correlations = Array.isArray(limitRecord['correlations']) ? limitRecord['correlations'] as Array<{instrumentId:string;correlationBps:number}> : [];
    const riskSnapshot = RiskSnapshot.parse({ ...snapshot, correlations });
    const checked = checkInvestOrder({ id: orderId, portfolioId: input.portfolioId, instrumentId: input.instrumentId, symbol: String(row['symbol']),
      assetClass: row['asset_class'] as 'equity'|'crypto'|'fixed_income'|'fund', side: input.side, orderType: input.orderType, quantityUnits: quantity,
      ...(input.limitPriceUnits ? { limitPriceUnits: input.limitPriceUnits } : {}), environment: 'paper' }, quote, riskSnapshot, limits,
      { quantityScale: Number(row['quantity_scale']), restricted: row['rule_kind'] === 'restricted' });
    const mandate = row['mandate_id']; const riskId = uuidv7();
    const verdict = checked.watchlisted ? { ...checked, allowed: false, reasons: [...checked.reasons, 'watch-listed orders require a separate authorized compliance approval'] } : checked;
    await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query(
      `INSERT INTO invest_risk_decisions(id,tenant_id,workspace_id,portfolio_id,instrument_id,mandate_id,order_id,allowed,reasons,quote_id,snapshot,evaluated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12)`, [riskId, scope.tenantId, scope.workspaceId, input.portfolioId, input.instrumentId, mandate, orderId,
      verdict.allowed, JSON.stringify(verdict.reasons), row['quote_id'], JSON.stringify(riskSnapshot), actorId]));
    if (!verdict.allowed) throw new Error(`Risk rejected: ${verdict.reasons.join('; ')}`);
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      await tx.query(`INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
        SELECT $1,$2,$3,invest_utc_risk_date(),$4,$4,0,COALESCE((SELECT kill_switch FROM invest_latest_risk_halt($1,$2,$3)),false),
          (SELECT kill_reason FROM invest_latest_risk_halt($1,$2,$3)) FROM (SELECT 1) seed
        ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO NOTHING`, [scope.tenantId,scope.workspaceId,input.portfolioId,nav.toString()]);
      const stateCheck = await tx.query<{kill_switch:boolean}>(`SELECT kill_switch FROM invest_portfolio_risk_state WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date() FOR UPDATE`,
        [scope.tenantId, scope.workspaceId, input.portfolioId]);
      if (stateCheck.rows[0]?.kill_switch) throw new Error('PAPER trading kill switch is engaged');
      const inserted = await tx.query<OrderRow>(`INSERT INTO invest_orders(id,tenant_id,workspace_id,portfolio_id,instrument_id,mandate_id,risk_decision_id,environment,side,order_type,quantity_units,limit_price_units,status,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,'paper',$8,$9,$10,$11,'proposed',$12,$13)
        RETURNING id,portfolio_id,instrument_id,(SELECT symbol FROM invest_instruments WHERE id=$5)::text AS symbol,side,order_type,quantity_units::text,limit_price_units::text,status,environment,created_at::text`,
        [orderId, scope.tenantId, scope.workspaceId, input.portfolioId, input.instrumentId, mandate, riskId, input.side, input.orderType, quantity, input.limitPriceUnits ?? null, input.idempotencyKey, actorId]);
      await this.orderEvent(tx, scope, actorId, orderId, 'proposed', null, 'proposed', { riskDecisionId: riskId });
      if (!inserted.rows[0]) throw new Error('Order insert failed'); return inserted.rows[0];
    });
  }

  async approve(scope: InvestScope, actorId: string, input: { orderId: string }): Promise<OrderRow> {
    return this.transition(scope, actorId, input.orderId, 'approved', { approvedBy: actorId });
  }
  async cancel(scope: InvestScope, actorId: string, input: { orderId: string }): Promise<OrderRow> {
    return this.transition(scope, actorId, input.orderId, 'cancelled', {});
  }
  private async transition(scope: InvestScope, actorId: string, orderId: string, target: 'approved'|'cancelled', detail: object): Promise<OrderRow> {
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const prior = await tx.query<OrderRow>(`SELECT o.id,o.portfolio_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text,
          COALESCE((SELECT sum(f.quantity_units) FROM invest_fills f WHERE f.tenant_id=o.tenant_id AND f.workspace_id=o.workspace_id AND f.order_id=o.id),0)::text AS filled_units
        FROM invest_orders o JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
        WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, orderId]);
      const old = prior.rows[0]; if (!old) throw new Error('Order not found');
      if (target === 'cancelled' && old.status === 'cancelled') return old;
      if (target === 'approved' && old.status !== 'proposed') throw new Error('Only proposed orders may be approved');
      if (target === 'cancelled' && !['proposed','approved','submitted','partially_filled'].includes(old.status)) throw new Error('Order cannot be cancelled in its current state');
      const updated = await tx.query<OrderRow>(`UPDATE invest_orders SET status=$1 WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4
        RETURNING id,portfolio_id,instrument_id,(SELECT symbol FROM invest_instruments WHERE id=invest_orders.instrument_id)::text AS symbol,side,order_type,quantity_units::text,limit_price_units::text,status,environment,created_at::text,
          COALESCE((SELECT sum(f.quantity_units) FROM invest_fills f WHERE f.tenant_id=invest_orders.tenant_id AND f.workspace_id=invest_orders.workspace_id AND f.order_id=invest_orders.id),0)::text AS filled_units`,
        [target, scope.tenantId, scope.workspaceId, orderId]);
      await this.orderEvent(tx, scope, actorId, orderId, target, old.status, target, detail);
      if (!updated.rows[0]) throw new Error('Order update failed'); return updated.rows[0];
    });
  }

  async execute(scope: InvestScope, actorId: string, input: { orderId: string; quantityUnits?: string }): Promise<{ order: OrderRow; fillId: string; transactionId: string; environment: 'paper' }> {
    await this.assertGlobalTradingEnabled(scope);
    return this.paperLedger.withPaperTradeTransaction(scope, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT o.id,o.portfolio_id,o.instrument_id,o.mandate_id,o.risk_decision_id,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text,
           COALESCE((SELECT sum(f.quantity_units) FROM invest_fills f WHERE f.tenant_id=o.tenant_id AND f.workspace_id=o.workspace_id AND f.order_id=o.id),0)::text AS filled_units,
           p.book_id,p.base_asset,i.symbol,i.asset_code,i.quantity_scale,i.exchange_code,q.price_units::text,q.id AS quote_id,q.received_at,
           accepted_quote.price_units::text AS accepted_price_units,m.limits AS mandate_limits
         FROM invest_orders o JOIN invest_portfolios p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id AND p.id=o.portfolio_id
         JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
         JOIN invest_mandates m ON m.tenant_id=o.tenant_id AND m.workspace_id=o.workspace_id AND m.id=o.mandate_id
         JOIN invest_risk_decisions rd ON rd.tenant_id=o.tenant_id AND rd.workspace_id=o.workspace_id AND rd.id=o.risk_decision_id
         JOIN invest_market_prices accepted_quote ON accepted_quote.tenant_id=rd.tenant_id AND accepted_quote.workspace_id=rd.workspace_id AND accepted_quote.id=rd.quote_id
         JOIN LATERAL (SELECT id,price_units,received_at FROM invest_market_prices WHERE tenant_id=o.tenant_id AND workspace_id=o.workspace_id AND instrument_id=o.instrument_id ORDER BY received_at DESC LIMIT 1) q ON true
         WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3 FOR UPDATE OF o`, [scope.tenantId, scope.workspaceId, input.orderId]);
      const row = result.rows[0]; if (!row || !['approved','partially_filled'].includes(String(row['status'])) || row['environment'] !== 'paper') throw new Error('Only approved or partially filled PAPER orders can execute');
      const halt = await tx.query<{kill_switch:boolean}>(`SELECT kill_switch FROM invest_latest_risk_halt($1,$2,$3)`, [scope.tenantId,scope.workspaceId,row['portfolio_id']]);
      if (halt.rows[0]?.kill_switch) throw new Error('PAPER trading kill switch is engaged');
      const quote = BigInt(String(row['price_units']));
      const originalQuantity = BigInt(String(row['quantity_units']));
      const filledQuantity = BigInt(String(row['filled_units']));
      const remainingQuantity = originalQuantity - filledQuantity;
      if (remainingQuantity <= 0n) throw new Error('PAPER order has no remaining quantity');
      const quantity = input.quantityUnits ?? remainingQuantity.toString();
      const fillQuantity = BigInt(quantity);
      if (fillQuantity <= 0n || fillQuantity > remainingQuantity) throw new Error('PAPER fill quantity exceeds remaining order quantity');
      const finalFill = fillQuantity === remainingQuantity;
      const mandateLimits = GuardrailLimits.parse(row['mandate_limits']);
      if (Date.now() - new Date(row['received_at'] as string | Date).getTime() > mandateLimits.quoteFreshnessSeconds * 1000) throw new Error('Latest PAPER market quote is stale');
      const acceptedPrice = BigInt(String(row['accepted_price_units']));
      const deviation = quote > acceptedPrice ? quote - acceptedPrice : acceptedPrice - quote;
      if (deviation * 10_000n > acceptedPrice * BigInt(mandateLimits.maxPriceDeviationBps)) throw new Error('Execution quote is outside the mandate price-sanity band');
      if (row['order_type'] === 'limit') {
        const limit = BigInt(String(row['limit_price_units']));
        if ((row['side'] === 'buy' && quote > limit) || (row['side'] === 'sell' && quote < limit)) throw new Error('Stored PAPER market quote does not cross the order limit');
      }
      const notional = notionalUnits(quantity, quote.toString(), Number(row['quantity_scale']));
      if (notional > BigInt(mandateLimits.maxOrderNotionalUnits)) throw new Error('Execution notional exceeds the active mandate order cap');
      const accounts = await tx.query<{id:string;code:string;type:string}>(`SELECT id,code,type FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$3 AND deleted_hlc IS NULL`, [scope.tenantId, scope.workspaceId, row['book_id']]);
      const cash = accounts.rows.find((account) => account.code === 'cash');
      const cashClearing = accounts.rows.find((account) => account.code === 'cash-clearing');
      const position = accounts.rows.find((account) => account.code === `position:${row['instrument_id']}`);
      const positionClearing = accounts.rows.find((account) => account.code === `position-clearing:${row['instrument_id']}`);
      if (!cash || !cashClearing || !position || !positionClearing) throw new Error('Required PAPER settlement accounts are missing');
      const balances = await tx.query<{account_id:string;units:string}>(`SELECT account_id,units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$3 AND asset IN ($4,$5) FOR UPDATE`,
        [scope.tenantId, scope.workspaceId, row['book_id'], row['base_asset'], row['asset_code']]);
      const cashUnits = BigInt(balances.rows.find((balance) => balance.account_id === cash.id)?.units ?? '0');
      const positionUnits = BigInt(balances.rows.find((balance) => balance.account_id === position.id)?.units ?? '0');
      const buy = row['side'] === 'buy';
      if (buy && cashUnits < notional) throw new Error('PAPER cash balance changed; order needs a new risk evaluation');
      if (!buy && positionUnits < BigInt(quantity)) throw new Error('PAPER position changed; sell order exceeds available ledger units');
      const signedQty = buy ? quantity : `-${quantity}`; const otherQty = buy ? `-${quantity}` : quantity;
      const signedCash = buy ? `-${notional}` : notional.toString(); const otherCash = buy ? notional.toString() : `-${notional}`;
      const fillId = uuidv7(); const transactionId = uuidv7();
      const post = await tx.post(actorId, { id: transactionId, bookId: String(row['book_id']), environment: 'paper',
        effectiveDate: new Date().toISOString().slice(0,10), description: `PAPER fill ${fillId}`, source: 'invest', correlationId: String(row['id']),
        entries: [
          { accountId: position.id, asset: String(row['asset_code']), units: signedQty, memo: 'PAPER position fill' },
          { accountId: positionClearing.id, asset: String(row['asset_code']), units: otherQty, memo: 'PAPER position clearing' },
          { accountId: cash.id, asset: String(row['base_asset']), units: signedCash, memo: 'PAPER cash settlement' },
          { accountId: cashClearing.id, asset: String(row['base_asset']), units: otherCash, memo: 'PAPER cash clearing' },
        ] });
      await tx.query(`INSERT INTO invest_fills(id,tenant_id,workspace_id,order_id,quantity_units,price_units,execution_ref,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [fillId, scope.tenantId, scope.workspaceId, input.orderId, quantity, quote.toString(), `paper:${transactionId}`]);
      if (buy) {
        const lotId = uuidv7();
        await tx.query(`INSERT INTO invest_tax_lots(id,tenant_id,workspace_id,portfolio_id,instrument_id,opening_fill_id,acquired_units,remaining_units,cost_basis_units,remaining_basis_units,opened_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,now())`, [lotId, scope.tenantId, scope.workspaceId, row['portfolio_id'], row['instrument_id'], fillId, quantity, notional.toString()]);
        await tx.query(`INSERT INTO invest_tax_lot_events(id,tenant_id,workspace_id,lot_id,fill_id,event_type,quantity_units,basis_units,proceeds_units,realized_gain_units)
          VALUES($1,$2,$3,$4,$5,'acquired',$6,$7,0,0)`, [uuidv7(), scope.tenantId, scope.workspaceId, lotId, fillId, quantity, notional.toString()]);
      } else {
        const lots = await tx.query<{id:string;remaining_units:string;remaining_basis_units:string}>(`SELECT id,remaining_units::text,remaining_basis_units::text FROM invest_tax_lots
          WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND instrument_id=$4 AND remaining_units>0 ORDER BY opened_at,id FOR UPDATE`,
          [scope.tenantId, scope.workspaceId, row['portfolio_id'], row['instrument_id']]);
        const allocations = allocateFifoTaxLots(lots.rows.map((lot)=>({id:lot.id,remainingUnits:lot.remaining_units,remainingBasisUnits:lot.remaining_basis_units})), quantity, quote.toString(), Number(row['quantity_scale']));
        for (const allocation of allocations) {
          await tx.query(`UPDATE invest_tax_lots SET remaining_units=$4,remaining_basis_units=$5,closed_at=CASE WHEN $4::numeric=0 THEN now() ELSE NULL END
            WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, allocation.lotId, allocation.remainingUnits, allocation.remainingBasisUnits]);
          await tx.query(`INSERT INTO invest_tax_lot_events(id,tenant_id,workspace_id,lot_id,fill_id,event_type,quantity_units,basis_units,proceeds_units,realized_gain_units)
            VALUES($1,$2,$3,$4,$5,'disposed',$6,$7,$8,$9)`, [uuidv7(), scope.tenantId, scope.workspaceId, allocation.lotId, fillId, allocation.consumedUnits, allocation.basisUnits, allocation.proceedsUnits, allocation.realizedGainUnits]);
        }
      }
      const previousStatus = String(row['status']);
      if (previousStatus === 'approved') {
        await tx.query(`UPDATE invest_orders SET status='submitted' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.orderId]);
        await this.orderEvent(tx, scope, actorId, input.orderId, 'submitted', 'approved', 'submitted', { environment: 'paper' });
      }
      const nextStatus = finalFill ? 'filled' : 'partially_filled';
      await tx.query(`UPDATE invest_orders SET status=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.orderId, nextStatus]);
      await this.orderEvent(tx, scope, actorId, input.orderId, finalFill ? 'filled' : 'partial_fill', previousStatus === 'approved' ? 'submitted' : previousStatus, nextStatus,
        { fillId, transactionId, quantityUnits: quantity, remainingUnits: (remainingQuantity-fillQuantity).toString(), environment: 'paper' });

      const held = await tx.query<{instrument_id:string;quantity_units:string;quantity_scale:number;price_units:string|null}>(
        `SELECT i.id AS instrument_id,COALESCE(b.units,0)::text AS quantity_units,i.quantity_scale,q.price_units::text
         FROM invest_instruments i
         JOIN ledger_accounts a ON a.tenant_id=i.tenant_id AND a.workspace_id=i.workspace_id AND a.book_id=$3 AND a.code='position:'||i.id::text
         LEFT JOIN ledger_balances b ON b.tenant_id=a.tenant_id AND b.workspace_id=a.workspace_id AND b.book_id=a.book_id AND b.account_id=a.id AND b.asset=i.asset_code
         LEFT JOIN LATERAL (SELECT price_units FROM invest_market_prices WHERE tenant_id=i.tenant_id AND workspace_id=i.workspace_id AND instrument_id=i.id ORDER BY received_at DESC LIMIT 1) q ON true
         WHERE i.tenant_id=$1 AND i.workspace_id=$2`, [scope.tenantId, scope.workspaceId, row['book_id']]);
      let grossExposure = 0n; let currentPositionValue = 0n;
      for (const holding of held.rows) {
        const units = BigInt(holding.quantity_units);
        if (units < 0n) throw new Error('Negative PAPER ledger position detected');
        if (units === 0n) continue;
        if (!holding.price_units) throw new Error(`Post-trade monitor cannot value held instrument ${holding.instrument_id}`);
        const value = notionalUnits(units.toString(), holding.price_units, holding.quantity_scale);
        grossExposure += value;
        if (holding.instrument_id === String(row['instrument_id'])) currentPositionValue = value;
      }
      const postCash = cashUnits + BigInt(signedCash);
      const navAfter = postCash + grossExposure;
      const riskState = await tx.query<{day_open_nav_units:string;high_water_nav_units:string;daily_loss_units:string;kill_switch:boolean}>(
        `SELECT day_open_nav_units::text,high_water_nav_units::text,daily_loss_units::text,kill_switch FROM invest_portfolio_risk_state
         WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date() FOR UPDATE`,
        [scope.tenantId, scope.workspaceId, row['portfolio_id']]);
      const previous = riskState.rows[0];
      const dayOpen = BigInt(previous?.day_open_nav_units ?? navAfter.toString());
      const dailyLoss = [BigInt(previous?.daily_loss_units ?? '0'), dayOpen > navAfter ? dayOpen - navAfter : 0n].reduce((a,b) => a > b ? a : b);
      const autoHalt = dailyLoss >= BigInt(mandateLimits.maxDailyLossUnits);
      await tx.query(`INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
        VALUES($1,$2,$3,invest_utc_risk_date(),$4,$5,$6,$7,CASE WHEN $7 THEN 'Automatic PAPER halt: daily-loss mandate exceeded' ELSE NULL END)
        ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET high_water_nav_units=GREATEST(invest_portfolio_risk_state.high_water_nav_units,EXCLUDED.high_water_nav_units),
          daily_loss_units=EXCLUDED.daily_loss_units,kill_switch=invest_portfolio_risk_state.kill_switch OR EXCLUDED.kill_switch,
          kill_reason=CASE WHEN EXCLUDED.kill_switch THEN EXCLUDED.kill_reason ELSE invest_portfolio_risk_state.kill_reason END,updated_at=now()`,
        [scope.tenantId, scope.workspaceId, row['portfolio_id'], previous?.day_open_nav_units ?? navAfter.toString(), navAfter.toString(), dailyLoss.toString(), autoHalt]);
      const breaches: Array<{kind:string;detail:Record<string,string>}> = [];
      if (currentPositionValue > BigInt(mandateLimits.maxPositionNotionalUnits)) breaches.push({ kind: 'max_position_notional', detail: { value: currentPositionValue.toString(), limit: mandateLimits.maxPositionNotionalUnits } });
      if (navAfter > 0n && currentPositionValue * 10_000n > navAfter * BigInt(mandateLimits.maxConcentrationBps)) breaches.push({ kind: 'position_concentration', detail: { value: currentPositionValue.toString(), nav: navAfter.toString(), limitBps: String(mandateLimits.maxConcentrationBps) } });
      if (navAfter > 0n && grossExposure * 10_000n > navAfter * BigInt(mandateLimits.maxLeverageBps)) breaches.push({ kind: 'gross_leverage', detail: { exposure: grossExposure.toString(), nav: navAfter.toString(), limitBps: String(mandateLimits.maxLeverageBps) } });
      if (dailyLoss > 0n) breaches.push({ kind: 'daily_loss', detail: { lossUnits: dailyLoss.toString(), limitUnits: mandateLimits.maxDailyLossUnits } });
      for (const breach of breaches) await this.createBreach(tx, scope, actorId, String(row['portfolio_id']), String(row['instrument_id']),
        autoHalt ? 'critical' : 'high', breach.kind, { ...breach.detail, sourceOrderId: input.orderId });
      if (autoHalt) {
        const cancelled = await tx.query<{id:string;status:string}>(`UPDATE invest_orders SET status='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND id<>$4 AND status IN ('proposed','approved','submitted','partially_filled') RETURNING id,status`,
          [scope.tenantId, scope.workspaceId, row['portfolio_id'], input.orderId]);
        for (const order of cancelled.rows) await this.orderEvent(tx, scope, actorId, order.id, 'cancelled', order.status, 'cancelled', { reason: 'Automatic PAPER daily-loss halt' });
      }
      const order: OrderRow = { id: String(row['id']), portfolio_id: String(row['portfolio_id']), instrument_id: String(row['instrument_id']),
        symbol: String(row['symbol']), side: row['side'] as 'buy'|'sell', order_type: row['order_type'] as 'market'|'limit', quantity_units: String(row['quantity_units']),
        filled_units: (filledQuantity+fillQuantity).toString(),
        limit_price_units: row['limit_price_units'] == null ? null : String(row['limit_price_units']), status: nextStatus, environment: 'paper', created_at: String(row['created_at']) };
      return { order, fillId, transactionId: post.transactionId, environment: 'paper' };
    });
  }

  private async isMarketOpen(scope: InvestScope, exchangeCode: string, now: string): Promise<boolean> {
    if (!exchangeCode) return false;
    const result = await this.scoped.query<{is_open:boolean}>(scope, `SELECT is_open FROM invest_market_sessions
      WHERE tenant_id=$1 AND workspace_id=$2 AND exchange_code=$3 AND session_date=($4::timestamptz AT TIME ZONE 'UTC')::date
        AND opens_at<=$4 AND closes_at>$4 ORDER BY received_at DESC LIMIT 1`, [scope.tenantId, scope.workspaceId, exchangeCode, now]);
    return result.rows[0]?.is_open === true;
  }

  private async orderEvent(tx: QueryTx, scope: InvestScope, actorId: string, orderId: string, event: string, from: string|null, to: string, detail: object): Promise<void> {
    await tx.query(`INSERT INTO invest_order_events(id,tenant_id,workspace_id,order_id,event_type,from_status,to_status,detail,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [uuidv7(), scope.tenantId, scope.workspaceId, orderId, event, from, to, JSON.stringify(detail), actorId]);
  }
}
