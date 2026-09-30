'use client';

import { useState } from 'react';
import { Activity, AlertTriangle, ArrowDownUp, BriefcaseBusiness, CircleDollarSign, FlaskConical, Plus, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react';
import { useCapability } from '@xyra/sdk';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, Panel } from '@xyra/ui';
import { investCapabilities as caps } from '../server/capabilities';

type Portfolio = { id: string; name: string; base_asset: string; book_id: string; environment: 'paper'; status: string };
type Instrument = { id: string; symbol: string; asset_class: string; quantity_scale: number; exchange_code: string|null };
type Order = { id:string; portfolio_id:string; instrument_id:string; symbol:string; side:'buy'|'sell'; order_type:'market'|'limit'; quantity_units:string; limit_price_units:string|null; status:string; environment:'paper'; created_at:string };
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
        <div><p className="font-medium">{order.side.toUpperCase()} {order.symbol} <Badge tone={order.status === 'filled' ? 'positive' : order.status === 'cancelled' ? 'neutral' : 'caution'}>{order.status}</Badge></p><p className="mt-1 font-mono text-xs text-fg-muted">{order.quantity_units} units · {order.order_type} · PAPER</p></div>
        <div className="flex gap-2">{order.status === 'proposed' ? <Button size="sm" loading={busy === caps.approve.id} onClick={() => void call(caps.approve.id, { orderId: order.id })}>Approve</Button> : null}{order.status === 'approved' ? <Button size="sm" loading={busy === caps.execute.id} onClick={() => void call(caps.execute.id, { orderId: order.id })}>Simulate fill</Button> : null}{['proposed','approved','submitted'].includes(order.status) ? <Button size="sm" variant="secondary" loading={busy === caps.cancel.id} onClick={() => void call(caps.cancel.id, { orderId: order.id })}>Cancel</Button> : null}</div>
      </div>)}</div> : null}
    </Panel>
  </div>;
}

function RiskAndMandates({ workspaceId, api }: ModulePageProps) {
  const portfolios = useCapability<Portfolio[]>(api, workspaceId, caps.portfolios.id);
  const instruments = useCapability<Instrument[]>(api, workspaceId, caps.instruments.id);
  const [symbol, setSymbol] = useState(''); const [exchange, setExchange] = useState(''); const [price, setPrice] = useState('');
  const [maxOrders, setMaxOrders] = useState('10'); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string|null>(null);
  const [marketSession, setMarketSession] = useState(true);
  const selectedPortfolio = portfolios.data?.[0];
  async function write(id: string, input: unknown) {
    if (!api || !workspaceId) return;
    setBusy(true); setMessage(null);
    try { await api.write(workspaceId, id, input); setMessage('Saved.'); portfolios.refresh(); instruments.refresh(); }
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
    if (!selectedPortfolio || !instruments.data?.length) return;
    await write(caps.createMandate.id, { portfolioId: selectedPortfolio.id, version: 1, effectiveFrom: new Date(Date.now()-60_000).toISOString(), effectiveUntil: null,
      allowedAssetClasses: ['equity'], allowedInstrumentIds: instruments.data.map((instrument) => instrument.id), benchmark: 'PAPER-CASH',
      limits: { maxOrderNotionalUnits: maxOrders, maxPositionNotionalUnits: '100000000', maxDailyLossUnits: '1000000', maxOrdersPerHour: 10,
        maxPriceDeviationBps: 500, quoteFreshnessSeconds: 300, duplicateWindowSeconds: 60, maxConcentrationBps: 5000,
        maxCorrelatedExposureBps: 10000, maxLeverageBps: 10000, maxDrawdownBps: 2000, targetVolatilityBps: 2000 } });
  }
  return <div className="space-y-5">
    <PageHeader eyebrow="Invest / controls" title="Risk and mandates" description="Versioned portfolio policy and fail-closed market calendar inputs." />
    <PaperBanner />
    <Panel title="Register instrument and quote" description="Manual PAPER inputs are clearly labelled; they do not represent a connected market feed.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="space-y-1 text-xs text-fg-muted">Symbol<Input aria-label="Instrument symbol" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label><label className="space-y-1 text-xs text-fg-muted">Exchange<Input aria-label="Exchange code" value={exchange} onChange={(event) => setExchange(event.target.value.toUpperCase())} /></label><label className="space-y-1 text-xs text-fg-muted">Price minor units<Input aria-label="Price minor units" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={marketSession} onChange={(event) => setMarketSession(event.target.checked)} />Market session open today</label></div>
      <Button className="mt-3" loading={busy} disabled={!symbol.trim() || !/^[1-9]\d*$/.test(price)} onClick={() => void registerInstrument()}><Plus aria-hidden className="size-4" /> Record manual PAPER quote</Button>
    </Panel>
    <Panel title="Active policy" description="Limit updates are retained as versioned mandates; approval is an owner/admin capability.">
      {!selectedPortfolio ? <EmptyState icon={ShieldCheck} title="Create a portfolio first">Investment mandates are scoped to one PAPER portfolio.</EmptyState> : <div className="space-y-3"><p className="text-sm">Portfolio: <strong>{selectedPortfolio.name}</strong></p><label className="block max-w-xs space-y-1 text-xs text-fg-muted">Maximum order notional, minor units<Input aria-label="Maximum order notional" inputMode="numeric" value={maxOrders} onChange={(event) => setMaxOrders(event.target.value)} /></label><Button loading={busy} onClick={() => void createMandate()}>Approve mandate version</Button></div>}
      {message ? <p role="status" className="mt-3 text-sm text-fg-muted">{message}</p> : null}
    </Panel>
    {selectedPortfolio ? <KillSwitch workspaceId={workspaceId} api={api} portfolioId={selectedPortfolio.id} /> : null}
    <Panel title="Instruments" description="Registered instruments and scale used by deterministic sizing.">{instruments.data?.length ? <ul className="divide-y divide-line">{instruments.data.map((instrument) => <li className="flex justify-between py-2 text-sm" key={instrument.id}><span>{instrument.symbol} · {instrument.asset_class}</span><span className="font-mono text-xs text-fg-muted">scale {instrument.quantity_scale} · {instrument.exchange_code ?? '24/7'}</span></li>)}</ul> : <EmptyState icon={AlertTriangle} title="No instruments configured">Register a paper instrument above before proposing an order.</EmptyState>}</Panel>
  </div>;
}

function KillSwitch({ workspaceId, api, portfolioId }: { workspaceId:string|null; api:ModulePageProps['api']; portfolioId:string }) {
  const [engaged, setEngaged] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string|null>(null);
  async function toggle() { if (!api || !workspaceId) return; setBusy(true); setError(null); try { await api.write(workspaceId, caps.killSwitch.id, { portfolioId, engaged: !engaged, reason: engaged ? 'Owner explicitly resumed PAPER trading' : 'Owner engaged portfolio kill switch' }); setEngaged(!engaged); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Kill switch update failed'); } finally { setBusy(false); } }
  return <Panel title="Portfolio trading kill switch" description="Engaging halts proposals and cancels open orders. Resuming requires an explicit action."><div className="flex items-center justify-between gap-3"><span className="text-sm">{engaged ? <Badge tone="negative">HALTED</Badge> : <Badge tone="positive">ACTIVE</Badge>}</span><Button variant={engaged ? 'primary' : 'secondary'} loading={busy} onClick={() => void toggle()}>{engaged ? 'Explicitly resume PAPER' : 'Halt PAPER trading'}</Button></div>{error ? <p role="alert" className="mt-2 text-sm text-negative">{error}</p> : null}</Panel>;
}

function Metric({ title, value, icon: Icon }: { title:string; value:string|number; icon:typeof TrendingUp }) {
  return <Panel><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-fg-muted">{title}</p><p className="mt-2 font-mono text-lg font-semibold">{value}</p></div><Icon aria-hidden className="size-4 text-accent-text" /></div></Panel>;
}

const ui: ModuleUi = { pages: { '': InvestHome, orders: OrdersPage, risk: RiskAndMandates } };
export default ui;
