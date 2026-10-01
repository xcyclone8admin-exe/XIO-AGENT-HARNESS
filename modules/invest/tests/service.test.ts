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
import { investCapabilities } from '../server/capabilities';
import type { TrustedFlowStepContext } from '../server/scheduled-reconciliation';
import type { VerifiedInvestSignalV1 } from '../server/invest-signals';

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
let globalKillEngaged = false;
let globalKillReadFails = false;
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
  service = new InvestService(new LocalScopedStore(db), writer, writer, {
    async getKillSwitch() {
      if (globalKillReadFails) throw new Error('simulated SWARM durable read failure');
      return { engaged: globalKillEngaged, reason: globalKillEngaged ? 'test global halt' : null, changedBy: null, changedAt: null };
    },
  });
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
  globalKillEngaged = true;
  await expect(service.execute(scope,userId,{orderId,quantityUnits:'200000'})).rejects.toThrow('INVEST_GLOBAL_KILL_SWITCH_ENGAGED');
  globalKillEngaged = false;
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  let firstFill: Awaited<ReturnType<typeof service.execute>>;
  let fill: Awaited<ReturnType<typeof service.execute>>;
  try {
    firstFill = await service.execute(scope, userId, { orderId, quantityUnits: '200000' });
    expect(firstFill.order.status).toBe('partially_filled');
    await expect(service.execute(scope,userId,{orderId,quantityUnits:'300001'})).rejects.toThrow(/exceeds remaining/);
    const cancelled = await service.cancel(scope,userId,{orderId});
    expect(cancelled.status).toBe('cancelled');
    const repeatedCancel = await service.cancel(scope,userId,{orderId});
    expect(repeatedCancel).toMatchObject({status:'cancelled',filled_units:'200000'});
    const events = await db.query<{count:number}>(`SELECT count(*)::int AS count FROM invest_order_events WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3 AND event_type='cancelled'`,[tenantId,workspaceId,orderId]);
    expect(events.rows[0]?.count).toBe(1);
    const latestFill = await db.query<{id:string;execution_ref:string}>(`SELECT id,execution_ref FROM invest_fills WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3 ORDER BY created_at DESC LIMIT 1`,[tenantId,workspaceId,orderId]);
    fill = {order:cancelled,fillId:latestFill.rows[0]!.id,transactionId:latestFill.rows[0]!.execution_ref.slice('paper:'.length),environment:'paper'};
  }
  finally { vi.unstubAllGlobals(); }
  expect(network).not.toHaveBeenCalled();
  expect(fill.order).toMatchObject({ id: orderId, status: 'cancelled' });
  const expectedFilledUnits = '200000';
  expect(fill.order.filled_units).toBe(expectedFilledUnits);
  await expect(service.orders(scope,{portfolioId})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({id:orderId,quantity_units:'500000',filled_units:expectedFilledUnits})]));

  const persisted = await db.query<{ fills: number; ledger_transactions: number; entries: number; cash: string; position: string }>(
    `SELECT (SELECT count(*)::int FROM invest_fills WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3) AS fills,
      (SELECT count(*)::int FROM ledger_transactions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$4) AS ledger_transactions,
      (SELECT count(*)::int FROM ledger_entries WHERE tenant_id=$1 AND workspace_id=$2 AND transaction_id=$4) AS entries,
      (SELECT units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND account_id=(SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND code='cash') AND asset='USD') AS cash,
      (SELECT units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND account_id=(SELECT id FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$5 AND code=$6) AND asset=$7) AS position`,
    [tenantId, workspaceId, orderId, fill.transactionId, portfolio.book_id, `position:${instrumentId}`, `EQ:PAPERX`],
  );
  expect(persisted.rows[0]).toMatchObject({ fills: expectedFilledUnits === '200000' ? 1 : 2, ledger_transactions: expectedFilledUnits === '200000' ? 1 : 1, entries: 4, cash: expectedFilledUnits === '200000' ? '98000' : '95000', position: expectedFilledUnits });
  const openedLots = await service.taxLots(scope, { portfolioId: portfolio.id });
  expect(openedLots).toHaveLength(expectedFilledUnits === '200000' ? 1 : 2);
  expect(openedLots.map((lot)=>[lot.instrumentId,lot.acquiredUnits,lot.remainingUnits,lot.costBasisUnits,lot.remainingBasisUnits])).toEqual(expectedFilledUnits === '200000' ? [
    [instrumentId,'200000','200000','2000','2000'],
  ] : [
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
  expect(lots.rows).toHaveLength(expectedFilledUnits === '200000' ? 1 : 2);
  expect(lots.rows).toEqual(expectedFilledUnits === '200000' ? [
    { remaining_units: '0', remaining_basis_units: '0', events: 2, gain: '0' },
  ] : [
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
  await expect(service.reconciliationQueue(scope)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({run_id:mismatched.runId,kind:'cash_mismatch',expected_units:'100000',observed_units:'99000',difference_units:'-1000',owner_id:userId}),
    expect.objectContaining({run_id:mismatched.runId,kind:'unknown_position',expected_units:'0',observed_units:'20',difference_units:'20',owner_id:userId}),
  ]));
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
  const differentScale = await service.createInstrument(scope,userId,{symbol:'SCALETEST',assetClass:'equity',quantityScale:4,exchangeCode:null});
  await expect(service.runBacktest(scope,userId,{...backtestInput,instrumentId:differentScale.id,dataVersion:1})).rejects.toThrow(/strategy version already exists with different configuration/);
  await expect(db.query(`UPDATE invest_backtest_runs SET net_pnl_units=0 WHERE id=$1`,[backtest.runId])).rejects.toThrow(/append-only/);
});

test('Cloud signal claim becomes one immutable advisory decision before host ack', async () => {
  const scope={tenantId,workspaceId};
  const now=Date.now();
  const envelope:VerifiedInvestSignalV1={protocol:'xyra.invest.signal.v1',eventId:'evt-invest-advisory-1',sourceId:'019a0000-0000-7000-8000-000000000801',
    tenantId,workspaceId,receivedAt:new Date(now).toISOString(),occurredAt:new Date(now-1_000).toISOString(),expiresAt:new Date(now+60_000).toISOString(),
    algorithmId:'trend-v1',signalId:'019a0000-0000-7000-8000-000000000802',symbol:'PAPERX',side:'buy',quantity:'0.5',payloadDigest:'c'.repeat(64),
    verification:{signature:'verified',keyId:'019a0000-0000-7000-8000-000000000803'}};
  const claim={leaseId:'019a0000-0000-7000-8000-000000000804',fence:1,expiresAt:new Date(now+25_000).toISOString()};
  const before=(await service.orders(scope,{})).length;
  const first=await service.consumeCloudInvestSignal(scope,envelope,claim,userId);
  const duplicate=await service.consumeCloudInvestSignal(scope,envelope,claim,userId);
  expect(duplicate).toEqual(first);
  await expect(service.consumeCloudInvestSignal(scope,envelope,{...claim,leaseId:'019a0000-0000-7000-8000-000000000805'},userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_REPLAY_CONFLICT');
  await expect(service.consumeCloudInvestSignal(scope,envelope,{...claim,fence:2},userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_REPLAY_CONFLICT');
  expect((await service.orders(scope,{}))).toHaveLength(before);
  const row=await db.query<{decision_status:string;instrument_id:string;claim_fence:number;detail:Record<string,unknown>}>(
    `SELECT decision_status,instrument_id,claim_fence,detail FROM invest_signal_decisions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,[tenantId,workspaceId,first.decisionId]);
  expect(row.rows[0]).toMatchObject({decision_status:'advisory',instrument_id:instrumentId,claim_fence:1,detail:{kind:'advisory_only',quantityUnits:'500000'}});
  await expect(service.consumeCloudInvestSignal(scope,{...envelope,payloadDigest:'d'.repeat(64)},claim,userId)).rejects.toThrow('INVEST_SIGNAL_EVENT_DIGEST_CONFLICT');
  await expect(service.consumeCloudInvestSignal({tenantId,workspaceId:'019a0000-0000-7000-8000-000000000899'},envelope,claim,userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,{...envelope,payloadDigest:'invalid'},claim,userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,{...envelope,verification:{signature:'unverified',keyId:envelope.verification.keyId}} as unknown as VerifiedInvestSignalV1,claim,userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,{...envelope,verification:{signature:'verified',keyId:'invalid'}},claim,userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,{...envelope,expiresAt:new Date(now-1).toISOString()},claim,userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,envelope,{...claim,expiresAt:new Date(now-1).toISOString()},userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(service.consumeCloudInvestSignal(scope,envelope,{...claim,fence:0},userId)).rejects.toThrow('INVEST_SIGNAL_CLAIM_INVALID');
  await expect(db.query(`UPDATE invest_signal_decisions SET symbol='OTHER' WHERE id=$1`,[first.decisionId])).rejects.toThrow(/append-only/);
});

test('cancel and fill serialize on the locked order row', async () => {
  const scope = {tenantId,workspaceId};
  await new Promise((resolve)=>setTimeout(resolve,1_100));
  const order=await service.propose(scope,userId,{portfolioId,instrumentId,side:'buy',orderType:'market',stopPriceUnits:'9000',riskBps:50,idempotencyKey:'paper-cancel-fill-race'});
  await service.approve(scope,userId,{orderId:order.id});
  await service.execute(scope,userId,{orderId:order.id,quantityUnits:'100000'});
  const [cancelled,filled]=await Promise.allSettled([service.cancel(scope,userId,{orderId:order.id}),service.execute(scope,userId,{orderId:order.id})]);
  const final= (await service.orders(scope,{portfolioId})).find((candidate)=>candidate.id===order.id);
  expect(final).toBeDefined();
  expect(['cancelled','filled']).toContain(final?.status);
  const count=await db.query<{fills:number;cancellations:number;filledUnits:string}>(`SELECT
      (SELECT count(*)::int FROM invest_fills WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3) AS fills,
      (SELECT count(*)::int FROM invest_order_events WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3 AND event_type='cancelled') AS cancellations,
      COALESCE((SELECT sum(quantity_units) FROM invest_fills WHERE tenant_id=$1 AND workspace_id=$2 AND order_id=$3),0)::text AS "filledUnits"`,[tenantId,workspaceId,order.id]);
  if(final?.status==='cancelled') {
    expect(cancelled.status).toBe('fulfilled'); expect(filled.status).toBe('rejected');
    expect(count.rows[0]).toMatchObject({fills:1,cancellations:1,filledUnits:'100000'});
  } else {
    expect(cancelled.status).toBe('rejected'); expect(filled.status).toBe('fulfilled');
    expect(count.rows[0]).toMatchObject({fills:2,cancellations:0});
  }
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

test('trusted FLOW daily custody handler reconciles persisted inputs once and reports absent connector', async () => {
  const scope={tenantId,workspaceId};
  const statementDate=new Date().toISOString().slice(0,10);
  const snapshot=await service.summary(scope,{portfolioId});
  const statement={ id:'019a0000-0000-7000-8000-000000000711',ownerId:userId,portfolioId,sourceName:'Persisted custody inbox',
    sourceRef:'custody://daily/fixture/1',statementDate,cashUnits:(BigInt(snapshot.cashUnits)-1n).toString(),
    positions:snapshot.positions.map((position)=>({symbol:position.symbol,units:position.quantityUnits})) };
  const input={...statement,statementHash:hashStatement(statement)};
  const matching={...statement,id:'019a0000-0000-7000-8000-000000000715',sourceRef:'custody://daily/fixture/2',cashUnits:snapshot.cashUnits};
  const matchingInput={...matching,statementHash:hashStatement(matching)};
  const invalidInput={...matchingInput,id:'019a0000-0000-7000-8000-000000000716',sourceRef:'custody://daily/fixture/invalid',statementHash:'0'.repeat(64)};
  let eligible=[input,invalidInput];
  const inbox={listEligible:vi.fn(async()=>eligible),acknowledgeProcessed:vi.fn(async()=>{})};
  const scheduledService=new InvestService(new LocalScopedStore(db),writer,writer,{
    async getKillSwitch(){return{engaged:false,reason:null,changedBy:null,changedAt:null};},
  },inbox);
  const runId='019a0000-0000-7000-8000-000000000712';
  const context:TrustedFlowStepContext={tenantId,workspaceId,principalId:userId,workflowId:'019a0000-0000-7000-8000-000000000713',runId,
    trigger:'schedule',stepId:'custody-daily',stepIndex:0,attempt:0,scheduledFor:new Date().toISOString(),dispatchId:`${runId}:0:0`};
  await expect(scheduledService.dispatchScheduledCustody(context)).rejects.toThrow(/content hash/);
  const partial=await db.query<{status:string;attempts:number}>(`SELECT status,attempts FROM invest_custody_dispatches WHERE tenant_id=$1 AND workspace_id=$2 AND workflow_id=$3`,[tenantId,workspaceId,context.workflowId]);
  expect(partial.rows).toEqual([{status:'failed',attempts:1}]);
  const preserved=await db.query<{count:number}>(`SELECT count(*)::int AS count FROM invest_reconciliation_runs WHERE tenant_id=$1 AND workspace_id=$2 AND source_ref=$3`,[tenantId,workspaceId,statement.sourceRef]);
  expect(preserved.rows[0]?.count).toBe(1);
  eligible=[input,matchingInput];
  const first=await scheduledService.dispatchScheduledCustody(context);
  expect(first).toMatchObject({status:'completed',idempotent:false,inputs:[
    {statementId:statement.id,reconciliation:'needs_review',discrepancyCount:1},
    {statementId:matching.id,reconciliation:'matched',discrepancyCount:0},
  ]});
  const second=await scheduledService.dispatchScheduledCustody(context);
  expect(second).toEqual({...first,idempotent:true});
  expect(inbox.listEligible).toHaveBeenCalledTimes(2);
  expect(inbox.acknowledgeProcessed).toHaveBeenCalledTimes(2);
  const rows=await db.query<{status:string;attempts:number;discrepancies:number}>(`SELECT d.status,d.attempts,
      (SELECT count(*)::int FROM invest_reconciliation_discrepancies x WHERE x.tenant_id=d.tenant_id AND x.workspace_id=d.workspace_id AND x.run_id=(d.result->'inputs'->0->>'runId')::uuid) AS discrepancies
    FROM invest_custody_dispatches d WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.workflow_id=$3`,[tenantId,workspaceId,context.workflowId]);
  expect(rows.rows).toEqual([{status:'completed',attempts:2,discrepancies:1}]);

  const missingAdapter=new InvestService(new LocalScopedStore(db),writer,writer,{
    async getKillSwitch(){return{engaged:false,reason:null,changedBy:null,changedAt:null};},
  });
  const unavailableContext={...context,workflowId:'019a0000-0000-7000-8000-000000000714'};
  await expect(missingAdapter.dispatchScheduledCustody(unavailableContext)).rejects.toThrow('INVEST_CUSTODY_CONNECTOR_UNAVAILABLE');
  await expect(db.query<{status:string;error_code:string}>(`SELECT status,error_code FROM invest_custody_dispatches WHERE tenant_id=$1 AND workspace_id=$2 AND workflow_id=$3`,
    [tenantId,workspaceId,unavailableContext.workflowId])).resolves.toMatchObject({rows:[{status:'connector_unavailable',error_code:'INVEST_CUSTODY_CONNECTOR_UNAVAILABLE'}]});
});

test('global kill reader absence, engagement and read failure all block new PAPER proposals', async () => {
  const scope={tenantId,workspaceId};
  const unavailable=new InvestService(new LocalScopedStore(db),writer,writer);
  await expect(unavailable.propose(scope,userId,{portfolioId,instrumentId,side:'buy',orderType:'market',stopPriceUnits:'9000',riskBps:50,idempotencyKey:'no-global-reader'}))
    .rejects.toThrow('INVEST_GLOBAL_KILL_SWITCH_UNAVAILABLE');
  globalKillEngaged=true;
  await expect(service.propose(scope,userId,{portfolioId,instrumentId,side:'buy',orderType:'market',stopPriceUnits:'9000',riskBps:50,idempotencyKey:'global-halted'}))
    .rejects.toThrow('INVEST_GLOBAL_KILL_SWITCH_ENGAGED');
  globalKillEngaged=false; globalKillReadFails=true;
  try {
    await expect(service.propose(scope,userId,{portfolioId,instrumentId,side:'buy',orderType:'market',stopPriceUnits:'9000',riskBps:50,idempotencyKey:'global-read-failure'}))
      .rejects.toThrow('INVEST_GLOBAL_KILL_SWITCH_UNAVAILABLE');
  } finally { globalKillReadFails=false; }
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
  expect(investManifest.permissions).toContain('invest:signal:consume');
  expect(investManifest.roleGrants.owner).toContain('invest:signal:consume');
  expect(investManifest.roleGrants.admin).toContain('invest:signal:consume');
  expect(investManifest.roleGrants.manager).not.toContain('invest:signal:consume');
  expect(Object.values(investCapabilities).some((capability)=>capability.permission==='invest:signal:consume')).toBe(false);
});
