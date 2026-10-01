'use client';

import { useState } from 'react';
import { Activity, AlertTriangle, ArrowDownUp, BriefcaseBusiness, CircleDollarSign, FlaskConical, Plus, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react';
import { useCapability } from '@xyra/sdk';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, Panel } from '@xyra/ui';
import { investCapabilities as caps } from '../contracts';

type Portfolio = { id: string; name: string; base_asset: string; book_id: string; environment: 'paper'; status: string };
type Instrument = { id: string; symbol: string; asset_class: string; quantity_scale: number; exchange_code: string|null };
type Order = { id:string; portfolio_id:string; instrument_id:string; symbol:string; side:'buy'|'sell'; order_type:'market'|'limit'; quantity_units:string; filled_units:string; limit_price_units:string|null; status:string; environment:'paper'; created_at:string };
type ICMemo = { id:string; portfolio_id:string; version:number; title:string; status:'draft'|'in_review'|'approved'|'rejected'|'expired'; approvals:number; rejections:number; recusals:number; created_at:string };
type Breach = { id:string; portfolio_id:string; instrument_id:string|null; kind:string; severity:'warning'|'high'|'critical'; status:'open'|'acknowledged'|'resolved'; owner_id:string|null; detail:Record<string,unknown>; opened_at:string };
type ReconciliationDiscrepancy = { id:string; run_id:string; portfolio_id:string; source_name:string; source_ref:string; statement_date:string; discrepancy_key:string; kind:'cash_mismatch'|'position_mismatch'|'unknown_position'; expected_units:string; observed_units:string; difference_units:string; owner_id:string; created_at:string };
type Summary = { portfolioId:string; environment:'paper'; cashUnits:string; navUnits:string; positions:Array<{instrumentId:string;symbol:string;quantityUnits:string;priceUnits:string;marketValueUnits:string}> };

function PaperBanner() {
  return <div role="note" className="flex items-center gap-2 rounded-md border border-caution/30 bg-caution/10 px-3 py-2 text-sm text-caution">
    <FlaskConical aria-hidden className="size-4" /><strong>PAPER ONLY</strong><span>Simulated orders and isolated portfolio books. No live broker route is available.</span>
  </div>;
}

function InvestHome({ workspaceId, api }: ModulePageProps) {
  const portfolios = useCapability<Portfolio[]>(api, workspaceId, caps.portfolios.id);
  const selectedId = portfolios.data?.[0]?.id;
  const summary = useCapability<Summary>(api, workspaceId, caps.summary.id, selectedId ? { portfolioId: selectedId } : undefined);
  const orders = useCapability<Order[]>(api, workspaceId, caps.orders.id, selectedId ? { portfolioId: selectedId } : undefined);
  const [name, setName] = useState('');
  const [baseAsset, setBaseAsset] = useState('USD');
  const [fundUnits, setFundUnits] = useState('');
  const [message, setMessage] = useState<string|null>(null);
  const [working, setWorking] = useState(false);
  const error = portfolios.error ?? summary.error ?? orders.error;
  const refresh = () => { portfolios.refresh(); summary.refresh(); orders.refresh(); };
  async function createPortfolio() {
    if (!api || !workspaceId) return;
    setWorking(true); setMessage(null);
    try { await api.write(workspaceId, caps.createPortfolio.id, { name, baseAsset }); setName(''); refresh(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Portfolio could not be created'); }
    finally { setWorking(false); }
  }
  async function fund() {
    if (!api || !workspaceId || !selectedId) return;
    setWorking(true); setMessage(null);
    try { const result = await api.write<{transactionId:string}>(workspaceId, caps.fundPortfolio.id, { portfolioId: selectedId, units: fundUnits, reference: `UI opening funding ${Date.now()}` }); setMessage(`PAPER journal ${result.transactionId} posted.`); setFundUnits(''); refresh(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Funding journal failed'); }
    finally { setWorking(false); }
  }
  return <div className="space-y-5">
    <PageHeader eyebrow="Invest" title="Portfolio" description="Ledger-derived PAPER cash, positions and valuation." actions={<Button size="sm" onClick={refresh}><RefreshCw aria-hidden className="size-3.5" /> Refresh</Button>} />
    <PaperBanner />
    {error ? <ErrorState error={error} onRetry={refresh} title="Investment data could not be loaded" /> : null}
    {portfolios.loading ? <Panel><LoadingState label="Loading paper portfolios" rows={3} /></Panel> : null}
    {!portfolios.loading && !error && !portfolios.data?.length ? <Panel><EmptyState icon={BriefcaseBusiness} title="Create a PAPER portfolio">No portfolio or sample holdings are created automatically.
      <div className="mt-4 grid w-full max-w-xl gap-3 sm:grid-cols-[1fr_8rem_auto]">
        <label className="space-y-1 text-left text-xs text-fg-muted">Portfolio name<Input aria-label="Portfolio name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></label>
        <label className="space-y-1 text-left text-xs text-fg-muted">Base asset<Input aria-label="Base asset" value={baseAsset} onChange={(event) => setBaseAsset(event.target.value.toUpperCase())} maxLength={32} /></label>
        <span className="self-end"><Button loading={working} disabled={!name.trim()} onClick={() => void createPortfolio()}><Plus aria-hidden className="size-4" /> Create</Button></span>
      </div>{message ? <p role="alert" className="mt-2 text-sm text-negative">{message}</p> : null}
    </EmptyState></Panel> : null}
    {selectedId && summary.loading ? <Panel><LoadingState label="Loading ledger projection" rows={3} /></Panel> : null}
    {summary.data ? <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric title="Paper NAV" value={`${portfolios.data?.[0]?.base_asset ?? ''} ${summary.data.navUnits}`} icon={TrendingUp} />
        <Metric title="Cash balance" value={`${portfolios.data?.[0]?.base_asset ?? ''} ${summary.data.cashUnits}`} icon={CircleDollarSign} />
        <Metric title="Open orders" value={orders.data?.filter((order) => ['proposed','approved','submitted','partially_filled'].includes(order.status)).length ?? 0} icon={Activity} />
      </div>
      <Panel title="Ledger-backed positions" description="Quantities come from the PAPER ledger projection; market values use the latest received quote.">
        {summary.data.positions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase tracking-wide text-fg-subtle"><tr><th className="pb-2">Instrument</th><th className="pb-2 text-right">Quantity units</th><th className="pb-2 text-right">Price units</th><th className="pb-2 text-right">Market value units</th></tr></thead>
          <tbody className="divide-y divide-line">{summary.data.positions.map((position) => <tr key={position.instrumentId}><td className="py-2 font-medium">{position.symbol}</td><td className="py-2 text-right font-mono">{position.quantityUnits}</td><td className="py-2 text-right font-mono">{position.priceUnits}</td><td className="py-2 text-right font-mono">{position.marketValueUnits}</td></tr>)}</tbody></table></div>
          : <EmptyState icon={ArrowDownUp} title="No PAPER positions">Approved and filled paper orders will appear here after their atomic ledger posting.</EmptyState>}
      </Panel>
      <Panel title="Opening PAPER cash" description="This creates a balanced PAPER-only opening journal; amounts are integer minor units.">
        <div className="flex max-w-lg items-end gap-3"><label className="flex-1 space-y-1 text-xs text-fg-muted">{portfolios.data?.[0]?.base_asset ?? 'Asset'} minor units<Input aria-label="PAPER funding minor units" inputMode="numeric" value={fundUnits} onChange={(event) => setFundUnits(event.target.value)} /></label><Button loading={working} disabled={!/^[1-9]\d{0,37}$/.test(fundUnits)} onClick={() => void fund()}>Record funding</Button></div>
        {message ? <p role="status" className="mt-2 text-sm text-fg-muted">{message}</p> : null}
      </Panel>
    </> : null}
  </div>;
}

function OrdersPage({ workspaceId, api }: ModulePageProps) {
  const portfolios = useCapability<Portfolio[]>(api, workspaceId, caps.portfolios.id);
  const instruments = useCapability<Instrument[]>(api, workspaceId, caps.instruments.id);
  const orders = useCapability<Order[]>(api, workspaceId, caps.orders.id);
  const portfolioId = portfolios.data?.[0]?.id;
  const [instrumentId, setInstrumentId] = useState('');
  const [side, setSide] = useState<'buy'|'sell'>('buy');
  const [orderType, setOrderType] = useState<'market'|'limit'>('market');
  const [stop, setStop] = useState('');
  const [limit, setLimit] = useState('');
  const [riskBps, setRiskBps] = useState('50');
  const [fillQuantities, setFillQuantities] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState<string|null>(null);
  const refresh = () => { portfolios.refresh(); instruments.refresh(); orders.refresh(); };
  async function call(id: string, input: unknown) {
    if (!api || !workspaceId) return;
    setBusy(id); setError(null);
    try { await api.write(workspaceId, id, input); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Paper order action failed'); }
    finally { setBusy(null); }
  }
  async function propose() {
    if (!portfolioId || !api || !workspaceId) return;
    await call(caps.propose.id, { portfolioId, instrumentId, side, orderType, ...(orderType === 'limit' ? { limitPriceUnits: limit } : {}), stopPriceUnits: stop, riskBps: Number(riskBps), idempotencyKey: crypto.randomUUID() });
  }
  const selected = instruments.data?.find((item) => item.id === instrumentId);
  const loading = portfolios.loading || instruments.loading || orders.loading;
  const errorValue = error ?? portfolios.error ?? instruments.error ?? orders.error;
  return <div className="space-y-5">
    <PageHeader eyebrow="Invest / execution" title="Paper orders" description="Risk sizes each order from current ledger positions, mandate and market data." actions={<Button size="sm" onClick={refresh}><RefreshCw aria-hidden className="size-3.5" /> Refresh</Button>} />
    <PaperBanner />
    {errorValue ? <ErrorState error={errorValue} onRetry={refresh} title="Paper order request failed" /> : null}
    <Panel title="Propose a PAPER order" description="Order quantity is computed server-side. Research agents cannot approve or execute orders.">
      {!portfolioId || !instruments.data?.length ? <EmptyState icon={ArrowDownUp} title="Portfolio setup is incomplete">Create a portfolio and instrument, record a current quote, fund the PAPER book and approve an active mandate first.</EmptyState> :
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="space-y-1 text-xs text-fg-muted">Instrument<select className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={instrumentId} onChange={(event) => setInstrumentId(event.target.value)}><option value="">Choose instrument</option>{instruments.data.map((item) => <option key={item.id} value={item.id}>{item.symbol}</option>)}</select></label>
          <label className="space-y-1 text-xs text-fg-muted">Side<select className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={side} onChange={(event) => setSide(event.target.value as 'buy'|'sell')}><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
          <label className="space-y-1 text-xs text-fg-muted">Order type<select className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={orderType} onChange={(event) => setOrderType(event.target.value as 'market'|'limit')}><option value="market">Market</option><option value="limit">Limit</option></select></label>
          <label className="space-y-1 text-xs text-fg-muted">Stop price units<Input aria-label="Stop price units" inputMode="numeric" value={stop} onChange={(event) => setStop(event.target.value)} /></label>
          {orderType === 'limit' ? <label className="space-y-1 text-xs text-fg-muted">Limit price units<Input aria-label="Limit price units" inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value)} /></label> : null}
          <label className="space-y-1 text-xs text-fg-muted">Risk budget (bps)<Input aria-label="Risk budget basis points" type="number" min={1} max={1000} value={riskBps} onChange={(event) => setRiskBps(event.target.value)} /></label>
          <span className="self-end"><Button loading={busy === caps.propose.id} disabled={!instrumentId || !/^[1-9]\d*$/.test(stop) || (orderType === 'limit' && !/^[1-9]\d*$/.test(limit))} onClick={() => void propose()}><Plus aria-hidden className="size-4" /> Run risk check</Button></span>
          {selected ? <p className="self-center text-xs text-fg-subtle">Quantity derives from {selected.symbol} quote, active mandate and ledger state.</p> : null}
        </div>}
    </Panel>
    <Panel title="Order history" description="Every status transition is retained in the order event journal.">
      {loading ? <LoadingState label="Loading paper orders" rows={4} /> : null}
      {!loading && !orders.data?.length ? <EmptyState icon={Activity} title="No PAPER orders yet">Risk-cleared proposals and simulator fills will be recorded here.</EmptyState> : null}
      {orders.data?.length ? <div className="divide-y divide-line">{orders.data.map((order) => <div key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div><p className="font-medium">{order.side.toUpperCase()} {order.symbol} <Badge tone={order.status === 'filled' ? 'positive' : order.status === 'cancelled' ? 'neutral' : 'caution'}>{order.status}</Badge></p><p className="mt-1 font-mono text-xs text-fg-muted">{order.filled_units}/{order.quantity_units} units filled · {order.order_type} · PAPER</p></div>
        <div className="flex flex-wrap items-end gap-2">{order.status === 'proposed' ? <Button size="sm" loading={busy === caps.approve.id} onClick={() => void call(caps.approve.id, { orderId: order.id })}>Approve</Button> : null}{['approved','partially_filled'].includes(order.status) ? <><label className="space-y-1 text-xs text-fg-muted">Fill units (blank = all remaining)<Input aria-label={`PAPER fill units for ${order.symbol}`} inputMode="numeric" value={fillQuantities[order.id] ?? ''} onChange={(event) => setFillQuantities((current) => ({ ...current,[order.id]:event.target.value }))} /></label><Button size="sm" loading={busy === caps.execute.id} disabled={Boolean(fillQuantities[order.id] && !/^[1-9]\d{0,37}$/.test(fillQuantities[order.id] ?? ''))} onClick={() => void call(caps.execute.id, { orderId: order.id, ...(fillQuantities[order.id] ? { quantityUnits:fillQuantities[order.id] } : {}) })}>Simulate fill</Button></> : null}{['proposed','approved','submitted','partially_filled'].includes(order.status) ? <Button size="sm" variant="secondary" loading={busy === caps.cancel.id} onClick={() => void call(caps.cancel.id, { orderId: order.id })}>Cancel</Button> : null}</div>
      </div>)}</div> : null}
    </Panel>
  </div>;
}

function RiskAndMandates({ workspaceId, api }: ModulePageProps) {
  const portfolios = useCapability<Portfolio[]>(api, workspaceId, caps.portfolios.id);
  const instruments = useCapability<Instrument[]>(api, workspaceId, caps.instruments.id);
  const memoQueue = useCapability<ICMemo[]>(api, workspaceId, caps.icQueue.id);
  const breaches = useCapability<Breach[]>(api, workspaceId, caps.breaches.id);
  const reconciliationQueue = useCapability<ReconciliationDiscrepancy[]>(api, workspaceId, caps.reconciliationQueue.id);
  const [symbol, setSymbol] = useState(''); const [exchange, setExchange] = useState(''); const [price, setPrice] = useState('');
  const [memoTitle, setMemoTitle] = useState(''); const [thesis, setThesis] = useState(''); const [sourceRef, setSourceRef] = useState('');
  const [policy, setPolicy] = useState({ maxOrderNotionalUnits:'1000', maxPositionNotionalUnits:'100000000', maxDailyLossUnits:'1000000', maxOrdersPerHour:'10',
    maxPriceDeviationBps:'500', quoteFreshnessSeconds:'300', duplicateWindowSeconds:'60', maxConcentrationBps:'5000', maxCorrelatedExposureBps:'10000',
    maxLeverageBps:'10000', maxDrawdownBps:'2000', targetVolatilityBps:'2000', blockedSymbols:'', watchSymbols:'' });
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string|null>(null);
  const [marketSession, setMarketSession] = useState(true);
  const [statementSource, setStatementSource] = useState('Manual custodian statement');
  const [statementRef, setStatementRef] = useState('');
  const [statementCash, setStatementCash] = useState('0');
  const [statementPositions, setStatementPositions] = useState('[]');
  const selectedPortfolio = portfolios.data?.[0];
  async function write(id: string, input: unknown) {
    if (!api || !workspaceId) return;
    setBusy(true); setMessage(null);
    try { await api.write(workspaceId, id, input); setMessage('Saved.'); portfolios.refresh(); instruments.refresh(); memoQueue.refresh(); breaches.refresh(); reconciliationQueue.refresh(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Investment configuration failed'); }
    finally { setBusy(false); }
  }
  async function registerInstrument() {
    if (!api || !workspaceId) return;
    setBusy(true); setMessage(null);
    try {
      const assetClass = 'equity';
      const instrument = await api.write<{id:string;symbol:string}>(workspaceId, caps.createInstrument.id, { symbol, assetClass, quantityScale: 6, exchangeCode: exchange || null });
      const payload = new TextEncoder().encode(`${instrument.symbol}:${price}:${new Date().toISOString()}`);
      const digest = await crypto.subtle.digest('SHA-256', payload);
      const payloadHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
      await api.write(workspaceId, caps.recordPrice.id, { instrumentId: instrument.id, priceUnits: price, source: 'manual-paper-input', sourceAt: new Date().toISOString(), volatilityBps: 1000, payloadHash });
      if (exchange) await api.write(workspaceId, caps.recordMarketSession.id, { exchangeCode: exchange, sessionDate: new Date().toISOString().slice(0,10), opensAt: new Date(Date.now()-60_000).toISOString(), closesAt: new Date(Date.now()+6*60*60_000).toISOString(), isOpen: marketSession, source: 'manual-paper-calendar' });
      setSymbol(''); setPrice(''); setMessage(`${instrument.symbol} was recorded with a manual PAPER quote; no external feed was contacted.`); instruments.refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Instrument setup failed'); }
    finally { setBusy(false); }
  }
  async function createMandate() {
    if (!selectedPortfolio || !instruments.data?.length || !api || !workspaceId) return;
    const payload = new TextEncoder().encode(sourceRef.trim());
    const digest = await crypto.subtle.digest('SHA-256', payload);
    const sourceHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
    const policyTextKeys = ['maxOrderNotionalUnits','maxPositionNotionalUnits','maxDailyLossUnits'] as const;
    const policyNumberKeys = ['maxOrdersPerHour','maxPriceDeviationBps','quoteFreshnessSeconds','duplicateWindowSeconds','maxConcentrationBps','maxCorrelatedExposureBps','maxLeverageBps','maxDrawdownBps','targetVolatilityBps'] as const;
    if (policyTextKeys.some((key)=>!/^([1-9]\d{0,37})$/.test(policy[key])) || policyNumberKeys.some((key)=>!/^\d+$/.test(policy[key]))) {
      setMessage('Risk values must be positive canonical integers.'); return;
    }
    const symbols = (value:string) => [...new Set(value.split(',').map((item)=>item.trim().toUpperCase()).filter(Boolean))];
    await write(caps.createMandate.id, { portfolioId: selectedPortfolio.id, version: Math.max(0, ...(memoQueue.data?.filter((memo) => memo.portfolio_id === selectedPortfolio.id).map((memo) => memo.version) ?? [])) + 1,
      title: memoTitle, thesis, sources: [{ label: 'User supplied research reference', ref: sourceRef, sha256: sourceHash }],
      effectiveFrom: new Date(Date.now()-60_000).toISOString(), effectiveUntil: null,
      allowedAssetClasses: ['equity'], allowedInstrumentIds: instruments.data.map((instrument) => instrument.id), benchmark: 'PAPER-CASH',
      limits: { maxOrderNotionalUnits:policy.maxOrderNotionalUnits, maxPositionNotionalUnits:policy.maxPositionNotionalUnits, maxDailyLossUnits:policy.maxDailyLossUnits,
        maxOrdersPerHour:Number(policy.maxOrdersPerHour), maxPriceDeviationBps:Number(policy.maxPriceDeviationBps), quoteFreshnessSeconds:Number(policy.quoteFreshnessSeconds),
        duplicateWindowSeconds:Number(policy.duplicateWindowSeconds), maxConcentrationBps:Number(policy.maxConcentrationBps), maxCorrelatedExposureBps:Number(policy.maxCorrelatedExposureBps),
        maxLeverageBps:Number(policy.maxLeverageBps), maxDrawdownBps:Number(policy.maxDrawdownBps), targetVolatilityBps:Number(policy.targetVolatilityBps),
        blockedSymbols:symbols(policy.blockedSymbols), watchSymbols:symbols(policy.watchSymbols) } });
  }
  async function voteMemo(memoId: string, vote: 'approve'|'reject'|'recuse') {
    await write(caps.voteMemo.id, { memoId, vote, reason: vote === 'approve' ? 'Reviewed source-cited thesis and risk policy' : vote === 'reject' ? 'IC review rejected this mandate draft' : 'IC member recused from this decision' });
  }
  async function activateMemo(memoId: string) { await write(caps.activateMandate.id, { memoId }); }
  async function reconcileStatement() {
    if (!selectedPortfolio || !api || !workspaceId) return;
    let positions: Array<{symbol:string;units:string}>;
    try { positions = (JSON.parse(statementPositions) as Array<{symbol:string;units:string}>).map((position)=>({symbol:position.symbol.trim().toUpperCase(),units:position.units})).sort((a,b)=>a.symbol.localeCompare(b.symbol)); }
    catch { setMessage('Positions must be valid JSON, for example [{"symbol":"ACME","units":"100"}].'); return; }
    const statementDate = new Date().toISOString().slice(0,10);
    const canonical = JSON.stringify({portfolioId:selectedPortfolio.id,source:statementSource,ref:statementRef,statementDate,cashUnits:statementCash,positions});
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const statementHash = [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
    setBusy(true); setMessage(null);
    try {
      const result = await api.write<{runId:string;status:'matched'|'needs_review';discrepancyCount:number;idempotent:boolean}>(workspaceId,caps.reconcileStatement.id,
        {portfolioId:selectedPortfolio.id,sourceName:statementSource,sourceRef:statementRef,statementDate,statementHash,cashUnits:statementCash,positions});
      setMessage(`Statement reconciliation ${result.status}; ${result.discrepancyCount} discrepancies${result.idempotent ? ' (existing run)' : ''}. Run ${result.runId}.`);
      reconciliationQueue.refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Statement reconciliation failed'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader eyebrow="Invest / controls" title="Risk and mandates" description="Versioned portfolio policy and fail-closed market calendar inputs." />
    <PaperBanner />
    <Panel title="Register instrument and quote" description="Manual PAPER inputs are clearly labelled; they do not represent a connected market feed.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="space-y-1 text-xs text-fg-muted">Symbol<Input aria-label="Instrument symbol" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label><label className="space-y-1 text-xs text-fg-muted">Exchange<Input aria-label="Exchange code" value={exchange} onChange={(event) => setExchange(event.target.value.toUpperCase())} /></label><label className="space-y-1 text-xs text-fg-muted">Price minor units<Input aria-label="Price minor units" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={marketSession} onChange={(event) => setMarketSession(event.target.checked)} />Market session open today</label></div>
      <Button className="mt-3" loading={busy} disabled={!symbol.trim() || !/^[1-9]\d*$/.test(price)} onClick={() => void registerInstrument()}><Plus aria-hidden className="size-4" /> Record manual PAPER quote</Button>
    </Panel>
    <Panel title="Investment policy memo" description="Agents can draft source-cited policy memos. Direct owner/admin votes require two independent approvals before a versioned mandate activates.">
      {!selectedPortfolio ? <EmptyState icon={ShieldCheck} title="Create a portfolio first">Investment mandates are scoped to one PAPER portfolio.</EmptyState> : <div className="grid gap-3 sm:grid-cols-2">
        <p className="text-sm sm:col-span-2">Portfolio: <strong>{selectedPortfolio.name}</strong></p>
        <label className="space-y-1 text-xs text-fg-muted">Memo title<Input aria-label="Memo title" value={memoTitle} onChange={(event) => setMemoTitle(event.target.value)} maxLength={240} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Source reference<Input aria-label="Source reference" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} maxLength={1000} /></label>
        <label className="space-y-1 text-xs text-fg-muted sm:col-span-2">Investment thesis<textarea aria-label="Investment thesis" className="min-h-20 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg" value={thesis} onChange={(event) => setThesis(event.target.value)} maxLength={20000} /></label>
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">
          {(['maxOrderNotionalUnits','maxPositionNotionalUnits','maxDailyLossUnits'] as const).map((key)=><label key={key} className="space-y-1 text-xs text-fg-muted">{key.replace(/([A-Z])/g,' $1')} (minor units)<Input aria-label={key} inputMode="numeric" value={policy[key]} onChange={(event)=>setPolicy((current)=>({...current,[key]:event.target.value}))} /></label>)}
          {(['maxOrdersPerHour','maxPriceDeviationBps','quoteFreshnessSeconds','duplicateWindowSeconds','maxConcentrationBps','maxCorrelatedExposureBps','maxLeverageBps','maxDrawdownBps','targetVolatilityBps'] as const).map((key)=><label key={key} className="space-y-1 text-xs text-fg-muted">{key.replace(/([A-Z])/g,' $1')}<Input aria-label={key} inputMode="numeric" value={policy[key]} onChange={(event)=>setPolicy((current)=>({...current,[key]:event.target.value}))} /></label>)}
          <label className="space-y-1 text-xs text-fg-muted">Restricted symbols, comma-separated<Input aria-label="Restricted symbols" value={policy.blockedSymbols} onChange={(event)=>setPolicy((current)=>({...current,blockedSymbols:event.target.value}))} placeholder="ACME, XYZ" /></label>
          <label className="space-y-1 text-xs text-fg-muted">Watch symbols, comma-separated<Input aria-label="Watch symbols" value={policy.watchSymbols} onChange={(event)=>setPolicy((current)=>({...current,watchSymbols:event.target.value}))} placeholder="ABC, QRS" /></label>
        </div>
        <span className="self-end"><Button loading={busy} disabled={!memoTitle.trim() || !thesis.trim() || !sourceRef.trim() || !/^[1-9]\d{0,37}$/.test(policy.maxOrderNotionalUnits)} onClick={() => void createMandate()}>Submit for IC review</Button></span>
      </div>}
      {message ? <p role="status" className="mt-3 text-sm text-fg-muted">{message}</p> : null}
    </Panel>
    <Panel title="IC decision queue" description="Votes are append-only. Recusals are retained and do not count toward quorum.">
      {memoQueue.loading ? <LoadingState label="Loading IC decisions" rows={3} /> : null}
      {!memoQueue.loading && !memoQueue.data?.length ? <EmptyState icon={ShieldCheck} title="No committee memos">Policy drafts submitted for review will appear here.</EmptyState> : null}
      {memoQueue.data?.map((memo) => <div key={memo.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-0"><div><p className="font-medium">{memo.title} <Badge tone={memo.status === 'approved' ? 'positive' : memo.status === 'rejected' ? 'negative' : 'caution'}>{memo.status}</Badge></p><p className="font-mono text-xs text-fg-muted">v{memo.version} · approve {memo.approvals}/2 · reject {memo.rejections} · recuse {memo.recusals}</p></div>{memo.status === 'in_review' ? <div className="flex gap-2"><Button size="sm" variant="secondary" loading={busy} onClick={() => void voteMemo(memo.id,'approve')}>Approve vote</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => void voteMemo(memo.id,'recuse')}>Recuse</Button>{memo.approvals >= 2 && memo.rejections === 0 ? <Button size="sm" loading={busy} onClick={() => void activateMemo(memo.id)}>Activate mandate</Button> : null}</div> : null}</div>)}
    </Panel>
    <Panel title="Post-trade alert queue" description="Alerts are durable records; assignment, acknowledgement and resolution are owner-attributed and append-only.">
      {breaches.loading ? <LoadingState label="Loading breach alerts" rows={2} /> : null}
      {breaches.error ? <ErrorState error={breaches.error} onRetry={breaches.refresh} title="Breach queue could not be loaded" /> : null}
      {!breaches.loading && !breaches.error && !breaches.data?.length ? <EmptyState icon={ShieldCheck} title="No open risk alerts">New post-trade limit breaches will appear here.</EmptyState> : null}
      {breaches.data?.map((breach) => <div key={breach.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-0"><div><p className="font-medium">{breach.kind} <Badge tone={breach.severity === 'critical' ? 'negative' : 'caution'}>{breach.severity}</Badge> <Badge tone={breach.status === 'acknowledged' ? 'positive' : 'caution'}>{breach.status}</Badge></p><p className="font-mono text-xs text-fg-muted">{breach.opened_at} · owner {breach.owner_id ?? 'unassigned'}</p></div><div className="flex gap-2">{breach.status === 'open' && !breach.owner_id ? <Button size="sm" variant="secondary" loading={busy} onClick={() => void write(caps.manageBreach.id,{breachId:breach.id,action:'assign',reason:'Owner accepted responsibility for risk alert'})}>Assign to me</Button> : null}{breach.status === 'open' && breach.owner_id ? <Button size="sm" variant="secondary" loading={busy} onClick={() => void write(caps.manageBreach.id,{breachId:breach.id,action:'acknowledge',reason:'Owner reviewed the alert'})}>Acknowledge</Button> : null}{breach.status === 'acknowledged' ? <Button size="sm" loading={busy} onClick={() => void write(caps.manageBreach.id,{breachId:breach.id,action:'resolve',reason:'Owner resolved the underlying PAPER risk condition'})}>Resolve</Button> : null}</div></div>)}
    </Panel>
    <Panel title="Reconcile a PAPER custodian statement" description="Upload data by entering an external statement snapshot; matching uses exact minor-unit strings. This local workflow does not connect to a custodian.">
      {!selectedPortfolio ? <p className="text-sm text-fg-muted">Create a PAPER portfolio before reconciling a statement.</p> : <div className="space-y-3">
        <label className="block space-y-1 text-xs text-fg-muted">Statement source<Input aria-label="Statement source" value={statementSource} onChange={(event)=>setStatementSource(event.target.value)} maxLength={120} /></label>
        <label className="block space-y-1 text-xs text-fg-muted">Statement reference<Input aria-label="Statement reference" value={statementRef} onChange={(event)=>setStatementRef(event.target.value)} maxLength={500} /></label>
        <label className="block max-w-xs space-y-1 text-xs text-fg-muted">Cash units in {selectedPortfolio.base_asset}<Input aria-label="Statement cash units" inputMode="numeric" value={statementCash} onChange={(event)=>setStatementCash(event.target.value)} /></label>
        <label className="block space-y-1 text-xs text-fg-muted">Position snapshot JSON (symbol and integer minor units)<textarea aria-label="Statement positions" className="min-h-24 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-fg" value={statementPositions} onChange={(event)=>setStatementPositions(event.target.value)} /></label>
        <Button loading={busy} disabled={!statementSource.trim() || !statementRef.trim() || !/^-?(0|[1-9]\d{0,37})$/.test(statementCash)} onClick={()=>void reconcileStatement()}>Compare and record statement</Button>
        {message ? <p role="status" className="text-sm text-fg-muted">{message}</p> : null}
      </div>}
    </Panel>
    <Panel title="Reconciliation discrepancy queue" description="Immutable mismatches retain the submitting owner; corrections must be recorded as forward journals with a new statement run.">
      {reconciliationQueue.loading ? <LoadingState label="Loading reconciliation discrepancies" rows={2} /> : null}
      {reconciliationQueue.error ? <ErrorState error={reconciliationQueue.error} onRetry={reconciliationQueue.refresh} title="Reconciliation queue could not be loaded" /> : null}
      {!reconciliationQueue.loading && !reconciliationQueue.error && !reconciliationQueue.data?.length ? <EmptyState icon={ShieldCheck} title="No reconciliation discrepancies">Mismatches from statement comparisons will be assigned to the submitting owner and listed here.</EmptyState> : null}
      {reconciliationQueue.data?.map((item) => <div key={item.id} className="border-b border-line py-3 last:border-0"><p className="font-medium">{item.kind}: {item.discrepancy_key} <Badge tone="caution">needs review</Badge></p><p className="mt-1 text-xs text-fg-muted">{item.source_name} · {item.source_ref} · {item.statement_date} · owner id {item.owner_id}</p><p className="font-mono text-xs text-fg-muted">expected {item.expected_units} · observed {item.observed_units} · difference {item.difference_units} · run {item.run_id}</p></div>)}
    </Panel>
    {selectedPortfolio ? <KillSwitch workspaceId={workspaceId} api={api} portfolioId={selectedPortfolio.id} /> : null}
    <Panel title="Instruments" description="Registered instruments and scale used by deterministic sizing.">{instruments.data?.length ? <ul className="divide-y divide-line">{instruments.data.map((instrument) => <li className="flex justify-between py-2 text-sm" key={instrument.id}><span>{instrument.symbol} · {instrument.asset_class}</span><span className="font-mono text-xs text-fg-muted">scale {instrument.quantity_scale} · {instrument.exchange_code ?? '24/7'}</span></li>)}</ul> : <EmptyState icon={AlertTriangle} title="No instruments configured">Register a paper instrument above before proposing an order.</EmptyState>}</Panel>
  </div>;
}

function KillSwitch({ workspaceId, api, portfolioId }: { workspaceId:string|null; api:ModulePageProps['api']; portfolioId:string }) {
  const state = useCapability<{portfolioId:string;killSwitch:boolean;killReason:string|null;dailyLossUnits:string;riskDate:string}>(api, workspaceId, caps.riskState.id, { portfolioId });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string|null>(null);
  const engaged = state.data?.killSwitch ?? false;
  async function toggle() { if (!api || !workspaceId || !state.data) return; setBusy(true); setError(null); try { await api.write(workspaceId, caps.killSwitch.id, { portfolioId, engaged: !engaged, reason: engaged ? 'Owner explicitly resumed PAPER trading' : 'Owner engaged portfolio kill switch' }); state.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Kill switch update failed'); } finally { setBusy(false); } }
  return <Panel title="Portfolio trading kill switch" description="Engaging halts proposals and cancels open orders. Resuming requires an explicit action.">{state.error ? <ErrorState error={state.error} onRetry={state.refresh} title="Risk state could not be loaded" /> : state.loading || !state.data ? <LoadingState label="Loading persisted PAPER risk state" rows={1} /> : <><div className="flex items-center justify-between gap-3"><span className="text-sm">{engaged ? <Badge tone="negative">HALTED</Badge> : <Badge tone="positive">ACTIVE</Badge>}{engaged && state.data.killReason ? <span className="ml-2 text-fg-muted">{state.data.killReason}</span> : null}</span><Button variant={engaged ? 'primary' : 'secondary'} loading={busy} onClick={() => void toggle()}>{engaged ? 'Explicitly resume PAPER' : 'Halt PAPER trading'}</Button></div><p className="mt-2 text-xs text-fg-muted">Daily loss: {state.data.dailyLossUnits} minor units · {state.data.riskDate}</p></>}{error ? <p role="alert" className="mt-2 text-sm text-negative">{error}</p> : null}</Panel>;
}

type BacktestReply = {runId:string;engineVersion:string;dataVersion:number;strategyId:string;strategyVersion:number;dataHash:string;strategyHash:string;trades:Array<{entryBar:number;exitBar:number;entryPriceUnits:string;exitPriceUnits:string;quantityUnits:string;grossPnlUnits:string;feesUnits:string;netPnlUnits:string;exitReason:string}>;totalFeesUnits:string;netPnlUnits:string};
function BacktestsPage({workspaceId,api}:ModulePageProps) {
  const instruments = useCapability<Instrument[]>(api,workspaceId,caps.instruments.id);
  const [instrumentId,setInstrumentId] = useState(''); const [dataVersion,setDataVersion] = useState('1');
  const [sourceName,setSourceName] = useState('User-supplied historical bars'); const [sourceRef,setSourceRef] = useState('');
  const [strategyId,setStrategyId] = useState('momentum-stop-target'); const [strategyVersion,setStrategyVersion] = useState('1');
  const [quantityUnits,setQuantityUnits] = useState('1'); const [stopBps,setStopBps] = useState('500'); const [targetBps,setTargetBps] = useState('1000'); const [feeBps,setFeeBps] = useState('10');
  const [barsJson,setBarsJson] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState<string|null>(null); const [result,setResult] = useState<BacktestReply|null>(null);
  const history = useCapability<Array<{id:string;data_version:number;source_name:string;source_ref:string;data_hash:string;strategy_key:string;strategy_version:number;strategy_hash:string;engine_version:string;total_fees_units:string;net_pnl_units:string;created_at:string}>>(api,workspaceId,caps.backtestRuns.id,instrumentId ? {instrumentId} : undefined);
  async function run() {
    if (!api || !workspaceId || !instrumentId) return;
    let bars:unknown;
    try { bars=JSON.parse(barsJson) as unknown; if (!Array.isArray(bars)) throw new Error('Expected a JSON array'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'OHLC data must be a JSON array'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const response=await api.write<BacktestReply>(workspaceId,caps.runBacktest.id,{instrumentId,dataVersion:Number(dataVersion),sourceName,sourceRef,bars,
        strategy:{id:strategyId,version:Number(strategyVersion),quantityUnits,stopBps:Number(stopBps),targetBps:Number(targetBps),feeBps:Number(feeBps)}});
      setResult(response); history.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PAPER backtest failed'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <PageHeader eyebrow="Invest / research" title="PAPER backtests" description="Reproducible integer-unit OHLC simulations with versioned inputs." />
    <PaperBanner />
    {instruments.error ? <ErrorState error={instruments.error} onRetry={instruments.refresh} title="Instruments could not be loaded" /> : null}
    <Panel title="Versioned input data and strategy" description="OHLC bars are manual/imported evidence. This workflow does not contact a market provider or create orders in a portfolio.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1 text-xs text-fg-muted">Instrument<select className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={instrumentId} onChange={(event)=>setInstrumentId(event.target.value)}><option value="">Choose instrument</option>{instruments.data?.map((item)=><option key={item.id} value={item.id}>{item.symbol}</option>)}</select></label>
        <label className="space-y-1 text-xs text-fg-muted">Dataset version<Input aria-label="Dataset version" inputMode="numeric" value={dataVersion} onChange={(event)=>setDataVersion(event.target.value)} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Data source<Input aria-label="Data source" value={sourceName} onChange={(event)=>setSourceName(event.target.value)} maxLength={120} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Source reference<Input aria-label="Source reference" value={sourceRef} onChange={(event)=>setSourceRef(event.target.value)} maxLength={500} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Strategy key<Input aria-label="Strategy key" value={strategyId} onChange={(event)=>setStrategyId(event.target.value)} maxLength={120} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Strategy version<Input aria-label="Strategy version" inputMode="numeric" value={strategyVersion} onChange={(event)=>setStrategyVersion(event.target.value)} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Quantity units<Input aria-label="Backtest quantity units" inputMode="numeric" value={quantityUnits} onChange={(event)=>setQuantityUnits(event.target.value)} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Stop loss (bps)<Input aria-label="Stop loss basis points" inputMode="numeric" value={stopBps} onChange={(event)=>setStopBps(event.target.value)} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Target (bps)<Input aria-label="Target basis points" inputMode="numeric" value={targetBps} onChange={(event)=>setTargetBps(event.target.value)} /></label>
        <label className="space-y-1 text-xs text-fg-muted">Fee (bps each side)<Input aria-label="Fee basis points" inputMode="numeric" value={feeBps} onChange={(event)=>setFeeBps(event.target.value)} /></label>
      </div>
      <label className="mt-3 block space-y-1 text-xs text-fg-muted">OHLC bars JSON (UTC timestamps, integer price units)<textarea aria-label="OHLC bars JSON" className="min-h-48 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-fg" value={barsJson} onChange={(event)=>setBarsJson(event.target.value)} placeholder={'[{"at":"2026-01-01T00:00:00.000Z","openUnits":"100","highUnits":"105","lowUnits":"95","closeUnits":"100"}, ...]'} /></label>
      <Button className="mt-3" loading={busy} disabled={!instrumentId || !sourceName.trim() || !sourceRef.trim() || !strategyId.trim() || !barsJson.trim()} onClick={()=>void run()}>Run and persist PAPER backtest</Button>
      {error ? <p role="alert" className="mt-2 text-sm text-negative">{error}</p> : null}
    </Panel>
    {result ? <Panel title="Immutable simulation result" description={`Run ${result.runId} · engine ${result.engineVersion} · data v${result.dataVersion} · ${result.strategyId} v${result.strategyVersion}`}>
      <p className="font-mono text-xs text-fg-muted">data {result.dataHash} · strategy {result.strategyHash}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><Metric title="Net P/L units" value={result.netPnlUnits} icon={TrendingUp} /><Metric title="Fees units" value={result.totalFeesUnits} icon={CircleDollarSign} /><Metric title="Trades" value={result.trades.length} icon={Activity} /></div>
      {result.trades.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Bars</th><th>Entry / exit</th><th>Reason</th><th>Gross</th><th>Fees</th><th>Net</th></tr></thead><tbody>{result.trades.map((trade,index)=><tr key={`${trade.entryBar}-${index}`}><td>{trade.entryBar} → {trade.exitBar}</td><td className="font-mono">{trade.entryPriceUnits} / {trade.exitPriceUnits}</td><td>{trade.exitReason}</td><td className="font-mono">{trade.grossPnlUnits}</td><td className="font-mono">{trade.feesUnits}</td><td className="font-mono">{trade.netPnlUnits}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-fg-muted">No entry signal occurred in the supplied bars.</p>}
    </Panel> : null}
    {instrumentId ? <Panel title="Persisted run history" description="Runs are tied to immutable dataset and strategy versions; reusing a version with changed content is rejected.">
      {history.loading ? <LoadingState label="Loading saved backtests" rows={2} /> : null}{history.error ? <ErrorState error={history.error} onRetry={history.refresh} title="Backtest history could not be loaded" /> : null}
      {!history.loading && !history.error && !history.data?.length ? <EmptyState icon={Activity} title="No saved runs for this instrument">Run a versioned simulation to create an immutable result record.</EmptyState> : null}
      {history.data?.map((run)=><div key={run.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 text-sm last:border-0"><span>{run.strategy_key} v{run.strategy_version} on data v{run.data_version} · {run.source_name}</span><span className="font-mono">net {run.net_pnl_units} · fees {run.total_fees_units}</span><span className="font-mono text-xs text-fg-subtle">{run.created_at} · {run.id}</span></div>)}
    </Panel> : null}
  </div>;
}

type PerformanceMarkRow = {id:string;portfolio_id:string;captured_at:string;nav_units:string;cash_units:string;benchmark_index_units:string;benchmark_source:string;benchmark_ref:string;external_flow_units:string;cumulative_fee_units:string};
type PerformanceReportRow = {id:string;portfolio_id:string;created_at:string;report:{calculationVersion:string;fromMarkId:string;toMarkId:string;startNavUnits:string;endNavUnits:string;netExternalFlowUnits:string;feesUnits:string;twrBps:string;benchmarkReturnBps:string;relativeReturnBps:string;markCount:number}};
function PerformancePage({workspaceId,api}:ModulePageProps) {
  const portfolios=useCapability<Portfolio[]>(api,workspaceId,caps.portfolios.id);const portfolio=portfolios.data?.[0];
  const marks=useCapability<PerformanceMarkRow[]>(api,workspaceId,caps.performanceMarks.id,portfolio?{portfolioId:portfolio.id}:undefined);
  const statements=useCapability<PerformanceReportRow[]>(api,workspaceId,caps.performanceStatements.id,portfolio?{portfolioId:portfolio.id}:undefined);
  const [benchmarkIndexUnits,setBenchmarkIndexUnits]=useState('100000');const [benchmarkSource,setBenchmarkSource]=useState('User-supplied benchmark');const [benchmarkRef,setBenchmarkRef]=useState('');
  const [fromMarkId,setFromMarkId]=useState('');const [toMarkId,setToMarkId]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState<string|null>(null);
  async function capture(){if(!api||!workspaceId||!portfolio)return;setBusy(true);setMessage(null);try{const mark=await api.write<PerformanceMarkRow>(workspaceId,caps.capturePerformanceMark.id,{portfolioId:portfolio.id,benchmarkIndexUnits,benchmarkSource,benchmarkRef});
    marks.refresh();statements.refresh();setMessage(`Captured ledger-derived NAV ${mark.nav_units}; external capital flow since prior mark ${mark.external_flow_units}.`);}
    catch(cause){setMessage(cause instanceof Error?cause.message:'Performance mark failed');}finally{setBusy(false);}}
  async function generate(){if(!api||!workspaceId||!portfolio||!fromMarkId||!toMarkId)return;setBusy(true);setMessage(null);try{const statement=await api.write<PerformanceReportRow>(workspaceId,caps.createPerformanceStatement.id,{portfolioId:portfolio.id,fromMarkId,toMarkId});
    statements.refresh();setMessage(`Saved ${statement.report.calculationVersion} statement ${statement.id}.`);}
    catch(cause){setMessage(cause instanceof Error?cause.message:'Statement generation failed');}finally{setBusy(false);}}
  return <div className="space-y-5"><PageHeader eyebrow="Invest / reporting" title="PAPER performance" description="Ledger-derived NAV marks, external flows, fees and benchmark-relative time-weighted return."/><PaperBanner/>
    {!portfolio?<Panel><EmptyState icon={BriefcaseBusiness} title="Create a PAPER portfolio first">Performance marks and statements are portfolio scoped.</EmptyState></Panel>:<>
      <Panel title="Capture a sourced performance mark" description="NAV and cash come from the PAPER ledger; external capital flow and fees are derived from immutable entries. Benchmark values are manually sourced until a provider is connected.">
        <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-xs text-fg-muted">Benchmark index units<Input aria-label="Benchmark index units" inputMode="numeric" value={benchmarkIndexUnits} onChange={(event)=>setBenchmarkIndexUnits(event.target.value)}/></label>
          <label className="space-y-1 text-xs text-fg-muted">Benchmark source<Input aria-label="Benchmark source" value={benchmarkSource} onChange={(event)=>setBenchmarkSource(event.target.value)} maxLength={120}/></label>
          <label className="space-y-1 text-xs text-fg-muted">Source reference<Input aria-label="Benchmark source reference" value={benchmarkRef} onChange={(event)=>setBenchmarkRef(event.target.value)} maxLength={500}/></label></div>
        <Button className="mt-3" loading={busy} disabled={!/^[1-9]\d{0,37}$/.test(benchmarkIndexUnits)||!benchmarkSource.trim()||!benchmarkRef.trim()} onClick={()=>void capture()}>Capture PAPER valuation</Button>
      </Panel>
      <Panel title="Valuation marks" description="Each mark stores the database capture time, sourced benchmark, ledger NAV and net capital flow since the preceding mark.">
        {marks.loading?<LoadingState label="Loading performance marks" rows={2}/>:null}{marks.error?<ErrorState error={marks.error} onRetry={marks.refresh} title="Performance marks could not be loaded"/>:null}
        {marks.data?.map((mark)=><div key={mark.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 text-sm last:border-0"><span>{mark.captured_at} · NAV {mark.nav_units} · cash {mark.cash_units} · flow {mark.external_flow_units}</span><span>{mark.benchmark_source} {mark.benchmark_index_units}</span><span className="font-mono text-xs">{mark.id}</span></div>)}
      </Panel>
      <Panel title="Generate a versioned statement" description="The calculation chains integer fixed-point flow-adjusted returns; only marks from this portfolio are accepted.">
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs text-fg-muted">Start mark<select aria-label="Statement start mark" className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={fromMarkId} onChange={(event)=>setFromMarkId(event.target.value)}><option value="">Choose start</option>{marks.data?.map((mark)=><option key={mark.id} value={mark.id}>{mark.captured_at} · {mark.id}</option>)}</select></label>
          <label className="space-y-1 text-xs text-fg-muted">End mark<select aria-label="Statement end mark" className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={toMarkId} onChange={(event)=>setToMarkId(event.target.value)}><option value="">Choose end</option>{marks.data?.map((mark)=><option key={mark.id} value={mark.id} disabled={mark.id===fromMarkId}>{mark.captured_at} · {mark.id}</option>)}</select></label></div>
        <Button className="mt-3" loading={busy} disabled={!fromMarkId||!toMarkId||(marks.data?.length??0)<2} onClick={()=>void generate()}>Generate statement</Button>
      </Panel>
      <Panel title="Saved statements" description="Calculation version and result are immutable and reproducible from the selected marks.">
        {statements.loading?<LoadingState label="Loading saved statements" rows={2}/>:null}{statements.error?<ErrorState error={statements.error} onRetry={statements.refresh} title="Statements could not be loaded"/>:null}
        {!statements.loading&&!statements.error&&!statements.data?.length?<EmptyState icon={TrendingUp} title="No statements yet">Capture at least two marks, then select a period.</EmptyState>:null}
        {statements.data?.map((row)=><div key={row.id} className="border-b border-line py-3 last:border-0"><p className="text-sm">{row.created_at} · {row.report.calculationVersion} · {row.report.markCount} marks</p><div className="mt-2 grid gap-2 sm:grid-cols-4"><Metric title="TWR bps" value={row.report.twrBps} icon={TrendingUp}/><Metric title="Benchmark bps" value={row.report.benchmarkReturnBps} icon={Activity}/><Metric title="Relative bps" value={row.report.relativeReturnBps} icon={ArrowDownUp}/><Metric title="Fees units" value={row.report.feesUnits} icon={CircleDollarSign}/></div><p className="mt-2 font-mono text-xs text-fg-subtle">{row.id} · {row.report.startNavUnits} → {row.report.endNavUnits} · net flows {row.report.netExternalFlowUnits}</p></div>)}
      </Panel>
    </>}{message?<p role="status" className="text-sm text-fg-muted">{message}</p>:null}</div>;
}

function Metric({ title, value, icon: Icon }: { title:string; value:string|number; icon:typeof TrendingUp }) {
  return <Panel><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-fg-muted">{title}</p><p className="mt-2 font-mono text-lg font-semibold">{value}</p></div><Icon aria-hidden className="size-4 text-accent-text" /></div></Panel>;
}

const ui: ModuleUi = { pages: { '': InvestHome, orders: OrdersPage, risk: RiskAndMandates, backtests: BacktestsPage, performance: PerformancePage } };
export default ui;
