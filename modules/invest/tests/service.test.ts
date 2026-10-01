import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type GrantedTable } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { PGliteLedgerWriter } from '@xyra/ledger';
import { LEDGER_TABLES } from '@xyra/ledger/contracts';
import investManifest from '../manifest';
import { InvestService } from '../server/service';

const tenantId = '019a0000-0000-7000-8000-000000000501';
const workspaceId = '019a0000-0000-7000-8000-000000000502';
const userId = '019a0000-0000-7000-8000-000000000503';
const secondUserId = '019a0000-0000-7000-8000-000000000504';
const hashStatement = (value: {portfolioId:string;sourceName:string;sourceRef:string;statementDate:string;cashUnits:string;positions:Array<{symbol:string;units:string}>}) =>
  createHash('sha256').update(JSON.stringify({portfolioId:value.portfolioId,source:value.sourceName,ref:value.sourceRef,statementDate:value.statementDate,cashUnits:value.cashUnits,
    positions:value.positions.map((position)=>({symbol:position.symbol.trim().toUpperCase(),units:position.units})).sort((a,b)=>a.symbol.localeCompare(b.symbol))})).digest('hex');

function load(directory: URL, moduleId: string) {
  return readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => migration(`${moduleId}/${name.slice(0, -4)}`, readFileSync(new URL(name, directory), 'utf8')));
}

let db: PGlite;
let writer: PGliteLedgerWriter;
let service: InvestService;
let portfolioId: string;
let instrumentId: string;
let orderId: string;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [
    ...load(new URL('../../../packages/db/migrations/', import.meta.url), 'platform'),
    ...load(new URL('../../money/migrations/', import.meta.url), 'money'),
    ...load(new URL('../migrations/', import.meta.url), 'invest'),
    ...load(new URL('../../swarm/migrations/', import.meta.url), 'swarm'),
  ]);
  const toGrant = (table: typeof investManifest.tables[number] | typeof LEDGER_TABLES[number]): GrantedTable => ({
    name: table.name, class: table.class,
    ...(table.authority ? { authority: table.authority } : {}),
    ...(table.serverWriteCapabilities ? { serverWriteCapabilities: table.serverWriteCapabilities } : {}),
    ...(table.serverReadCapabilities ? { serverReadCapabilities: table.serverReadCapabilities } : {}),
    ...(table.serverInsertCapabilities ? { serverInsertCapabilities: table.serverInsertCapabilities } : {}),
  });
  await prepareLocalAppRole(db, [
    ...LEDGER_TABLES.map(toGrant),
    ...investManifest.tables.map(toGrant),
    { name: 'swarm_night_shift', class: 'local', authority: 'local' },
  ]);
  await db.exec(`INSERT INTO tenants(id,name) VALUES ('${tenantId}','Invest service test');
    INSERT INTO workspaces(id,tenant_id,name) VALUES ('${workspaceId}','${tenantId}','Invest service test');
    INSERT INTO users(id,tenant_id,display_name) VALUES ('${userId}','${tenantId}','Invest owner'),('${secondUserId}','${tenantId}','Second IC member');`);
  writer = new PGliteLedgerWriter(db);
  service = new InvestService(new LocalScopedStore(db), writer, writer);
}, 60_000);

afterAll(async () => { await db?.close(); });

test('UTC day key is independent of session timezone and rolls at the UTC boundary', async () => {
  const result = await db.query<{ before_boundary:string; after_boundary:string }>(`SELECT invest_utc_risk_date('2026-10-01T00:15:00+02:00'::timestamptz)::text AS before_boundary,
    invest_utc_risk_date('2026-09-30T23:59:59-01:00'::timestamptz)::text AS after_boundary`);
  expect(result.rows[0]).toEqual({ before_boundary:'2026-09-30', after_boundary:'2026-10-01' });
});

test('trusted service creates, risk-sizes, approves and atomically fills a PAPER order', async () => {
  const scope = { tenantId, workspaceId };
  await writer.ensureAssets(scope, userId, [{ code: 'USD', scale: 2, kind: 'fiat', name: 'US dollar' }]);
  const portfolio = await service.createPortfolio(scope, userId, { name: 'Test portfolio', baseAsset: 'USD' });
  portfolioId = portfolio.id;
  await service.fundPortfolio(scope, userId, { portfolioId, units: '100000', reference: 'test seed' });
  const instrument = await service.createInstrument(scope, userId, {
    symbol: 'PAPERX', assetClass: 'crypto', quantityScale: 6, exchangeCode: null,
  });
  instrumentId = instrument.id;
  await service.recordPrice(scope, userId, {
    instrumentId, priceUnits: '10000', source: 'test-paper-input', sourceAt: new Date().toISOString(),
    volatilityBps: 1000, payloadHash: 'a'.repeat(64),
  });
  const memo = await service.createMandate(scope, userId, {
    portfolioId, version: 1, title: 'PAPER test policy', thesis: 'Test-only mandate for deterministic paper workflow.',
    sources: [{ label: 'Test fixture', ref: 'fixture://invest/service', sha256: 'b'.repeat(64) }],
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveUntil: null,
    allowedAssetClasses: ['crypto'], allowedInstrumentIds: [instrumentId], benchmark: 'PAPER-CASH',
    limits: {
      maxOrderNotionalUnits: '100000', maxPositionNotionalUnits: '100000', maxDailyLossUnits: '100000',
      maxOrdersPerHour: 20, maxPriceDeviationBps: 500, quoteFreshnessSeconds: 300, duplicateWindowSeconds: 1,
      maxConcentrationBps: 5000, maxCorrelatedExposureBps: 10000, maxLeverageBps: 10000,
      maxDrawdownBps: 2000, targetVolatilityBps: 2000,
    },
  });
  expect(memo.status).toBe('in_review');
  const userCall = (id: string) => ({ principal: { kind: 'user' as const, id, tenantId, workspaces: [{ id: workspaceId, role: 'admin' as const, kind: 'standard' as const }], grants: [] }, workspaceId });
  const agentCall = { principal: { ...userCall(userId).principal, kind: 'agent' as const, delegatedBy: userId, runId: '019a0000-0000-7000-8000-000000000505' }, workspaceId };
  const firstPerformanceMark=await service.capturePerformanceMark(scope,userCall(userId),{portfolioId,benchmarkIndexUnits:'10000',benchmarkSource:'Fixture benchmark',benchmarkRef:'fixture://benchmark/first'});
  await expect(service.capturePerformanceMark(scope,agentCall,{portfolioId,benchmarkIndexUnits:'10000',benchmarkSource:'Fixture benchmark',benchmarkRef:'fixture://benchmark/agent'})).rejects.toThrow(/direct owner or admin/);
  await expect(service.voteMemo(scope, agentCall, { memoId: memo.id, vote: 'approve', reason: 'agent cannot vote' })).rejects.toThrow(/direct owner or admin/);
  const firstVote = await service.voteMemo(scope, userCall(userId), { memoId: memo.id, vote: 'approve', reason: 'Reviewed limits and source' });
  expect(firstVote.approvals).toBe(1);
  await expect(service.activateMandate(scope, userCall(userId), { memoId: memo.id })).rejects.toThrow(/two independent approvals/);
  await service.voteMemo(scope, userCall(secondUserId), { memoId: memo.id, vote: 'approve', reason: 'Independent review' });
  const mandate = await service.activateMandate(scope, userCall(userId), { memoId: memo.id });
  expect(mandate.status).toBe('approved');
  await db.query(`DELETE FROM invest_portfolio_risk_state WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date()`,[tenantId,workspaceId,portfolioId]);
  await expect(service.riskState(scope,{portfolioId})).resolves.toMatchObject({killSwitch:false,dailyLossUnits:'0'});
  const immutableVote = await db.query<{id:string}>(`SELECT id FROM invest_ic_votes WHERE tenant_id=$1 AND workspace_id=$2 AND memo_id=$3 ORDER BY created_at LIMIT 1`, [tenantId, workspaceId, memo.id]);
  await expect(db.query(`UPDATE invest_ic_votes SET reason='rewrite' WHERE id=$1`, [immutableVote.rows[0]?.id])).rejects.toThrow(/append-only/);
  const proposed = await service.propose(scope, userId, {
    portfolioId, instrumentId, side: 'buy', orderType: 'market', stopPriceUnits: '9000', riskBps: 50,
    idempotencyKey: 'paper-order-service-test',
  });
  orderId = proposed.id;
  const newUtcDay = await db.query<{day_open_nav_units:string}>(`SELECT day_open_nav_units::text FROM invest_portfolio_risk_state
    WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date()`,[tenantId,workspaceId,portfolioId]);
  expect(newUtcDay.rows[0]?.day_open_nav_units).toBe('100000');
  expect(proposed.environment).toBe('paper');
  expect(proposed.quantity_units).toBe('500000');
  await service.approve(scope, userId, { orderId });
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  let firstFill: Awaited<ReturnType<typeof service.execute>>;
  let fill: Awaited<ReturnType<typeof service.execute>>;
  try {
    firstFill = await service.execute(scope, userId, { orderId, quantityUnits: '200000' });
    expect(firstFill.order.status).toBe('partially_filled');
    await expect(service.execute(scope,userId,{orderId,quantityUnits:'300001'})).rejects.toThrow(/exceeds remaining/);
    fill = await service.execute(scope, userId, { orderId });
  }
  finally { vi.unstubAllGlobals(); }
  expect(network).not.toHaveBeenCalled();
  expect(fill).toMatchObject({ order: { id: orderId, status: 'filled' }, environment: 'paper' });
  expect(fill.order.filled_units).toBe('500000');
  await expect(service.orders(scope,{portfolioId})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({id:orderId,quantity_units:'500000',filled_units:'500000'})]));

  const persisted = await db.query<{ fills: number; ledger_transactions: number; entries: number; cash: string; position: string }>(
    `SELECT (SELECT count(*)::int FROM invest_fills WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3) AS fills,
      (SELECT count(*)::int FROM ledger_transactions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$4) AS ledger_transactions,
      (SELECT count(*)::int FROM ledger_entries WHERE tenant_id=$1 AND workspace_id=$2 AND transaction_id=$4) AS entries,
      (SELECT units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND account_id=(SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND code='cash') AND asset='USD') AS cash,
      (SELECT units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND account_id=(SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND code=$6) AND asset=$7) AS position`,
    [tenantId, workspaceId, orderId, fill.transactionId, portfolio.book_id, `position:${instrumentId}`, `EQ:PAPERX`],
  );
  expect(persisted.rows[0]).toMatchObject({ fills: 2, ledger_transactions: 1, entries: 4, cash: '95000', position: '500000' });
  const openedLots = await service.taxLots(scope, { portfolioId: portfolio.id });
  expect(openedLots).toHaveLength(2);
  expect(openedLots.map((lot)=>[lot.instrumentId,lot.acquiredUnits,lot.remainingUnits,lot.costBasisUnits,lot.remainingBasisUnits])).toEqual([
    [instrumentId,'200000','200000','2000','2000'],[instrumentId,'300000','300000','3000','3000'],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const sell = await service.propose(scope, userId, { portfolioId, instrumentId, side: 'sell', orderType: 'market', stopPriceUnits: '11000', riskBps: 50, idempotencyKey: 'paper-fifo-disposal-test' });
  await service.approve(scope, userId, { orderId: sell.id });
  await service.execute(scope, userId, { orderId: sell.id });
  expect(await service.taxLots(scope, { portfolioId: portfolio.id })).toHaveLength(0);
  const lots = await db.query<{ remaining_units: string; remaining_basis_units: string; events: number; gain: string }>(
    `SELECT l.remaining_units::text,l.remaining_basis_units::text,count(e.id)::int AS events,
       sum(e.realized_gain_units)::text AS gain FROM invest_tax_lots l JOIN invest_tax_lot_events e
       ON e.tenant_id=l.tenant_id AND e.workspace_id=l.workspace_id AND e.lot_id=l.id
       WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.portfolio_id=$3 GROUP BY l.id`, [tenantId, workspaceId, portfolio.id]);
  expect(lots.rows).toHaveLength(2);
  expect(lots.rows).toEqual([
    { remaining_units: '0', remaining_basis_units: '0', events: 2, gain: '0' },
    { remaining_units: '0', remaining_basis_units: '0', events: 2, gain: '0' },
  ]);
  const matchedInput = { portfolioId:portfolio.id,sourceName:'Fixture custodian',sourceRef:'fixture://statement/matched',statementDate:'2026-09-30',cashUnits:'100000',positions:[] as Array<{symbol:string;units:string}> };
  await expect(service.reconcileStatement(scope, userCall(userId), { ...matchedInput, statementHash:'0'.repeat(64) })).rejects.toThrow(/content hash/);
  const matched = await service.reconcileStatement(scope, userCall(userId), { ...matchedInput, statementHash:hashStatement(matchedInput) });
  expect(matched).toMatchObject({status:'matched',discrepancyCount:0,idempotent:false});
  const agentInput={...matchedInput,sourceRef:'fixture://statement/agent'};
  await expect(service.reconcileStatement(scope, agentCall, { ...agentInput,statementHash:hashStatement(agentInput) })).rejects.toThrow(/direct owner or admin/);
  await expect(service.reconcileStatement(scope, userCall(userId), { ...matchedInput,statementHash:hashStatement(matchedInput) }))
    .resolves.toMatchObject({runId:matched.runId,status:'matched',idempotent:true});
  const mismatchInput={portfolioId:portfolio.id,sourceName:'Fixture custodian',sourceRef:'fixture://statement/mismatch',statementDate:'2026-09-30',cashUnits:'99000',positions:[{symbol:'UNKNOWN',units:'20'}]};
  const mismatched = await service.reconcileStatement(scope, userCall(userId), { ...mismatchInput,statementHash:hashStatement(mismatchInput) });
  expect(mismatched).toMatchObject({status:'needs_review',discrepancyCount:2});
  const diffs = await db.query<{kind:string;expected_units:string;observed_units:string;owner_id:string}>(`SELECT kind,expected_units::text,observed_units::text,owner_id FROM invest_reconciliation_discrepancies WHERE tenant_id=$1 AND workspace_id=$2 AND run_id=$3 ORDER BY kind`, [tenantId,workspaceId,mismatched.runId]);
  expect(diffs.rows).toEqual([{kind:'cash_mismatch',expected_units:'100000',observed_units:'99000',owner_id:userId},{kind:'unknown_position',expected_units:'0',observed_units:'20',owner_id:userId}]);
  await db.query(`UPDATE invest_portfolio_risk_state SET risk_date=risk_date-1,kill_switch=true,kill_reason='prior day halt'
    WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=invest_utc_risk_date()`,[tenantId,workspaceId,portfolio.id]);
  await service.fundPortfolio(scope,userId,{portfolioId:portfolio.id,units:'1000',reference:'post-midnight PAPER capital contribution'});
  await expect(service.riskState(scope,{portfolioId:portfolio.id})).resolves.toMatchObject({killSwitch:true,killReason:'prior day halt',dailyLossUnits:'0'});
  const secondPerformanceMark=await service.capturePerformanceMark(scope,userCall(userId),{portfolioId,benchmarkIndexUnits:'11000',benchmarkSource:'Fixture benchmark',benchmarkRef:'fixture://benchmark/second'});
  expect(secondPerformanceMark).toMatchObject({external_flow_units:'1000',nav_units:'101000'});
  const statement=await service.createPerformanceStatement(scope,userCall(userId),{portfolioId,fromMarkId:firstPerformanceMark.id,toMarkId:secondPerformanceMark.id});
  expect(statement.report).toMatchObject({calculationVersion:'invest-twr-fixed-v1',feesUnits:'0',twrBps:'0',benchmarkReturnBps:'1000',relativeReturnBps:'-1000',netExternalFlowUnits:'1000'});
  await expect(service.createPerformanceStatement(scope,userCall(userId),{portfolioId,fromMarkId:firstPerformanceMark.id,toMarkId:secondPerformanceMark.id})).resolves.toMatchObject({id:statement.id});
  expect(await service.performanceStatements(scope,{portfolioId})).toEqual(expect.arrayContaining([expect.objectContaining({id:statement.id})]));
  await expect(db.query(`UPDATE invest_performance_marks SET nav_units=0 WHERE id=$1`,[secondPerformanceMark.id])).rejects.toThrow(/append-only/);
  await expect(db.query(`UPDATE invest_performance_reports SET result_hash=$2 WHERE id=$1`,[statement.id,'0'.repeat(64)])).rejects.toThrow(/append-only/);
  await expect(service.propose(scope,userId,{portfolioId:portfolio.id,instrumentId,side:'buy',orderType:'market',stopPriceUnits:'9000',riskBps:50,idempotencyKey:'halt-carries-over-utc-day'})).rejects.toThrow(/kill switch is engaged/);
  await service.setKillSwitch(scope,userId,{portfolioId:portfolio.id,engaged:false,reason:'Owner explicitly resumed after UTC rollover'});
  await expect(service.riskState(scope,{portfolioId:portfolio.id})).resolves.toMatchObject({killSwitch:false,killReason:null,dailyLossUnits:'0'});

  const revisedMemo = await service.createMandate(scope,userId,{portfolioId,version:2,title:'Versioned PAPER risk-policy change',thesis:'Lower the order notional cap after review.',
    sources:[{label:'Policy review fixture',ref:'fixture://invest/limits/v2',sha256:'c'.repeat(64)}],effectiveFrom:new Date(Date.now()-60_000).toISOString(),effectiveUntil:null,
    allowedAssetClasses:['crypto'],allowedInstrumentIds:[instrumentId],benchmark:'PAPER-CASH',limits:{maxOrderNotionalUnits:'90000',maxPositionNotionalUnits:'100000',maxDailyLossUnits:'100000',
      maxOrdersPerHour:20,maxPriceDeviationBps:500,quoteFreshnessSeconds:300,duplicateWindowSeconds:1,maxConcentrationBps:5000,maxCorrelatedExposureBps:10000,
      maxLeverageBps:10000,maxDrawdownBps:2000,targetVolatilityBps:2000,blockedSymbols:[],watchSymbols:[]}});
  await service.voteMemo(scope,userCall(userId),{memoId:revisedMemo.id,vote:'approve',reason:'Owner reviewed the revised cap'});
  await service.voteMemo(scope,userCall(secondUserId),{memoId:revisedMemo.id,vote:'approve',reason:'Independent IC approval'});
  const activatedV2 = await service.activateMandate(scope,userCall(userId),{memoId:revisedMemo.id});
  const limitAudit = await db.query<{previous:string;proposed:string;reason:string;approved_by:string;created_by:string}>(`SELECT previous_limits::text AS previous,proposed_limits::text AS proposed,reason,approved_by,created_by FROM invest_limit_changes
    WHERE tenant_id=$1 AND workspace_id=$2 AND mandate_id=$3`,[tenantId,workspaceId,activatedV2.id]);
  expect(limitAudit.rows).toHaveLength(1);
  expect(JSON.parse(limitAudit.rows[0]!.previous).maxOrderNotionalUnits).toBe('100000');
  expect(JSON.parse(limitAudit.rows[0]!.proposed).maxOrderNotionalUnits).toBe('90000');
  expect(limitAudit.rows[0]).toMatchObject({approved_by:userId,created_by:userId});

  const historicalBars = [
    {at:'2026-01-01T00:00:00.000Z',openUnits:'10000',highUnits:'10500',lowUnits:'9500',closeUnits:'10000'},
    {at:'2026-01-02T00:00:00.000Z',openUnits:'10000',highUnits:'11200',lowUnits:'9900',closeUnits:'11000'},
    {at:'2026-01-03T00:00:00.000Z',openUnits:'12000',highUnits:'14000',lowUnits:'11500',closeUnits:'13000'},
  ];
  const strategy={id:'momentum-next-bar',version:1,quantityUnits:'1000000',stopBps:500,targetBps:1000,feeBps:100};
  const backtestInput={instrumentId,dataVersion:1,sourceName:'Unit fixture',sourceRef:'fixture://invest/backtest/golden',bars:historicalBars,strategy};
  const backtest=await service.runBacktest(scope,userId,backtestInput);
  expect(backtest).toMatchObject({engineVersion:'momentum-next-bar-v1',dataVersion:1,strategyVersion:1,netPnlUnits:'948',totalFeesUnits:'252'});
  await expect(service.runBacktest(scope,userId,backtestInput)).resolves.toMatchObject({runId:backtest.runId});
  await expect(service.backtestRuns(scope,{instrumentId})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({id:backtest.runId,data_version:1,strategy_key:strategy.id,strategy_version:1,net_pnl_units:'948'})]));
  await expect(service.runBacktest(scope,userId,{...backtestInput,bars:[...historicalBars.slice(0,2),{...historicalBars[2]!,closeUnits:'12999'}]})).rejects.toThrow(/data version already exists/);
  await expect(db.query(`UPDATE invest_backtest_runs SET net_pnl_units=0 WHERE id=$1`,[backtest.runId])).rejects.toThrow(/append-only/);
});

test('a failing fill-event insert rolls back fill and ledger posting together', async () => {
  const scope = { tenantId, workspaceId };
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const retryOrder = await service.propose(scope, userId, {
    portfolioId, instrumentId, side: 'buy', orderType: 'market', stopPriceUnits: '9000', riskBps: 50,
    idempotencyKey: 'paper-order-rollback-test',
  });
  await service.approve(scope, userId, { orderId: retryOrder.id });
  await db.exec(`CREATE FUNCTION fail_test_filled_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type='filled' THEN RAISE EXCEPTION 'injected fill journal failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_test_filled_event BEFORE INSERT ON invest_order_events FOR EACH ROW EXECUTE FUNCTION fail_test_filled_event();`);
  try {
    await expect(service.execute(scope, userId, { orderId: retryOrder.id })).rejects.toThrow('injected fill journal failure');
  } finally {
    await db.exec('DROP TRIGGER fail_test_filled_event ON invest_order_events; DROP FUNCTION fail_test_filled_event();');
  }
  const rolledBack = await db.query<{ status: string; fills: number; transactions: number }>(
    `SELECT o.status,
      (SELECT count(*)::int FROM invest_fills WHERE order_id=o.id) AS fills,
      (SELECT count(*)::int FROM ledger_transactions WHERE correlation_id=o.id) AS transactions
     FROM invest_orders o WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3`, [tenantId, workspaceId, retryOrder.id],
  );
  expect(rolledBack.rows[0]).toEqual({ status: 'approved', fills: 0, transactions: 0 });
});

test('price marks revalue ledger positions, record breaches, auto-halt and cancel open PAPER orders', async () => {
  const scope = { tenantId, workspaceId };
  const portfolio = await service.createPortfolio(scope, userId, { name: 'Daily-loss test', baseAsset: 'USD' });
  await service.fundPortfolio(scope, userId, { portfolioId: portfolio.id, units: '100000', reference: 'risk fixture' });
  const first = await service.createInstrument(scope, userId, { symbol: 'MARKA', assetClass: 'crypto', quantityScale: 6, exchangeCode: null });
  const second = await service.createInstrument(scope, userId, { symbol: 'MARKB', assetClass: 'crypto', quantityScale: 6, exchangeCode: null });
  for (const [instrumentId, code] of [[first.id,'d'],[second.id,'e']] as const) {
    await service.recordPrice(scope, userId, { instrumentId, priceUnits: '10000', source: 'risk-mark-fixture', sourceAt: new Date().toISOString(), volatilityBps: 1000, payloadHash: code.repeat(64) });
  }
  const memo = await service.createMandate(scope, userId, {
    portfolioId: portfolio.id, version: 1, title: 'Daily loss monitor', thesis: 'Test deterministic post-trade risk and auto-halt.',
    sources: [{ label: 'Test fixture', ref: 'fixture://invest/daily-loss', sha256: 'c'.repeat(64) }],
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveUntil: null,
    allowedAssetClasses: ['crypto'], allowedInstrumentIds: [first.id, second.id], benchmark: 'PAPER-CASH',
    limits: { maxOrderNotionalUnits: '100000', maxPositionNotionalUnits: '100000', maxDailyLossUnits: '100', maxOrdersPerHour: 20,
      maxPriceDeviationBps: 5000, quoteFreshnessSeconds: 300, duplicateWindowSeconds: 1, maxConcentrationBps: 5000,
      maxCorrelatedExposureBps: 10000, maxLeverageBps: 10000, maxDrawdownBps: 2000, targetVolatilityBps: 2000 },
  });
  const human = (id: string) => ({ principal: { kind: 'user' as const, id, tenantId, workspaces: [{ id: workspaceId, role: 'admin' as const, kind: 'standard' as const }], grants: [] }, workspaceId });
  await service.voteMemo(scope, human(userId), { memoId: memo.id, vote: 'approve', reason: 'Checked limits' });
  await service.voteMemo(scope, human(secondUserId), { memoId: memo.id, vote: 'approve', reason: 'Independent check' });
  await service.activateMandate(scope, human(userId), { memoId: memo.id });
  const firstOrder = await service.propose(scope, userId, { portfolioId: portfolio.id, instrumentId: first.id, side: 'buy', orderType: 'market', stopPriceUnits: '9000', riskBps: 50, idempotencyKey: 'daily-loss-first' });
  await service.approve(scope, userId, { orderId: firstOrder.id });
  await service.execute(scope, userId, { orderId: firstOrder.id });
  const pending = await service.propose(scope, userId, { portfolioId: portfolio.id, instrumentId: second.id, side: 'buy', orderType: 'market', stopPriceUnits: '9000', riskBps: 50, idempotencyKey: 'daily-loss-pending' });
  const changedPrice = await service.recordPrice(scope, userId, { instrumentId: first.id, priceUnits: '9000', source: 'risk-mark-fixture', sourceAt: new Date().toISOString(), volatilityBps: 1000, payloadHash: 'f'.repeat(64) });
  expect(changedPrice.id).toBeTruthy();
  const riskState = await db.query<{kill_switch:boolean;daily_loss_units:string}>(`SELECT kill_switch,daily_loss_units::text FROM invest_portfolio_risk_state WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND risk_date=(now() AT TIME ZONE 'UTC')::date`, [tenantId, workspaceId, portfolio.id]);
  expect(riskState.rows[0]).toEqual({ kill_switch: true, daily_loss_units: '500' });
  await expect(service.riskState(scope, { portfolioId: portfolio.id })).resolves.toMatchObject({ killSwitch: true, dailyLossUnits: '500' });
  const cancelled = await service.orders(scope, { portfolioId: portfolio.id });
  expect(cancelled.find((order) => order.id === pending.id)?.status).toBe('cancelled');
  const breach = await db.query<{kind:string}>(`SELECT kind FROM invest_breaches WHERE tenant_id=$1 AND workspace_id=$2 AND portfolio_id=$3 AND status='open'`, [tenantId, workspaceId, portfolio.id]);
  expect(breach.rows.map((row) => row.kind)).toContain('daily_loss');
  const alert = (await service.breaches(scope)).find((item) => item.portfolio_id === portfolio.id && item.kind === 'daily_loss');
  expect(alert).toBeDefined();
  if (!alert) throw new Error('Expected persisted daily-loss alert');
  const owner = human(userId);
  await expect(service.manageBreach(scope, human(secondUserId), { breachId: alert.id, action: 'acknowledge', reason: 'unassigned user cannot acknowledge' })).rejects.toThrow(/assigned owner/);
  await service.manageBreach(scope, owner, { breachId: alert.id, action: 'assign', reason: 'I own the follow-up' });
  await service.manageBreach(scope, owner, { breachId: alert.id, action: 'acknowledge', reason: 'Reviewed daily loss alert' });
  await expect(service.manageBreach(scope, owner, { breachId: alert.id, action: 'resolve', reason: 'Resolved after documenting paper valuation issue' })).resolves.toMatchObject({ status: 'resolved', ownerId: userId });
  const alertEvents = await db.query<{event_type:string}>(`SELECT event_type FROM invest_breach_events WHERE tenant_id=$1 AND workspace_id=$2 AND breach_id=$3 ORDER BY received_at`, [tenantId, workspaceId, alert.id]);
  expect(alertEvents.rows.map((event) => event.event_type)).toEqual(['alerted','assigned','acknowledged','resolved']);
});

test('the paper execution capability cannot update a same-workspace SWARM setting', async () => {
  await db.exec(`INSERT INTO swarm_night_shift(tenant_id,workspace_id,max_runs,max_spend_usd)
    VALUES ('${tenantId}','${workspaceId}',1,1)`);
  const scoped = new LocalScopedStore(db);
  await expect(scoped.withServerScope({ tenantId, workspaceId }, 'invest_paper_execution', undefined, (tx) =>
    tx.query(`UPDATE swarm_night_shift SET max_runs=99 WHERE tenant_id=$1 AND workspace_id=$2`, [tenantId, workspaceId]),
  )).rejects.toThrow(/permission denied/);
  const row = await db.query<{ max_runs: number }>('SELECT max_runs FROM swarm_night_shift WHERE tenant_id=$1 AND workspace_id=$2', [tenantId, workspaceId]);
  expect(row.rows[0]?.max_runs).toBe(1);
});

test('module runtime exposes PAPER execution only and no live broker adapter or route', async () => {
  const riskText = readFileSync(new URL('../server/risk.ts', import.meta.url), 'utf8');
  const serviceText = readFileSync(new URL('../server/service.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
  expect(riskText).toContain("environment: z.literal('paper').default('paper')");
  expect(serviceText).toContain("'paper'");
  expect(serviceText).not.toMatch(/fetch\s*\(|https?:\/\/[^\s'"`]+|liveBroker|brokerAdapter|LIVE_TRADING/i);
  expect(Object.keys(packageJson.exports).some((key) => /live|broker/i.test(key))).toBe(false);
});
