'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, BookOpen, CircleDollarSign, FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCapability } from '@xyra/sdk';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Panel, LoadingState } from '@xyra/ui';
import { unitsToDecimal } from '@xyra/ledger';
import type { Asset, Balance, Discrepancy, LedgerEnvironment, Transaction, TransactionPage, TypeTotals } from '@xyra/ledger/contracts';
import { ledgerCapabilities as caps } from '@xyra/ledger/contracts';

function EnvironmentPicker({ value, onChange }: { value: LedgerEnvironment; onChange(value: LedgerEnvironment): void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg-muted">
      <span>Environment</span>
      <select
        className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-fg focus-visible:border-focus"
        value={value}
        onChange={(event) => onChange(event.target.value as LedgerEnvironment)}
      >
        <option value="actual">Actual</option>
        <option value="paper">Paper</option>
      </select>
    </label>
  );
}

function Amount({ units, scale, asset }: { units: string; scale: number; asset: string }) {
  return <span className="font-mono tabular-nums">{asset} {unitsToDecimal(BigInt(units), scale)}</span>;
}

function Overview({ workspaceId, api }: ModulePageProps) {
  const [environment, setEnvironment] = useState<LedgerEnvironment>('actual');
  const assets = useCapability<Asset[]>(api, workspaceId, caps.assets.id);
  const balances = useCapability<Balance[]>(api, workspaceId, caps.balances.id, { environment });
  const assetCode = assets.data?.[0]?.code ?? 'USD';
  const totals = useCapability<TypeTotals>(api, workspaceId, caps.totals.id, { environment, asset: assetCode });
  const txs = useCapability<TransactionPage>(api, workspaceId, caps.transactions.id, { environment, limit: 8 });
  const openDiscrepancies = useCapability<Discrepancy[]>(api, workspaceId, caps.discrepancies.id, { environment, status: 'open' });
  const [registering, setRegistering] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState({ code: '', name: '', scale: '2', kind: 'fiat' as Asset['kind'] });

  const loading = assets.loading || balances.loading || totals.loading || txs.loading || openDiscrepancies.loading;
  const error = assets.error ?? balances.error ?? totals.error ?? txs.error ?? openDiscrepancies.error;
  const refresh = () => { assets.refresh(); balances.refresh(); totals.refresh(); txs.refresh(); openDiscrepancies.refresh(); };

  async function registerAsset() {
    if (!api || !workspaceId) return;
    setRegistering(true);
    setAssetError(null);
    try {
      await api.write(workspaceId, caps.ensureAssets.id, {
        assets: [{ ...newAsset, code: newAsset.code.trim().toUpperCase(), name: newAsset.name.trim(), scale: Number(newAsset.scale) }],
      });
      setNewAsset({ code: '', name: '', scale: '2', kind: 'fiat' });
      refresh();
    } catch (cause) {
      setAssetError(cause instanceof Error ? cause.message : 'Asset registration failed');
    } finally {
      setRegistering(false);
    }
  }

  const byType = totals.data?.byType;
  const income = byType?.income ?? '0';
  const expenses = byType?.expense ?? '0';
  const net = (-BigInt(income) - BigInt(expenses)).toString();
  const scale = totals.data?.scale ?? 2;
  const money = (value: string) => <Amount units={value} scale={scale} asset={assetCode} />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Money"
        title="Finance overview"
        description="Workspace ledger balances, posted activity and reconciliation status. All totals are derived from immutable ledger entries."
        actions={<><EnvironmentPicker value={environment} onChange={setEnvironment} /><Button size="sm" onClick={refresh}><RefreshCw aria-hidden className="size-3.5" /> Refresh</Button></>}
      />
      {environment === 'paper' ? <div className="flex items-center gap-2"><Badge tone="caution"><FlaskConical aria-hidden className="size-3" /> PAPER</Badge><span className="text-sm text-fg-muted">Paper balances are isolated from actual books and totals.</span></div> : null}
      {loading ? <Panel><LoadingState label="Loading ledger totals" rows={3} /></Panel> : null}
      {error ? <ErrorState error={error} onRetry={refresh} title="Finance data could not be loaded" /> : null}
      {!loading && !error && assets.data?.length === 0 ? (
        <Panel><EmptyState icon={CircleDollarSign} title="Register an asset to get started">
          No default currency or financial data is created for a new workspace. Choose an asset and its immutable decimal scale to start a ledger.
          <div className="mt-4 grid w-full max-w-xl gap-3 text-left sm:grid-cols-2">
            <label className="space-y-1 text-xs text-fg-muted">Asset code<Input aria-label="Asset code" maxLength={32} placeholder="USD" value={newAsset.code} onChange={(event) => setNewAsset({ ...newAsset, code: event.target.value })} /></label>
            <label className="space-y-1 text-xs text-fg-muted">Name<Input aria-label="Asset name" maxLength={120} placeholder="US dollar" value={newAsset.name} onChange={(event) => setNewAsset({ ...newAsset, name: event.target.value })} /></label>
            <label className="space-y-1 text-xs text-fg-muted">Decimal scale<Input aria-label="Decimal scale" type="number" min={0} max={18} step={1} value={newAsset.scale} onChange={(event) => setNewAsset({ ...newAsset, scale: event.target.value })} /></label>
            <label className="space-y-1 text-xs text-fg-muted">Kind<select aria-label="Asset kind" className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg" value={newAsset.kind} onChange={(event) => setNewAsset({ ...newAsset, kind: event.target.value as Asset['kind'] })}><option value="fiat">Fiat currency</option><option value="crypto">Crypto</option><option value="security">Security</option><option value="unit">Unit</option></select></label>
          </div>
          <span className="mt-3 block"><Button loading={registering} disabled={!newAsset.code.trim() || !newAsset.name.trim()} onClick={() => void registerAsset()}>Register asset</Button></span>
          {assetError ? <span role="alert" className="mt-2 block text-negative">{assetError}</span> : null}
        </EmptyState></Panel>
      ) : null}
      {!loading && !error && assets.data?.length ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric title="Income · all posted" value={money(income)} icon={ArrowDownLeft} tone="positive" />
            <Metric title="Expenses · all posted" value={money(expenses)} icon={ArrowUpRight} tone="caution" />
            <Metric title="Net · all posted" value={money(net)} icon={Activity} tone={BigInt(net) < 0n ? 'negative' : 'accent'} />
            <Metric title="Open discrepancies" value={openDiscrepancies.data?.length ?? 0} icon={ShieldCheck} tone="neutral" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
            <Panel title="Account balances" description={`Current ${environment} projection by account and asset`}>
              {balances.data?.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-fg-subtle"><tr><th className="pb-2 font-medium">Account</th><th className="pb-2 font-medium">Book</th><th className="pb-2 text-right font-medium">Balance</th></tr></thead>
                <tbody className="divide-y divide-line">{balances.data.map((row) => <tr key={`${row.bookId}:${row.accountId}:${row.asset}`}>
                  <td className="py-2.5"><span className="font-medium text-fg">{row.accountName}</span><span className="ml-2 font-mono text-xs text-fg-subtle">{row.accountCode}</span></td>
                  <td className="py-2.5 font-mono text-xs text-fg-muted">{row.bookId.slice(0, 8)}</td>
                  <td className="py-2.5 text-right"><Amount units={row.units} scale={row.scale} asset={row.asset} /></td>
                </tr>)}</tbody>
              </table></div> : <EmptyState icon={BookOpen} title="No posted balances yet">Create a book and accounts, then post a balanced transaction to see real balances here.</EmptyState>}
            </Panel>
            <Panel title="Recent transactions" description="Most recent postings in this environment">
              {txs.data?.items.length ? <div className="divide-y divide-line">{txs.data.items.map((tx) => <TransactionRow key={tx.id} transaction={tx} />)}</div> : <EmptyState icon={Activity} title="No transactions yet">Posted ledger activity will appear here.</EmptyState>}
            </Panel>
          </div>
          <Panel title="External income feeds" description="Processor connections are not configured for this workspace.">
            <p className="text-sm text-fg-muted">Stripe and PayKit balances are unavailable until a connector is authorized. No external balance is estimated or shown as live.</p>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function Metric({ title, value, icon: Icon, tone }: { title: string; value: ReactNode; icon: typeof Activity; tone: 'positive' | 'caution' | 'negative' | 'accent' | 'neutral' }) {
  const tint = tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : tone === 'caution' ? 'text-caution' : tone === 'accent' ? 'text-accent-text' : 'text-fg-muted';
  return <Panel><div className="flex items-start justify-between gap-2"><div><p className="text-xs text-fg-muted">{title}</p><p className="mt-2 text-lg font-semibold text-fg">{value}</p></div><Icon aria-hidden className={`size-4 ${tint}`} /></div></Panel>;
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  return <article className="flex items-start justify-between gap-3 py-3">
    <div className="min-w-0"><p className="truncate text-sm font-medium text-fg">{transaction.description}</p><p className="mt-1 text-xs text-fg-muted">{transaction.effectiveDate} · {transaction.entries.length} lines · {transaction.source}</p></div>
    {transaction.reversesId ? <Badge tone="caution">Reversal</Badge> : transaction.reversedById ? <Badge tone="neutral">Reversed</Badge> : <Badge tone="positive">Posted</Badge>}
  </article>;
}

function LedgerPage({ workspaceId, api }: ModulePageProps) {
  const [environment, setEnvironment] = useState<LedgerEnvironment>('actual');
  const assets = useCapability<Asset[]>(api, workspaceId, caps.assets.id);
  const txs = useCapability<TransactionPage>(api, workspaceId, caps.transactions.id, { environment, limit: 100 });
  const refresh = () => { assets.refresh(); txs.refresh(); };
  const error = assets.error ?? txs.error;
  return <div className="space-y-5">
    <PageHeader eyebrow="Money / ledger" title="Ledger explorer" description="Immutable transactions, their entry lines and reversal links." actions={<><EnvironmentPicker value={environment} onChange={setEnvironment} /><Button size="sm" onClick={refresh}>Refresh</Button></>} />
    {environment === 'paper' ? <Badge tone="caution"><FlaskConical aria-hidden className="size-3" /> PAPER</Badge> : null}
    {assets.loading || txs.loading ? <Panel><LoadingState label="Loading ledger" rows={5} /></Panel> : null}
    {error ? <ErrorState error={error} onRetry={refresh} title="Ledger could not be loaded" /> : null}
    {!assets.loading && !txs.loading && !error && txs.data?.items.length === 0 ? <Panel><EmptyState icon={BookOpen} title="Ledger is empty">Create accounts and post a balanced transaction before exploring entries.</EmptyState></Panel> : null}
    {!assets.loading && !txs.loading && !error && txs.data?.items.length ? <Panel title={`${txs.data.items.length} transactions`} description={`Showing the first page of ${environment} activity`}>
      <div className="space-y-3">{txs.data.items.map((transaction) => <div key={transaction.id} className="rounded-md border border-line p-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium text-fg">{transaction.description}</h3><p className="mt-1 text-xs text-fg-muted">{transaction.effectiveDate} · book {transaction.bookId} · {transaction.source}</p></div><TransactionRow transaction={transaction} /></div>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-fg-subtle"><tr><th className="pb-1 font-medium">Account</th><th className="pb-1 font-medium">Asset</th><th className="pb-1 text-right font-medium">Minor units</th></tr></thead>
          <tbody className="divide-y divide-line">{transaction.entries.map((entry) => <tr key={entry.id}><td className="py-1.5 font-mono text-fg-muted">{entry.accountId}</td><td className="py-1.5">{entry.asset}</td><td className="py-1.5 text-right font-mono">{entry.units}</td></tr>)}</tbody></table></div>
      </div>)}</div>
      {txs.data.nextCursor ? <p className="mt-3 text-xs text-fg-muted">More transactions are available. Narrow by book or date to inspect another slice.</p> : null}
    </Panel> : null}
  </div>;
}

function ReconciliationPage({ workspaceId, api }: ModulePageProps) {
  const [environment, setEnvironment] = useState<LedgerEnvironment>('actual');
  const [working, setWorking] = useState(false);
  const [runSummary, setRunSummary] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const queue = useCapability<Discrepancy[]>(api, workspaceId, caps.discrepancies.id, { environment, status: 'open' });
  async function reconcile() {
    if (!api || !workspaceId) return;
    setWorking(true); setActionError(null); setRunSummary(null);
    try {
      const result = await api.write<{ status: string; checkedBalances: number; discrepancyCount: number; reused: boolean }>(
        workspaceId, caps.reconcile.id, { environment },
      );
      setRunSummary(`${result.status === 'clean' ? 'Clean' : 'Discrepancies found'} · ${result.checkedBalances} balances checked · ${result.discrepancyCount} discrepancies${result.reused ? ' · reused run' : ''}`);
      queue.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Reconciliation failed');
    } finally { setWorking(false); }
  }
  return <div className="space-y-5">
    <PageHeader eyebrow="Money / controls" title="Reconciliation" description="Compare the balance projection with immutable journal entries. Corrections are recorded as reversing entries." actions={<EnvironmentPicker value={environment} onChange={setEnvironment} />} />
    {environment === 'paper' ? <Badge tone="caution"><FlaskConical aria-hidden className="size-3" /> PAPER</Badge> : null}
    <Panel title="Reconciliation run" description="The run is deterministic and idempotent for an unchanged entry watermark." actions={<Button variant="primary" loading={working} onClick={() => void reconcile()}><ShieldCheck aria-hidden className="size-3.5" /> Run reconciliation</Button>}>
      {runSummary ? <p role="status" className="text-sm text-fg">{runSummary}</p> : <p className="text-sm text-fg-muted">Run a comparison to check ledger balances and open discrepancy records for any mismatch.</p>}
      {actionError ? <p role="alert" className="mt-2 text-sm text-negative">{actionError}</p> : null}
    </Panel>
    <Panel title="Open discrepancy queue" description="Every item is tied to a book and can be assigned or resolved with a written explanation.">
      {queue.loading ? <LoadingState label="Loading discrepancies" rows={3} /> : null}
      {queue.error ? <ErrorState error={queue.error} onRetry={queue.refresh} title="Discrepancies could not be loaded" /> : null}
      {!queue.loading && !queue.error && !queue.data?.length ? <EmptyState icon={ShieldCheck} title="No open discrepancies">Run reconciliation when you need to verify a ledger projection.</EmptyState> : null}
      {queue.data?.length ? <ul className="divide-y divide-line">{queue.data.map((item) => <li key={item.id} className="py-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium text-fg">{item.kind.replaceAll('_', ' ')}</p><p className="mt-1 text-xs text-fg-muted">Book {item.bookId} · {item.asset ?? 'asset unavailable'} · {item.detail}</p></div><Badge tone={item.status === 'open' ? 'caution' : 'neutral'}>{item.status}</Badge></div><p className="mt-1 font-mono text-xs text-fg-subtle">Expected {item.expectedUnits ?? '—'} · recorded {item.recordedUnits ?? '—'}</p></li>)}</ul> : null}
    </Panel>
  </div>;
}

const ui: ModuleUi = { pages: { '': Overview, ledger: LedgerPage, reconciliation: ReconciliationPage } };
export default ui;
