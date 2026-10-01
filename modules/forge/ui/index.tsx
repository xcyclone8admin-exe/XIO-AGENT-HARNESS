import { useCallback, useEffect, useState } from 'react';
import { Hammer, ShieldCheck, GitBranch, ClipboardCheck, LockKeyhole, Plus, RefreshCw } from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';

type Project = { id: string; name: string; description: string; status: string; requirements: { id: string; statement: string }[] };
type Node = { id: string; projectId: string; parentId: string | null; kind: string; title: string; state: string; requirements: { id: string; statement: string }[]; createdAt: string };
type Approval = { id: string; epicId: string; status: string; expiresAt: string };
type Source = { id: string; label: string; locator: string; authority: string; status: string; sha256: string };
type Schedule = { id: string; epicId: string; approvalId: string; state: string; runnableTicketIds: string[]; blockedTicketIds: string[]; reason: string | null; createdAt: string };
type RunEvent = { id: string; scheduleId: string; ticketId: string; state: string; externalExecution: false; detail: Record<string, unknown>; createdAt: string };
type Evidence = { id: string; requirementId: string; kind: string; source: string; result: string; sha256: string };
type Finding = { id: string; role: string; state: string; severity: string; title: string; evidenceIds: string[]; affectedRequirements: string[]; confidence: number; reproduction: string; remediation: string; revalidation: string; createdAt: string };
const surfaces = [
  { title: 'Projects & hierarchy', detail: 'Create and update projects, epics, specs, plans, waves, tickets and subtasks.', icon: GitBranch },
  { title: 'Specification & sources', detail: 'Track source provenance and compile deterministic specification drafts.', icon: ClipboardCheck },
  { title: 'Review council & Gauntlet', detail: 'Record structured findings and evaluate deterministic evidence gates.', icon: ShieldCheck },
  { title: 'Promotion records', detail: 'Request evidence-gated promotion records. Live ref changes and deployment remain disabled.', icon: LockKeyhole },
];

function ForgePage({ workspaceId, api }: ModulePageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedSurface, setSelectedSurface] = useState(0);
  const [projectName, setProjectName] = useState('');
  const [nodeTitle, setNodeTitle] = useState('');
  const [nodeKind, setNodeKind] = useState<Node['kind']>('epic');
  const [nodeParentId, setNodeParentId] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceLocator, setSourceLocator] = useState('');
  const [sourceHash, setSourceHash] = useState('');
  const [reviewTitle, setReviewTitle] = useState('');
  const [discoverySummary, setDiscoverySummary] = useState('');
  const [requirementId, setRequirementId] = useState('XIO-REQ-FRG-001');
  const [evidenceKind, setEvidenceKind] = useState<Evidence['kind']>('test');
  const [evidenceSource, setEvidenceSource] = useState('');
  const [evidenceResult, setEvidenceResult] = useState<Evidence['result']>('pass');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high' | 'critical'>('high');
  const [error, setError] = useState('');
  const projectId = projects.some((project) => project.id === selectedId) ? selectedId : projects[0]?.id ?? '';
  const refresh = useCallback(async () => {
    if (!api || !workspaceId) { setProjects([]); setNodes([]); setApprovals([]); setSources([]); setSchedules([]); setRuns([]); setEvidence([]); setFindings([]); return; }
    try {
      setError('');
      const [nextProjects, nextApprovals, nextSources, nextSchedules, nextRuns, nextEvidence, nextFindings] = await Promise.all([
        api.read<Project[]>(workspaceId, 'forge.projects.list'),
        api.read<Approval[]>(workspaceId, 'forge.approvals.list'),
        api.read<Source[]>(workspaceId, 'forge.sources.list'),
        api.read<Schedule[]>(workspaceId, 'forge.schedules.list'),
        api.read<RunEvent[]>(workspaceId, 'forge.runs.list'),
        api.read<Evidence[]>(workspaceId, 'forge.evidence.list'),
        api.read<Finding[]>(workspaceId, 'forge.findings.list'),
      ]);
      setProjects(nextProjects); setApprovals(nextApprovals); setSources(nextSources); setSchedules(nextSchedules); setRuns(nextRuns); setEvidence(nextEvidence); setFindings(nextFindings);
      if (nextProjects.length && !nextProjects.some((item) => item.id === selectedId)) setSelectedId(nextProjects[0]?.id ?? '');
      if (!nextProjects.length) setNodes([]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'FORGE_LOAD_FAILED'); }
  }, [api, workspaceId, selectedId]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  useEffect(() => {
    if (!api || !workspaceId || !projectId) return;
    void api.read<Node[]>(workspaceId, 'forge.nodes.list', { projectId }).then(setNodes).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'FORGE_NODES_LOAD_FAILED'));
  }, [api, workspaceId, projectId]);
  const write = async <T,>(capability: string, input: unknown): Promise<T | undefined> => {
    if (!api || !workspaceId) { setError('SELECT_A_WORKSPACE'); return undefined; }
    try { setError(''); const value = await api.write<T>(workspaceId, capability, input); await refresh(); return value; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'FORGE_WRITE_FAILED'); return undefined; }
  };
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); if (!projectName.trim()) return;
    const created = await write<Project>('forge.projects.create', { name: projectName.trim(), description: '', requirements: [] });
    if (created) { setSelectedId(created.id); setProjectName(''); }
  };
  const createNode = async (event: React.FormEvent) => {
    event.preventDefault(); if (!projectId || !nodeTitle.trim()) return;
    const state = nodeKind === 'epic' || nodeKind === 'spec' || nodeKind === 'plan' || nodeKind === 'wave' ? 'draft' : 'ready';
    const created = await write<Node>('forge.nodes.create', { projectId, node: { parentId: nodeKind === 'epic' ? null : nodeParentId || null, kind: nodeKind, title: nodeTitle.trim(), description: '', state, priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null } });
    if (created) setNodeTitle('');
  };
  const updateProjectName = async (event: React.FormEvent) => {
    event.preventDefault(); const project = projects.find((item) => item.id === projectId);
    if (!project || !projectName.trim()) return;
    const updated = await write<Project>('forge.projects.update', { projectId, name: projectName.trim() });
    if (updated) setProjectName('');
  };
  const proposeEpic = async (nodeId: string) => { await write('forge.nodes.update', { nodeId, state: 'proposed' }); };
  const requestApproval = async (epicId: string) => {
    await write('forge.approvals.request', { epicId });
  };
  const decideApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    await write('forge.approvals.decide', { approvalId, decision, reason: decision === 'approved' ? 'Approved in Forge workspace' : 'Rejected in Forge workspace' });
  };
  const addSource = async (event: React.FormEvent) => {
    event.preventDefault(); if (!sourceLabel.trim() || !sourceLocator.trim() || !/^[0-9a-f]{64}$/.test(sourceHash)) return;
    const created = await write<Source>('forge.sources.create', { label: sourceLabel.trim(), locator: sourceLocator.trim(), authority: 'user', status: 'draft', sha256: sourceHash });
    if (created) { setSourceLabel(''); setSourceLocator(''); setSourceHash(''); }
  };
  const startSchedule = async (epicId: string, approvalId: string) => {
    await write('forge.schedule.plan', { epicId, approvalId, config: { maxConcurrency: 1, maxBudgetUsd: 10, resourceLocks: [], substrateVerified: false, externalAdaptersEnabled: false }, spentUsd: 0 });
  };
  const addEvidence = async (event: React.FormEvent) => {
    event.preventDefault(); if (!requirementId.trim() || !evidenceSource.trim()) return;
    const target = nodes.find((node) => node.kind === 'ticket' || node.kind === 'subtask');
    const created = await write<Evidence>('forge.evidence.create', { requirementId: requirementId.trim(), kind: evidenceKind, source: evidenceSource.trim(), result: evidenceResult, deterministic: evidenceKind === 'test' || evidenceKind === 'migration' || evidenceKind === 'security', ...(target ? { ticketId: target.id } : {}) });
    if (created) setEvidenceSource('');
  };
  const evaluateRequirementGate = async () => {
    if (!requirementId.trim()) return;
    await write('forge.gates.matrix', { requirements: [{ requirementId: requirementId.trim(), risk, evidenceIds: evidence.filter((item) => item.requirementId === requirementId.trim()).map((item) => item.id) }] });
  };
  const createFinding = async (event: React.FormEvent) => {
    event.preventDefault(); const evidenceId = evidence[0]?.id;
    if (!reviewTitle.trim() || !evidenceId) { setError('ADD_EVIDENCE_BEFORE_CREATING_A_REVIEW_FINDING'); return; }
    const created = await write<Finding>('forge.findings.create', { role: 'adversarial-user', state: 'open', severity: 'medium', title: reviewTitle.trim(), evidenceIds: [evidenceId], affectedRequirements: [requirementId], confidence: 0.8, reproduction: 'Describe a reproducible scenario in the review note.', remediation: 'Document the remediation owner and action.', revalidation: 'Re-run the linked evidence check.' });
    if (created) setReviewTitle('');
  };
  const submitDiscovery = async (event: React.FormEvent) => {
    event.preventDefault(); const ticket = nodes.find((node) => node.kind === 'ticket' || node.kind === 'subtask');
    if (!ticket || !discoverySummary.trim()) { setError('CREATE_A_TICKET_AND_ENTER_A_DISCOVERY'); return; }
    const record = await write<{ blockedTicketIds: string[] }>('forge.discoveries.classify', { ticketId: ticket.id, summary: discoverySummary.trim(), evidenceIds: evidence.slice(0, 1).map((item) => item.id), affectedTicketIds: [] });
    if (record) setDiscoverySummary('');
  };

  return <main className="mx-auto w-full max-w-6xl space-y-7 p-6 md:p-10" aria-labelledby="forge-title">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-4"><span className="rounded-xl border border-border bg-muted p-3 text-foreground"><Hammer aria-hidden="true" className="h-5 w-5" /></span><div><p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Project engineering</p><h1 id="forge-title" className="mt-1 text-2xl font-semibold tracking-tight">Forge</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Requirements, project hierarchy, review and verifiable evidence in one workspace.</p></div></div><span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">Local planning · execution disabled</span></header>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Forge surfaces">{surfaces.map((surface, index) => { const Icon = surface.icon; return <button key={surface.title} type="button" onClick={() => setSelectedSurface(index)} aria-pressed={selectedSurface === index} className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedSurface === index ? 'border-foreground/25 bg-muted/70' : 'border-border bg-card hover:bg-muted/40'}`}><Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><h2 className="mt-4 text-sm font-semibold">{surface.title}</h2><p className="mt-2 min-h-12 text-xs leading-5 text-muted-foreground">{surface.detail}</p></button>; })}</section>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</p>}
    <section className="space-y-5 rounded-xl border border-border bg-card p-5 md:p-7">
      <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspace</p><h2 className="mt-1 text-lg font-semibold">Projects and planning records</h2></div><button type="button" onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"><RefreshCw className="h-4 w-4" />Refresh</button></div>
      {!workspaceId || !api ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Select a workspace and connect the local service to manage Forge records.</p> : <>
        <form onSubmit={(event) => void createProject(event)} className="flex flex-wrap gap-2"><label className="sr-only" htmlFor="forge-project-name">New project name</label><input id="forge-project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="New project name" className="min-w-60 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"><Plus className="h-4 w-4" />Create project</button></form>
        {projects.length > 0 && <><label className="block text-sm">Project<select value={projectId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2">{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.status}</option>)}</select></label><form onSubmit={(event) => void updateProjectName(event)} className="flex gap-2"><label className="sr-only" htmlFor="forge-project-update">Rename selected project</label><input id="forge-project-update" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Rename selected project" className="min-w-60 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><button className="rounded-md border border-border px-3 py-2 text-sm">Update project</button></form></>}
        {projectId && <><form onSubmit={(event) => void createNode(event)} className="flex flex-wrap gap-2"><label className="sr-only" htmlFor="forge-node-kind">Hierarchy type</label><select id="forge-node-kind" value={nodeKind} onChange={(event) => setNodeKind(event.target.value as Node['kind'])} className="rounded-md border border-border bg-background px-3 py-2 text-sm">{['epic','spec','plan','wave','ticket','subtask'].map((kind) => <option key={kind}>{kind}</option>)}</select>{nodeKind !== 'epic' && <select aria-label="Parent record" value={nodeParentId} onChange={(event) => setNodeParentId(event.target.value)} className="max-w-64 rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="">No parent</option>{nodes.filter((node) => node.projectId === projectId).map((node) => <option key={node.id} value={node.id}>{node.kind}: {node.title}</option>)}</select>}<label className="sr-only" htmlFor="forge-epic-title">New hierarchy title</label><input id="forge-epic-title" value={nodeTitle} onChange={(event) => setNodeTitle(event.target.value)} placeholder={`New ${nodeKind} title`} className="min-w-60 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><button className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"><Plus className="h-4 w-4" />Create {nodeKind}</button></form>
        <ul className="divide-y divide-border rounded-lg border border-border">{nodes.filter((node) => node.projectId === projectId).map((node) => <li key={node.id} className="flex flex-wrap items-center justify-between gap-3 p-3"><div><p className="text-sm font-medium">{node.title}</p><p className="text-xs text-muted-foreground">{node.kind} · {node.state}</p></div>{node.kind === 'epic' && node.state === 'draft' && <button type="button" onClick={() => void proposeEpic(node.id)} className="rounded-md border border-border px-3 py-1.5 text-xs">Propose epic</button>}{node.kind === 'epic' && node.state === 'proposed' && <button type="button" onClick={() => void requestApproval(node.id)} className="rounded-md border border-border px-3 py-1.5 text-xs">Request approval</button>}</li>)}{nodes.filter((node) => node.projectId === projectId).length === 0 && <li className="p-5 text-sm text-muted-foreground">No hierarchy records yet.</li>}</ul></>}
        <section className="grid gap-5 border-t border-border pt-5 md:grid-cols-2"><div><h3 className="text-sm font-semibold">Approval queue</h3><ul className="mt-2 space-y-2">{approvals.map((approval) => <li key={approval.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs"><span>{approval.status} · expires {new Date(approval.expiresAt).toLocaleDateString()}</span>{approval.status === 'pending' && <span className="flex gap-1"><button type="button" onClick={() => void decideApproval(approval.id, 'approved')} className="rounded border border-border px-2 py-1">Approve</button><button type="button" onClick={() => void decideApproval(approval.id, 'rejected')} className="rounded border border-border px-2 py-1">Reject</button></span>}{approval.status === 'approved' && <button type="button" onClick={() => void startSchedule(approval.epicId, approval.id)} className="rounded border border-border px-2 py-1">Plan queue</button>}</li>)}{approvals.length === 0 && <li className="text-xs text-muted-foreground">No approval requests.</li>}</ul></div>
          <div><h3 className="text-sm font-semibold">Source provenance</h3><form onSubmit={(event) => void addSource(event)} className="mt-2 space-y-2"><input aria-label="Source label" value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="Source label" className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs" /><input aria-label="Source locator" value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} placeholder="Repository path or document locator" className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs" /><input aria-label="Source SHA-256" value={sourceHash} onChange={(event) => setSourceHash(event.target.value)} placeholder="64-character SHA-256" className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" /><button className="rounded-md border border-border px-3 py-2 text-xs">Record source</button></form><ul className="mt-3 space-y-1">{sources.map((source) => <li key={source.id} className="truncate text-xs text-muted-foreground">{source.label} · {source.authority} · {source.status}</li>)}</ul></div></section>
        <section className="grid gap-5 border-t border-border pt-5 lg:grid-cols-2"><div><h3 className="text-sm font-semibold">Evidence ledger and requirement gate</h3><form onSubmit={(event) => void addEvidence(event)} className="mt-2 grid gap-2 sm:grid-cols-2"><input aria-label="Evidence requirement ID" value={requirementId} onChange={(event) => setRequirementId(event.target.value)} placeholder="Requirement ID" className="rounded-md border border-border bg-background px-3 py-2 text-xs" /><select aria-label="Evidence kind" value={evidenceKind} onChange={(event) => setEvidenceKind(event.target.value as Evidence['kind'])} className="rounded-md border border-border bg-background px-3 py-2 text-xs">{['test','review','artifact','approval','migration','performance','security'].map((kind) => <option key={kind}>{kind}</option>)}</select><input aria-label="Evidence source" value={evidenceSource} onChange={(event) => setEvidenceSource(event.target.value)} placeholder="Evidence source or artifact locator" className="rounded-md border border-border bg-background px-3 py-2 text-xs sm:col-span-2" /><select aria-label="Evidence result" value={evidenceResult} onChange={(event) => setEvidenceResult(event.target.value as Evidence['result'])} className="rounded-md border border-border bg-background px-3 py-2 text-xs"><option value="pass">Pass</option><option value="partial">Partial</option><option value="fail">Fail</option></select><button className="rounded-md border border-border px-3 py-2 text-xs">Append evidence</button></form><div className="mt-2 flex gap-2"><select aria-label="Requirement risk" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)} className="rounded-md border border-border bg-background px-3 py-2 text-xs">{['low','medium','high','critical'].map((level) => <option key={level}>{level}</option>)}</select><button type="button" onClick={() => void evaluateRequirementGate()} className="rounded-md border border-border px-3 py-2 text-xs">Evaluate selected requirement</button></div><ul className="mt-3 max-h-40 space-y-1 overflow-auto">{evidence.map((item) => <li key={item.id} className="text-xs text-muted-foreground">{item.requirementId} · {item.kind} · {item.result} · {item.sha256.slice(0, 12)}…</li>)}</ul></div>
          <div><h3 className="text-sm font-semibold">Queue simulation and run history</h3><ul className="mt-2 space-y-2">{schedules.map((schedule) => <li key={schedule.id} className="rounded-md border border-border p-2 text-xs"><p>{schedule.state} · {schedule.runnableTicketIds.length} planned · {schedule.blockedTicketIds.length} blocked{schedule.reason ? ` · ${schedule.reason}` : ''}</p>{schedule.state === 'queued' && <button type="button" onClick={() => void write('forge.schedules.cancel', { scheduleId: schedule.id, reason: 'Canceled from Forge UI' })} className="mt-1 rounded border border-border px-2 py-1">Cancel plan</button>}</li>)}</ul><p className="mt-3 text-xs text-muted-foreground">{runs.length} immutable simulation events; externalExecution is always false.</p><ul className="mt-1 max-h-32 space-y-1 overflow-auto">{runs.slice(0, 8).map((run) => <li key={run.id} className="text-xs">{run.state} · {run.ticketId.slice(0, 8)}</li>)}</ul></div></section>
        <section className="grid gap-5 border-t border-border pt-5 md:grid-cols-2"><div><h3 className="text-sm font-semibold">Review findings</h3><form onSubmit={(event) => void createFinding(event)} className="mt-2 flex gap-2"><input aria-label="Finding title" value={reviewTitle} onChange={(event) => setReviewTitle(event.target.value)} placeholder="Review finding summary" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs" /><button className="rounded-md border border-border px-3 py-2 text-xs">Record finding</button></form><ul className="mt-2 space-y-2">{findings.map((finding) => <li key={finding.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs"><span>{finding.role} · {finding.severity} · {finding.title} · {finding.state}</span>{finding.state === 'open' && <button type="button" onClick={() => void write('forge.findings.transition', { findingId: finding.id, state: 'triaged', detail: 'Triaged in Forge UI' })} className="rounded border border-border px-2 py-1">Triage</button>}</li>)}</ul></div><div><h3 className="text-sm font-semibold">Discovery escalation</h3><form onSubmit={(event) => void submitDiscovery(event)} className="mt-2 flex gap-2"><input aria-label="Discovery summary" value={discoverySummary} onChange={(event) => setDiscoverySummary(event.target.value)} placeholder="Record a newly discovered blocker" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-xs" /><button className="rounded-md border border-border px-3 py-2 text-xs">Classify</button></form><p className="mt-2 text-xs text-muted-foreground">Material and critical discoveries block affected tickets and dependent work.</p></div></section>
      </>}
      <footer className="flex flex-wrap gap-2 border-t border-border pt-4 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />C1 safeguards active</span><span>Runner unavailable · external adapters disabled · no live promotion</span></footer>
    </section>
  </main>;
}

const ForgeUi: ModuleUi = { pages: { '': ForgePage, reviews: ForgePage, gates: ForgePage, promotions: ForgePage } };
export default ForgeUi;
