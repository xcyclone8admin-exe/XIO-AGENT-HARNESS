'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelConnection, TaskSnapshot } from '@xyra/contracts';
import type { LocalApiClient } from '@xyra/sdk';

const button = 'rounded-lg border border-line px-3 py-2 text-xs font-semibold hover:border-accent disabled:opacity-40';

/** Durable task UI. A planned batch is distinguished from a general continuing agent run. */
export function TaskWorkspace(props: {
  api: LocalApiClient | null; workspaceId: string | null; chatId: string;
  draft: string; setDraft(value: string): void; saveMessage(): void; saving: boolean;
  recording: boolean; voiceReady: boolean; toggleVoice(): void; onTaskMessage(): void;
}) {
  const { api, workspaceId, chatId } = props;
  const [models, setModels] = useState<ModelConnection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [approvalIds, setApprovalIds] = useState<Record<string, string>>({});
  const pendingRequest = useRef<{ instruction: string; connectionId: string; id: string } | null>(null);
  const latest = tasks[0];
  const refreshModels = useCallback(async () => {
    if (!api || !workspaceId) return;
    const choices = await api.models(workspaceId);
    setModels(choices);
    setConnectionId((id) => choices.some((c) => c.id === id && c.available) ? id : choices.find((c) => c.available)?.id ?? '');
    if (!choices.length) setNotice('No model is available. Start Ollama on this computer and install a model, then refresh. Remote credentials require native setup.');
  }, [api, workspaceId]);

  useEffect(() => {
    let current = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!api || !workspaceId) return;
      try {
        const rows = await api.tasks(workspaceId, chatId);
        if (current) setTasks(rows);
      } catch (error) { if (current) setNotice(error instanceof Error ? error.message : 'Task history unavailable'); }
      if (current) timer = setTimeout(() => { void load(); }, 1000);
    };
    void Promise.resolve().then(async () => {
      setTasks([]); pendingRequest.current = null;
      try { await refreshModels(); } catch { if (current) setNotice('Model discovery unavailable.'); }
      if (current) await load();
    });
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [api, workspaceId, chatId, refreshModels]);

  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await work(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Task request failed'); }
    finally { setBusy(false); }
  };
  const run = () => perform(async () => {
    if (!api || !workspaceId || !connectionId || !props.draft.trim()) return;
    const instruction = props.draft.trim();
    if (pendingRequest.current?.instruction !== instruction || pendingRequest.current.connectionId !== connectionId)
      pendingRequest.current = { instruction, connectionId, id: crypto.randomUUID() };
    const task = await api.admitTask(workspaceId, { chatId, instruction, connectionId, requestId: pendingRequest.current.id });
    setTasks((rows) => [task, ...rows.filter((t) => t.taskId !== task.taskId)]);
    props.setDraft(''); pendingRequest.current = null;
    setNotice('Task admitted. Proposed writes will wait for an exact preview decision.');
    props.onTaskMessage();
  });
  const control = (task: TaskSnapshot, action: 'pause' | 'resume' | 'cancel' | 'revise') => perform(async () => {
    if (!api || !workspaceId) return;
    const changed = await api.controlTask(workspaceId, { taskId: task.taskId, revision: task.revision, action,
      ...(action === 'revise' ? { instruction: props.draft.trim() } : {}) });
    setTasks((rows) => rows.map((t) => t.taskId === changed.taskId ? changed : t));
    if (action === 'revise') { props.setDraft(''); setNotice('Revision saved; prior preview consent is invalid. Resume to prepare the revised task.'); }
  });

  return <div className="border-t border-line bg-surface/70 p-4 md:px-8">
    <div className="mx-auto max-w-3xl space-y-3">
      <section aria-label="Task progress" className="max-h-[360px] space-y-3 overflow-auto">
        {tasks.slice(0, 5).map((task) => <article key={task.taskId} className="rounded-xl border border-line bg-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Task · {task.state.replaceAll('_', ' ')}</h2><span className="text-[10px] text-fg-subtle">Revision {task.revision} · {task.connectionId}</span></div>
          <p className="mt-2 whitespace-pre-wrap text-xs">{task.instruction}</p>
          {task.summary && <p className="mt-2 whitespace-pre-wrap text-xs text-fg-muted">Plan / model draft: {task.summary}</p>}
          {task.error && <p role="alert" className="mt-2 text-xs text-negative">{task.error}</p>}
          {task.result && <p role="status" className="mt-2 text-xs text-positive-text">{task.result}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {['queued', 'planning', 'running', 'waiting_approval'].includes(task.state) && <button className={button} disabled={busy} onClick={() => void control(task, 'pause')}>Pause task</button>}
            {['paused', 'interrupted'].includes(task.state) && <button className={button} disabled={busy} onClick={() => void control(task, 'resume')}>Resume task</button>}
            {['paused', 'interrupted', 'waiting_approval', 'failed', 'completed'].includes(task.state) && <button className={button} disabled={busy || !props.draft.trim()} onClick={() => void control(task, 'revise')}>Use message as revised scope</button>}
            {!['completed', 'failed', 'cancelled'].includes(task.state) && <button className={button} disabled={busy} onClick={() => void control(task, 'cancel')}>Cancel task</button>}
          </div>
          {task.actions.map((action) => <details key={action.id} open={action.state === 'proposed' && task.state === 'waiting_approval'} className="mt-3 rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-xs font-semibold">{action.title} · {action.state} · {action.risk}</summary>
            <p className="mt-2 text-xs text-fg-muted">{action.effects}</p><p className="mt-1 text-[10px] text-fg-subtle">Exact proposal; no simulated result. {action.approvalRequirement === 'independent' ? 'Independent approval required.' : action.kind === 'read' ? 'Read only.' : 'Manual confirmation required.'}</p>
            <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(action.input, null, 2)}</pre>
            <p className="mt-1 break-all font-mono text-[9px] text-fg-subtle">Input SHA-256 {action.inputDigest}</p>
            {action.state === 'proposed' && task.state === 'waiting_approval' && action.kind !== 'read' && <div className="mt-2 space-y-2">
              {action.approvalRequirement === 'independent' && <label className="block text-xs">Independent approval ID<input className="mt-1 w-full rounded border border-line bg-surface p-2" value={approvalIds[action.id] ?? ''} onChange={(event) => setApprovalIds((values) => ({ ...values, [action.id]: event.target.value }))} /></label>}
              <button className={`${button} bg-accent text-accent-fg`} disabled={busy || Date.parse(action.expiresAt) <= Date.now() || (action.approvalRequirement === 'independent' && !approvalIds[action.id])} onClick={() => void perform(async () => {
                if (!api || !workspaceId) return;
                const updated = await api.approveTask(workspaceId, { taskId: task.taskId, revision: task.revision, actionId: action.id,
                  inputDigest: action.inputDigest, ...(approvalIds[action.id] ? { approvalId: approvalIds[action.id] } : {}) });
                setTasks((rows) => rows.map((t) => t.taskId === updated.taskId ? updated : t));
              })}>Approve exact action</button>
            </div>}
            {action.result !== undefined && <><p className="mt-2 text-[10px] font-semibold">Recorded capability output</p><pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(action.result, null, 2)}</pre></>}
          </details>)}
          <details className="mt-3 text-xs"><summary className="cursor-pointer">Decisions and evidence ({task.events.length})</summary><ol className="mt-2 space-y-1">{task.events.map((event) => <li key={event.sequence}>{event.sequence}. {event.stage}: {event.detail}</li>)}</ol></details>
        </article>)}
      </section>
      {notice && <p role="status" className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-xs">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="task-model" className="text-xs font-semibold">Model</label>
        <select id="task-model" aria-label="Task model" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="max-w-72 rounded-lg border border-line bg-surface p-2 text-xs"><option value="">Choose an available model</option>{models.map((model) => <option key={model.id} value={model.id} disabled={!model.available}>{model.title}</option>)}</select>
        <button className={button} disabled={busy || !api} onClick={() => void perform(refreshModels)}>Refresh models</button>
        <button className={button} disabled={busy || !connectionId} onClick={() => void perform(async () => { if (api && workspaceId) setNotice((await api.testModel(workspaceId, connectionId)).detail); })}>Test model</button>
      </div>
      <label htmlFor="chat-composer" className="sr-only">Message</label>
      <textarea id="chat-composer" value={props.draft} onChange={(e) => props.setDraft(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (connectionId) void run(); else props.saveMessage(); }
      }} placeholder="Describe a task or a revision…" rows={3} maxLength={20000} className="w-full rounded-xl border border-line bg-surface p-3 text-sm focus:border-accent" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2"><button className={button} onClick={props.toggleVoice} disabled={!props.voiceReady} aria-label={props.recording ? 'Stop voice input' : 'Start voice input'}>{props.recording ? 'Stop recording' : 'Dictate'}</button><button className={button} disabled={!props.draft.trim() || props.saving || busy} onClick={props.saveMessage}>{props.saving ? 'Saving…' : 'Save message'}</button></div>
        <button className={`${button} bg-accent text-accent-fg`} disabled={busy || !connectionId || !props.draft.trim() || !api || !workspaceId} onClick={() => void run()}>{busy ? 'Working…' : 'Run task'}</button>
      </div>
      <p className="text-[10px] text-fg-subtle">Preview & approve · bounded action batch · {latest ? `latest: ${latest.state}` : 'no task admitted'} · transcripts remain editable before sending.</p>
    </div>
  </div>;
}
