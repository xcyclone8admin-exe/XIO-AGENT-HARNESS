'use client';

import { useState } from 'react';
import { FileText, Link2, ListChecks, Radar, RefreshCw, Rss } from 'lucide-react';
import { useCapability } from '@xyra/sdk';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, OfflineState, PageHeader, Panel } from '@xyra/ui';
import { intelCapabilities as caps } from '../contracts';
import type { Brief, Recommendation, Source, Watchlist } from '../contracts';

function Offline() {
  return <Panel><OfflineState what="Intel" /></Panel>;
}

function Overview({ workspaceId, api }: ModulePageProps) {
  const watchlists = useCapability<Watchlist[]>(api, workspaceId, caps.watchlistList.id);
  const [name, setName] = useState('');
  const [targetName, setTargetName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function createWatchlist() {
    if (!api || !workspaceId || !name.trim() || !targetName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.watchlistCreate.id, {
        name: name.trim(),
        targets: [{ name: targetName.trim(), kind: 'company', externalRef: null }],
      });
      setName('');
      setTargetName('');
      watchlists.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Watchlist creation failed');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Intel"
        title="Watchlists"
        description="Companies, projects and topics you are tracking for source-backed intelligence."
        actions={<Button size="sm" onClick={() => watchlists.refresh()}><RefreshCw aria-hidden className="size-3.5" /> Refresh</Button>}
      />
      <Panel title="Create watchlist">
        <div className="flex items-end gap-2">
          <Input placeholder="Watchlist name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input placeholder="First target name" value={targetName} onChange={(event) => setTargetName(event.target.value)} />
          <Button size="sm" disabled={creating || !name.trim() || !targetName.trim()} onClick={createWatchlist}>Create</Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Watchlists">
        {watchlists.loading ? <LoadingState /> : null}
        {watchlists.error ? <ErrorState error={watchlists.error} onRetry={watchlists.refresh} title="Could not load watchlists" /> : null}
        {!watchlists.loading && !watchlists.error && !watchlists.data?.length ? (
          <EmptyState icon={Radar} title="No watchlists yet">Create a watchlist with at least one target to start tracking.</EmptyState>
        ) : null}
        {watchlists.data?.length ? (
          <ul className="divide-y divide-line">
            {watchlists.data.map((watchlist) => (
              <li key={watchlist.id} className="py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{watchlist.name}</span>
                  <Badge>{watchlist.targets.length} target(s)</Badge>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{watchlist.targets.map((target) => target.name).join(', ')}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

function Sources({ workspaceId, api }: ModulePageProps) {
  const sources = useCapability<Source[]>(api, workspaceId, caps.sourceList.id);
  const [identifier, setIdentifier] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function addSource() {
    if (!api || !workspaceId || !identifier.trim() || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.sourceAdd.id, { identifier: identifier.trim(), title: title.trim(), kind: 'manual' });
      setIdentifier('');
      setTitle('');
      sources.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Adding source failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Intel" title="Sources" description="Feeds, filings, news and manual sources observed for watchlists." />
      <Panel title="Add source">
        <div className="flex items-end gap-2">
          <Input placeholder="Identifier (url or id)" value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
          <Input placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <Button size="sm" disabled={busy || !identifier.trim() || !title.trim()} onClick={addSource}>Add</Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Sources">
        {sources.loading ? <LoadingState /> : null}
        {sources.error ? <ErrorState error={sources.error} onRetry={sources.refresh} title="Could not load sources" /> : null}
        {!sources.loading && !sources.error && !sources.data?.length ? (
          <EmptyState icon={Rss} title="No sources yet">Add a source to begin observing it for changes.</EmptyState>
        ) : null}
        {sources.data?.length ? (
          <ul className="divide-y divide-line">
            {sources.data.map((source) => (
              <li key={source.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-medium">{source.title}</span>
                  <span className="ml-2 text-xs text-fg-muted">{source.identifier}</span>
                </span>
                <Badge>{source.kind}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 text-xs text-fg-muted">
          Change detection here is fixture/manual-input driven (intel.change.detect): it diffs supplied
          observed snapshots against the last recorded one per source. This is not a live crawler.
        </p>
      </Panel>
    </div>
  );
}

function Briefs({ workspaceId, api }: ModulePageProps) {
  const briefs = useCapability<Brief[]>(api, workspaceId, caps.briefList.id, {});
  const watchlists = useCapability<Watchlist[]>(api, workspaceId, caps.watchlistList.id);
  const [selectedWatchlist, setSelectedWatchlist] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function generate() {
    if (!api || !workspaceId || !selectedWatchlist) return;
    setBusy(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.briefGenerate.id, { watchlistId: selectedWatchlist });
      briefs.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Brief generation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Intel" title="Briefs" description="Every claim below carries at least one citation to a source or recorded change event." />
      <Panel title="Generate">
        <div className="flex items-end gap-2">
          <select className="h-9 rounded-md border border-line bg-surface px-3 text-sm" value={selectedWatchlist} onChange={(event) => setSelectedWatchlist(event.target.value)}>
            <option value="">Select a watchlist</option>
            {watchlists.data?.map((watchlist) => <option key={watchlist.id} value={watchlist.id}>{watchlist.name}</option>)}
          </select>
          <Button size="sm" disabled={busy || !selectedWatchlist} onClick={generate}>Generate brief</Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Briefs">
        {briefs.loading ? <LoadingState /> : null}
        {briefs.error ? <ErrorState error={briefs.error} onRetry={briefs.refresh} title="Could not load briefs" /> : null}
        {!briefs.loading && !briefs.error && !briefs.data?.length ? (
          <EmptyState icon={FileText} title="No briefs yet">Generate a brief from a watchlist with recorded change events.</EmptyState>
        ) : null}
        {briefs.data?.map((brief) => (
          <div key={brief.id} className="mb-4 rounded-md border border-line p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs text-fg-muted">{brief.id}</span>
              <Badge>{brief.claims.length} claim(s)</Badge>
            </div>
            {!brief.claims.length ? <p className="mt-2 text-xs text-fg-muted">No change events were recorded for this watchlist yet; the brief has no claims.</p> : null}
            <ul className="mt-2 space-y-2">
              {brief.claims.map((claim) => (
                <li key={claim.id} className="text-sm">
                  <p>{claim.claimText}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone="accent">score {claim.relevanceScore.toFixed(2)}</Badge>
                    {claim.citations.map((citation) => (
                      <Badge key={citation.id} tone="info">
                        <Link2 aria-hidden className="size-3" />
                        {citation.changeEventId ? `change ${citation.changeEventId.slice(0, 8)}` : `source ${citation.sourceId?.slice(0, 8)}`}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Recommendations({ workspaceId, api }: ModulePageProps) {
  const recommendations = useCapability<Recommendation[]>(api, workspaceId, caps.recommendationList.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function create() {
    if (!api || !workspaceId || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.recommendationCreate.id, { text: text.trim() });
      setText('');
      recommendations.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recommendation creation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Intel"
        title="Recommendations"
        description="Routing into tasks or workflows is an integration owned outside this module; an unrouted recommendation is shown honestly as unrouted."
      />
      <Panel title="Create">
        <div className="flex items-end gap-2">
          <Input placeholder="Recommendation text" value={text} onChange={(event) => setText(event.target.value)} />
          <Button size="sm" disabled={busy || !text.trim()} onClick={create}>Create</Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Recommendations">
        {recommendations.loading ? <LoadingState /> : null}
        {recommendations.error ? <ErrorState error={recommendations.error} onRetry={recommendations.refresh} title="Could not load recommendations" /> : null}
        {!recommendations.loading && !recommendations.error && !recommendations.data?.length ? (
          <EmptyState icon={ListChecks} title="No recommendations yet">Create one from a brief claim, or standalone.</EmptyState>
        ) : null}
        {recommendations.data?.length ? (
          <ul className="divide-y divide-line">
            {recommendations.data.map((recommendation) => (
              <li key={recommendation.id} className="flex items-center justify-between py-2 text-sm">
                <span>{recommendation.text}</span>
                {recommendation.routedTo ? (
                  <Badge tone="positive">routed: {recommendation.routedTo.kind} {recommendation.routedTo.externalId}</Badge>
                ) : (
                  <Badge tone="caution">unrouted</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

const IntelUi: ModuleUi = {
  pages: {
    '': Overview,
    sources: Sources,
    briefs: Briefs,
    recommendations: Recommendations,
  },
};

export default IntelUi;
