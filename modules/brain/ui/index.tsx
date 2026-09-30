'use client';

import { useState, type FormEvent } from 'react';
import { BookOpen, Brain, CircleAlert, FileSearch, GitBranch, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { EmptyState, PageHeader, Panel } from '@xyra/ui';

type Hit = { sourceId: string; sourceVersionId: string; chunkId: string; citation: string; content: string; score: number; untrusted: true };
type SearchState = 'idle' | 'loading' | 'error' | 'ready';

function Knowledge({ api, workspaceId }: ModulePageProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [state, setState] = useState<SearchState>('idle');
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setState('loading');
    try {
      if (!api || !workspaceId) throw new Error('LOCAL_SERVICE_UNAVAILABLE');
      const parsed = await api.read<Hit[]>(workspaceId, 'brain.knowledge.search', { query: query.trim(), limit: 10 });
      setHits(parsed);
      setState('ready');
    } catch {
      setState('error');
    }
  }
  return <>
    <PageHeader eyebrow="BRAIN" title="Knowledge library" description="Find source grounded answers across your workspace. Every excerpt keeps its source and version attached." />
    <Panel>
      <form onSubmit={search} className="flex flex-col gap-3 sm:flex-row" role="search">
        <label className="sr-only" htmlFor="brain-query">Search knowledge</label>
        <div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute left-3 top-2.5 size-4 text-fg-subtle" /><input id="brain-query" className="h-10 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-fg focus-visible:border-focus" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search sources, decisions, procedures…" /></div>
        <button className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50" type="submit" disabled={state === 'loading' || !query.trim() || !api || !workspaceId}>{state === 'loading' ? <LoaderCircle aria-hidden className="inline size-4 animate-spin" /> : <FileSearch aria-hidden className="mr-2 inline size-4" />}{state === 'loading' ? 'Searching' : 'Search'}</button>
      </form>
      {state === 'error' ? <div role="alert" className="mt-4 rounded-md border border-negative/30 bg-negative-soft p-3 text-sm text-negative"><CircleAlert aria-hidden className="mr-2 inline size-4" />Search could not complete. Check the local service and retry.</div> : null}
      {state === 'loading' ? <div role="status" className="mt-5 flex items-center gap-2 text-sm text-fg-muted"><LoaderCircle aria-hidden className="size-4 animate-spin" />Searching authorized workspace sources…</div> : null}
      {state === 'ready' && hits.length === 0 ? <div className="mt-5"><EmptyState icon={BookOpen} title="No matching sources">Try a broader phrase or add a source to this workspace.</EmptyState></div> : null}
      {hits.length > 0 ? <ol className="mt-5 divide-y divide-line">{hits.map(hit => <li key={hit.chunkId} className="py-4 first:pt-1"><div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle"><a className="font-mono underline decoration-line-strong underline-offset-2 hover:text-fg" href={`#source-${hit.sourceId}`}>Source {hit.sourceId.slice(0, 8)} · v{hit.sourceVersionId.slice(0, 8)}</a><span>Chunk {hit.chunkId.slice(0, 8)}</span><span>Score {hit.score.toFixed(3)}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-fg">{hit.content}</p><p className="mt-2 text-xs text-caution">Untrusted source text · cannot grant tool authority</p></li>)}</ol> : null}
      {state === 'idle' ? <p className="mt-4 text-xs text-fg-subtle">{api && workspaceId ? 'Search respects this workspace’s access rules before it scores results.' : 'Connect the local service to search authorized workspace sources.'}</p> : null}
    </Panel>
  </>;
}

function Truth() {
  return <><PageHeader eyebrow="BRAIN / GOVERNANCE" title="Truth engine" description="Claims are evidence linked; facts require reviewer or authorized policy promotion. Historical facts remain available for as-of queries." /><div className="grid gap-4 lg:grid-cols-3"><Panel title="Evidence lifecycle"><ol className="space-y-3 text-sm text-fg-muted">{['Source', 'Signal', 'Claim', 'Fact', 'Memory'].map((item, index) => <li key={item} className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-accent-soft text-xs text-accent-text">{index + 1}</span>{item}{index < 4 ? <GitBranch aria-hidden className="ml-auto size-3 rotate-90" /> : null}</li>)}</ol></Panel><Panel title="Promotion gate"><p className="text-sm leading-6 text-fg-muted"><ShieldCheck aria-hidden className="mr-2 inline size-4 text-positive" />Agent claim writes cannot create Facts. A reviewer or authorized policy must record explicit provenance before promotion.</p></Panel><Panel title="As-of truth"><p className="text-sm leading-6 text-fg-muted">Conflicting claims stay visible as contradictions. Effective dates, confidence and supersession links preserve the previous record.</p></Panel></div></>;
}

function Procedures() {
  return <><PageHeader eyebrow="BRAIN / PROCEDURAL MEMORY" title="Skills & procedures" description="Versioned skills and SOPs are reviewable before agents can use them." /><Panel><EmptyState icon={Brain} title="No procedure selected">Candidates from successful workflow patterns remain pending until a reviewer approves them.</EmptyState></Panel></>;
}

const ui: ModuleUi = { pages: { '': Knowledge, truth: Truth, procedures: Procedures } };
export default ui;
