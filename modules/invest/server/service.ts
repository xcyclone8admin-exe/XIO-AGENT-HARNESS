import { HybridClock, uuidv7 } from '@xyra/core';
import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import type { LocalScopedStore, Scope, ScopedTransaction } from '@xyra/db';
import type { Asset, LedgerApi, LedgerScope, PaperTradeLedgerApi } from '@xyra/ledger/contracts';
import { BUILTIN_ASSETS } from '@xyra/ledger/contracts';
import { GuardrailLimits, RiskQuote, RiskSnapshot, checkInvestOrder, notionalUnits, sizeForStopRisk } from './risk';
import { investCapabilities } from './capabilities';
import manifest from '../manifest';

type Call = { readonly principal: Principal; readonly workspaceId: string };
type Registrar = { register(manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call: Call) => Promise<unknown>): void };
type QueryTx = Pick<ScopedTransaction, 'query'>;
type OrderRow = {
  id: string; portfolio_id: string; instrument_id: string; symbol: string; side: 'buy'|'sell'; order_type: 'market'|'limit';
  quantity_units: string; limit_price_units: string|null; status: 'proposed'|'approved'|'submitted'|'partially_filled'|'filled'|'cancelled'|'expired';
  environment: 'paper'; created_at: string;
};
type PortfolioRow = { id: string; name: string; base_asset: string; book_id: string; environment: 'paper'; status: 'active'|'paused'|'closed' };
type InvestScope = Scope & LedgerScope;

/** Trusted local PAPER service. Scope and actor always come from the authenticated sidecar call. */
export class InvestService {
  private readonly clock = new HybridClock('invest');
  constructor(
    private readonly scoped: LocalScopedStore,
    private readonly ledger: LedgerApi,
    private readonly paperLedger: PaperTradeLedgerApi,
  ) {}

  register(bus: Registrar, moduleManifest: ModuleManifest = manifest): void {
    const reg = (descriptor: AnyCapability, handler: (input: unknown, call: Call) => Promise<unknown>) => bus.register(moduleManifest, descriptor, handler);
    reg(investCapabilities.portfolios, (_input, call) => this.portfolios(this.scope(call)));
    reg(investCapabilities.summary, (input, call) => this.summary(this.scope(call), input as { portfolioId: string }));
    reg(investCapabilities.instruments, (_input, call) => this.instruments(this.scope(call)));
    reg(investCapabilities.orders, (input, call) => this.orders(this.scope(call), input as { portfolioId?: string }));
    reg(investCapabilities.createPortfolio, (input, call) => this.createPortfolio(this.scope(call), this.actor(call), input as { name: string; baseAsset: string }));
    reg(investCapabilities.fundPortfolio, (input, call) => this.fundPortfolio(this.scope(call), this.actor(call), input as { portfolioId: string; units: string; reference: string }));
    reg(investCapabilities.createInstrument, (input, call) => this.createInstrument(this.scope(call), this.actor(call), input as { symbol: string; assetClass: 'equity'|'crypto'|'fixed_income'|'fund'; quantityScale: number; exchangeCode: string|null }));
    reg(investCapabilities.recordPrice, (input, call) => this.recordPrice(this.scope(call), input as { instrumentId: string; priceUnits: string; source: string; sourceAt: string; volatilityBps: number; payloadHash: string }));
    reg(investCapabilities.recordMarketSession, (input, call) => this.recordMarketSession(this.scope(call), input as { exchangeCode: string; sessionDate: string; opensAt: string; closesAt: string; isOpen: boolean; source: string }));
    reg(investCapabilities.createMandate, (input, call) => this.createMandate(this.scope(call), this.actor(call), input as { portfolioId: string; version: number; effectiveFrom: string; effectiveUntil: string|null; allowedAssetClasses: Array<'equity'|'crypto'|'fixed_income'|'fund'>; allowedInstrumentIds: string[]; benchmark: string; limits: unknown }));
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
      `SELECT o.id,o.portfolio_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text
       FROM invest_orders o JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
       WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.deleted_hlc IS NULL AND ($3::uuid IS NULL OR o.portfolio_id=$3)
       ORDER BY o.created_at DESC LIMIT 200`, [scope.tenantId, scope.workspaceId, filter.portfolioId ?? null])).rows;
  }

  async instruments(scope: InvestScope): Promise<Array<{id:string;symbol:string;asset_class:string;quantity_scale:number;exchange_code:string|null}>> {
    return (await this.scoped.query<{id:string;symbol:string;asset_class:string;quantity_scale:number;exchange_code:string|null}>(scope, `SELECT id,symbol,asset_class,quantity_scale,exchange_code FROM invest_instruments
      WHERE tenant_id=$1 AND workspace_id=$2 AND active=true ORDER BY symbol`, [scope.tenantId, scope.workspaceId])).rows;
  }

  async recordPrice(scope: InvestScope, input: { instrumentId: string; priceUnits: string; source: string; sourceAt: string; volatilityBps: number; payloadHash: string }): Promise<{id:string;received_at:string}> {
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const insert = await tx.query<{id:string;received_at:string}>(
        `INSERT INTO invest_market_prices(id,tenant_id,workspace_id,instrument_id,price_units,source,source_at,volatility_bps,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,workspace_id,instrument_id,source,payload_hash) DO NOTHING RETURNING id,received_at::text`,
        [uuidv7(), scope.tenantId, scope.workspaceId, input.instrumentId, input.priceUnits, input.source, input.sourceAt, input.volatilityBps, input.payloadHash]);
      if (insert.rows[0]) return insert;
      return tx.query<{id:string;received_at:string}>(`SELECT id,received_at::text FROM invest_market_prices WHERE tenant_id=$1 AND workspace_id=$2 AND instrument_id=$3 AND source=$4 AND payload_hash=$5`,
        [scope.tenantId, scope.workspaceId, input.instrumentId, input.source, input.payloadHash]);
    });
    if (!result.rows[0]) throw new Error('Market price insert failed'); return result.rows[0];
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

  async createMandate(scope: InvestScope, actorId: string, input: { portfolioId: string; version: number; effectiveFrom: string; effectiveUntil: string|null; allowedAssetClasses: Array<'equity'|'crypto'|'fixed_income'|'fund'>; allowedInstrumentIds: string[]; benchmark: string; limits: unknown }): Promise<{id:string;version:number;status:'approved'}> {
    const limits = GuardrailLimits.parse(input.limits);
    if (input.effectiveUntil && Date.parse(input.effectiveUntil) <= Date.parse(input.effectiveFrom)) throw new Error('Mandate expiry must follow its effective date');
    const result = await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query<{id:string;version:number;status:'approved'}>(
      `INSERT INTO invest_mandates(id,tenant_id,workspace_id,portfolio_id,version,effective_from,effective_until,limits,status,approved_by,approved_at,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'approved',$9,now(),$9) RETURNING id,version,status`,
      [uuidv7(), scope.tenantId, scope.workspaceId, input.portfolioId, input.version, input.effectiveFrom, input.effectiveUntil,
        JSON.stringify({ ...limits, allowedAssetClasses: input.allowedAssetClasses, allowedInstrumentIds: input.allowedInstrumentIds, benchmark: input.benchmark }), actorId]));
    if (!result.rows[0]) throw new Error('Mandate insert failed'); return result.rows[0];
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
    await this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, (tx) => tx.query(
      `INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units)
       VALUES($1,$2,$3,(now() AT TIME ZONE 'UTC')::date,$4,$4,0)
       ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET day_open_nav_units=invest_portfolio_risk_state.day_open_nav_units+$4,high_water_nav_units=GREATEST(invest_portfolio_risk_state.high_water_nav_units,invest_portfolio_risk_state.day_open_nav_units+$4),updated_at=now()`,
      [scope.tenantId, scope.workspaceId, input.portfolioId, input.units]));
    return { transactionId, environment: 'paper' };
  }

  async setKillSwitch(scope: InvestScope, actorId: string, input: { portfolioId:string; engaged:boolean; reason:string }): Promise<{portfolioId:string;engaged:boolean;cancelledOrders:number}> {
    const today = new Date().toISOString().slice(0,10);
    return this.scoped.withServerScope(scope, 'invest_paper', scope.hlc, async (tx) => {
      const portfolio = await tx.query<{id:string}>(`SELECT id FROM invest_portfolios WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
      if (!portfolio.rows[0]) throw new Error('Portfolio not found');
      await tx.query(`INSERT INTO invest_portfolio_risk_state(tenant_id,workspace_id,portfolio_id,risk_date,day_open_nav_units,high_water_nav_units,daily_loss_units,kill_switch,kill_reason)
        VALUES($1,$2,$3,$4,0,0,0,$5,$6) ON CONFLICT(tenant_id,workspace_id,portfolio_id,risk_date) DO UPDATE SET kill_switch=EXCLUDED.kill_switch,kill_reason=EXCLUDED.kill_reason,updated_at=now()`,
        [scope.tenantId, scope.workspaceId, input.portfolioId, today, input.engaged, input.engaged ? input.reason : null]);
      if (!input.engaged) return { portfolioId: input.portfolioId, engaged: false, cancelledOrders: 0 };
      const open = await tx.query<{id:string;status:string}>(`UPDATE invest_orders SET status='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND status IN ('proposed','approved','submitted') RETURNING id,status`,
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
       VALUES($1,$2,$3,(now() AT TIME ZONE 'UTC')::date,0,0,0)`, [scope.tenantId, scope.workspaceId, id]));
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
       WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=(now() AT TIME ZONE 'UTC')::date`, [scope.tenantId, scope.workspaceId, input.portfolioId]);
    const state = currentRisk.rows[0];
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
      const stateCheck = await tx.query<{kill_switch:boolean}>(`SELECT kill_switch FROM invest_portfolio_risk_state WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=(now() AT TIME ZONE 'UTC')::date FOR UPDATE`,
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
      const prior = await tx.query<OrderRow>(`SELECT o.id,o.portfolio_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text
        FROM invest_orders o JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
        WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, orderId]);
      const old = prior.rows[0]; if (!old) throw new Error('Order not found');
      if (target === 'approved' && old.status !== 'proposed') throw new Error('Only proposed orders may be approved');
      if (target === 'cancelled' && !['proposed','approved','submitted'].includes(old.status)) throw new Error('Order cannot be cancelled in its current state');
      const updated = await tx.query<OrderRow>(`UPDATE invest_orders SET status=$1 WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4
        RETURNING id,portfolio_id,instrument_id,(SELECT symbol FROM invest_instruments WHERE id=invest_orders.instrument_id)::text AS symbol,side,order_type,quantity_units::text,limit_price_units::text,status,environment,created_at::text`,
        [target, scope.tenantId, scope.workspaceId, orderId]);
      await this.orderEvent(tx, scope, actorId, orderId, target, old.status, target, detail);
      if (!updated.rows[0]) throw new Error('Order update failed'); return updated.rows[0];
    });
  }

  async execute(scope: InvestScope, actorId: string, input: { orderId: string }): Promise<{ order: OrderRow; fillId: string; transactionId: string; environment: 'paper' }> {
    return this.paperLedger.withPaperTradeTransaction(scope, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT o.id,o.portfolio_id,o.instrument_id,o.mandate_id,o.side,o.order_type,o.quantity_units::text,o.limit_price_units::text,o.status,o.environment,o.created_at::text,p.book_id,p.base_asset,i.symbol,i.asset_code,i.quantity_scale,i.exchange_code,q.price_units::text,q.id AS quote_id,q.received_at
         FROM invest_orders o JOIN invest_portfolios p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id AND p.id=o.portfolio_id
         JOIN invest_instruments i ON i.tenant_id=o.tenant_id AND i.workspace_id=o.workspace_id AND i.id=o.instrument_id
         JOIN LATERAL (SELECT id,price_units FROM invest_market_prices WHERE tenant_id=o.tenant_id AND workspace_id=o.workspace_id AND instrument_id=o.instrument_id ORDER BY received_at DESC LIMIT 1) q ON true
         WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, input.orderId]);
      const row = result.rows[0]; if (!row || row['status'] !== 'approved' || row['environment'] !== 'paper') throw new Error('Only approved PAPER orders can execute');
      const quote = BigInt(String(row['price_units'])); const quantity = String(row['quantity_units']);
      if (Date.now() - new Date(row['received_at'] as string | Date).getTime() > 300_000) throw new Error('Latest PAPER market quote is stale');
      if (row['order_type'] === 'limit') {
        const limit = BigInt(String(row['limit_price_units']));
        if ((row['side'] === 'buy' && quote > limit) || (row['side'] === 'sell' && quote < limit)) throw new Error('Stored PAPER market quote does not cross the order limit');
      }
      const notional = notionalUnits(quantity, quote.toString(), Number(row['quantity_scale']));
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
      await tx.query(`UPDATE invest_orders SET status='submitted' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.orderId]);
      await this.orderEvent(tx, scope, actorId, input.orderId, 'submitted', 'approved', 'submitted', { environment: 'paper' });
      await tx.query(`UPDATE invest_orders SET status='filled' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, input.orderId]);
      await this.orderEvent(tx, scope, actorId, input.orderId, 'filled', 'submitted', 'filled', { fillId, transactionId, environment: 'paper' });
      const order: OrderRow = { id: String(row['id']), portfolio_id: String(row['portfolio_id']), instrument_id: String(row['instrument_id']),
        symbol: String(row['symbol']), side: row['side'] as 'buy'|'sell', order_type: row['order_type'] as 'market'|'limit', quantity_units: quantity,
        limit_price_units: row['limit_price_units'] == null ? null : String(row['limit_price_units']), status: 'filled', environment: 'paper', created_at: String(row['created_at']) };
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
