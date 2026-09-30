'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { BookOpen, CircleAlert, FileSearch, GitBranch, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
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

type ProcedureRow = { id: string; procedure_id: string; title: string; status: string; version: number; procedure_type: string };

function Truth({ api, workspaceId }: ModulePageProps) {
  const [sourceId, setSourceId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [chunkId, setChunkId] = useState('');
  const [subject, setSubject] = useState('');
  const [predicate, setPredicate] = useState('');
  const [object, setObject] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 16));
  const [claimId, setClaimId] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = !!api && !!workspaceId;
  async function createClaim(event: FormEvent) {
    event.preventDefault();
    if (!api || !workspaceId) return;
    setBusy(true); setStatus('');
    try {
      const signal = await api.write<{ signalId: string }>(workspaceId, 'brain.signals.create', { sourceId, sourceVersionId: versionId, chunkId: chunkId || null, signalType: 'reviewed_claim', payload: {} });
      const claim = await api.write<{ id: string; contradictions: string[] }>(workspaceId, 'brain.claims.create', { signalId: signal.signalId, subject, predicate, object, confidence: 1, effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveTo: null });
      setClaimId(claim.id); setStatus(`Claim recorded (${claim.id}). ${claim.contradictions.length} contradiction(s) need review.`);
    } catch { setStatus('Claim could not be recorded. Confirm source IDs and your workspace permissions.'); }
    finally { setBusy(false); }
  }
  async function promote(event: FormEvent) {
    event.preventDefault();
    if (!api || !workspaceId) return;
    setBusy(true); setStatus('');
    try {
      const result = await api.write<{ factId: string; promotionId: string; supersedesId: string | null }>(workspaceId, 'brain.facts.promote', { claimId, authorityType: 'reviewer', authorityReference: reference, reason });
      setStatus(`Fact promoted with reviewer provenance (${result.factId}).`);
    } catch { setStatus('Promotion was not accepted. Only an authorized reviewer can promote a claim.'); }
    finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="BRAIN / GOVERNANCE" title="Truth engine" description="Record evidence-linked claims. A reviewer must approve promotion to Fact." /><div className="grid gap-4 xl:grid-cols-2"><Panel title="Record claim"><form onSubmit={createClaim} className="grid gap-3"><label className="grid gap-1 text-xs text-fg-muted">Source ID<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={sourceId} onChange={e => setSourceId(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Source version ID<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={versionId} onChange={e => setVersionId(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Chunk ID (optional)<input className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={chunkId} onChange={e => setChunkId(e.target.value)} /></label><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs text-fg-muted">Subject<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={subject} onChange={e => setSubject(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Predicate<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={predicate} onChange={e => setPredicate(e.target.value)} /></label></div><label className="grid gap-1 text-xs text-fg-muted">Claimed value<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={object} onChange={e => setObject(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Effective from<input required type="datetime-local" className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></label><button disabled={!enabled || busy} className="h-9 rounded bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50">{busy ? 'Saving…' : 'Record claim'}</button></form></Panel><div className="grid gap-4"><Panel title="Promote claim to Fact"><p className="mb-3 text-sm text-fg-muted"><ShieldCheck aria-hidden className="mr-2 inline size-4 text-positive" />Agent claim writes cannot create Facts. Promotion records reviewer provenance.</p><form onSubmit={promote} className="grid gap-3"><label className="grid gap-1 text-xs text-fg-muted">Claim ID<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={claimId} onChange={e => setClaimId(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Review reference<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={reference} onChange={e => setReference(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Reason<textarea required className="min-h-20 rounded border border-line bg-surface p-2 text-sm text-fg" value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={!enabled || busy} className="h-9 rounded bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50">Promote claim</button></form></Panel><Panel title="Evidence lifecycle"><ol className="flex flex-wrap gap-2 text-xs text-fg-muted">{['Source', 'Signal', 'Claim', 'Fact', 'Memory'].map((item, index) => <li key={item} className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent-text">{index + 1}</span>{item}{index < 4 ? <GitBranch aria-hidden className="size-3 rotate-90" /> : null}</li>)}</ol></Panel></div></div>{status ? <p role="status" className="mt-4 rounded border border-line bg-surface p-3 text-sm text-fg-muted">{status}</p> : null}</>;
}

function Procedures({ api, workspaceId }: ModulePageProps) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'skill' | 'sop' | 'xyra_pattern'>('sop');
  const [body, setBody] = useState('');
  const [runId, setRunId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [rows, setRows] = useState<ProcedureRow[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = !!api && !!workspaceId;
  const refresh = useCallback(async () => {
    if (!api || !workspaceId) { setRows([]); return; }
    try { setRows(await api.read<ProcedureRow[]>(workspaceId, 'brain.procedures.list', { limit: 50 })); }
    catch { setStatus('Procedures could not be loaded. Check the local service.'); }
  }, [api, workspaceId]);
  async function propose(event: FormEvent) {
    event.preventDefault(); if (!api || !workspaceId) return;
    setBusy(true); setStatus('');
    try { const result = await api.write<{ procedureId: string }>(workspaceId, 'brain.procedures.propose', { title, type, body, ...(type === 'xyra_pattern' ? { successfulRunId: runId } : {}) }); setCandidateId(result.procedureId); setTitle(''); setBody(''); setStatus(`Candidate saved (${result.procedureId}). It remains unavailable to agents until reviewed.`); await refresh(); }
    catch { setStatus('Candidate could not be saved. Workflow patterns require a successful run reference.'); }
    finally { setBusy(false); }
  }
  async function review(event: FormEvent) {
    event.preventDefault(); if (!api || !workspaceId) return;
    setBusy(true); setStatus('');
    try { const result = await api.write<{ procedureId: string }>(workspaceId, 'brain.procedures.review', { procedureId: candidateId, decision: 'approved' }); setCandidateId(''); setStatus(`Reviewed procedure version appended (${result.procedureId}).`); await refresh(); }
    catch { setStatus('Review could not be recorded. Confirm candidate ID and reviewer permission.'); }
    finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="BRAIN / PROCEDURAL MEMORY" title="Skills & procedures" description="Versioned skills and SOPs are reviewable before agents can use them." /><div className="grid gap-4 xl:grid-cols-2"><Panel title="Propose procedure"><form onSubmit={propose} className="grid gap-3"><label className="grid gap-1 text-xs text-fg-muted">Title<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={title} onChange={e => setTitle(e.target.value)} /></label><label className="grid gap-1 text-xs text-fg-muted">Type<select className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={type} onChange={e => setType(e.target.value as typeof type)}><option value="skill">Skill</option><option value="sop">SOP</option><option value="xyra_pattern">Successful workflow pattern</option></select></label>{type === 'xyra_pattern' ? <label className="grid gap-1 text-xs text-fg-muted">Successful run ID<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={runId} onChange={e => setRunId(e.target.value)} /></label> : null}<label className="grid gap-1 text-xs text-fg-muted">Procedure<textarea required className="min-h-32 rounded border border-line bg-surface p-2 text-sm text-fg" value={body} onChange={e => setBody(e.target.value)} /></label><button disabled={!enabled || busy} className="h-9 rounded bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50">{busy ? 'Saving…' : 'Save as candidate'}</button></form></Panel><Panel title="Review candidate"><form onSubmit={review} className="grid gap-3"><label className="grid gap-1 text-xs text-fg-muted">Candidate ID<input required className="h-9 rounded border border-line bg-surface px-2 text-sm text-fg" value={candidateId} onChange={e => setCandidateId(e.target.value)} list="brain-procedure-candidates" /></label><datalist id="brain-procedure-candidates">{rows.filter(row => row.status === 'candidate').map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</datalist><button disabled={!enabled || busy} className="h-9 rounded bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50">Approve new version</button></form><button type="button" disabled={!enabled || busy} onClick={() => void refresh()} className="mt-3 h-9 rounded border border-line px-3 text-sm text-fg">Refresh procedures</button><ul className="mt-4 divide-y divide-line">{rows.map(row => <li key={row.id} className="py-2 text-sm"><span className="font-medium text-fg">{row.title}</span><span className="ml-2 text-xs text-fg-subtle">{row.procedure_type} · v{row.version} · {row.status}</span></li>)}</ul></Panel></div>{status ? <p role="status" className="mt-4 rounded border border-line bg-surface p-3 text-sm text-fg-muted">{status}</p> : null}</>;
}

const ui: ModuleUi = { pages: { '': Knowledge, truth: Truth, procedures: Procedures } };
export default ui;
