'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, AudioLines, Boxes, ChevronDown, CircleDot, Command, FolderKanban, Library, MessageSquare, Mic, Plus, Send, Settings2, Shield, Square, Workflow } from 'lucide-react';
import type { ModuleManifest } from '@xyra/contracts';
import type { LocalApiClient } from '@xyra/sdk';
import { ThemeToggle } from '@xyra/ui';

type Chat = { id: string; title: string; agent_id: string | null; status: 'active' | 'archived'; created_at: Date | string };
type Message = { id: string; chat_id: string; role: 'user' | 'agent' | 'system'; content: string; created_at: Date | string };
type Profile = { id: string; roleId: string; defaultProvider: string; defaultModel: string };
type QueueEntry = { runId: string; state: string; errorCode: string | null };
type Project = { id: string; name: string; description: string; status: string; requirements: Array<{ id: string; statement: string }> };
type LibraryItem = { id: string; title: string; status: string; [key: string]: unknown };
const modelPrefsKey = 'xyra.chat-models.v1';
const time = (value: Date | string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ChatWorkspace(props: {
  api: LocalApiClient | null; workspaceId: string | null; workspaceName: string;
  manifests: readonly ModuleManifest[]; onSelectWorkspace(id: string): void;
  workspaces: readonly { id: string; name: string; kind: 'standard' | 'sample' }[]; sessionName: string;
}) {
  const { api, workspaceId, workspaceName, manifests, onSelectWorkspace, workspaces, sessionName } = props;
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [libraryItems, setLibraryItems] = useState<{ sources: LibraryItem[]; memories: LibraryItem[]; procedures: LibraryItem[] }>({ sources: [], memories: [], procedures: [] });
  const [projectStatus, setProjectStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [libraryStatus, setLibraryStatus] = useState<'loading' | 'ready' | 'partial' | 'unavailable'>('loading');
  const [libraryAvailable, setLibraryAvailable] = useState({ sources: false, memories: false, procedures: false });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [zoom, setZoom] = useState(100);
  const [profilePrefs, setProfilePrefs] = useState<Record<string, string>>({});
  const [view, setView] = useState<'chat' | 'projects' | 'world' | 'library' | 'settings'>('chat');
  const [draft, setDraft] = useState('');
  const [steering, setSteering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [notice, setNotice] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const recognition = useRef<{ start(): void; stop(): void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null } | null>(null);
  const currentChat = chats.find((chat) => chat.id === chatId) ?? null;
  const currentProfile = profiles.find((profile) => profile.id === profilePrefs[chatId ?? '']);
  const currentProject = projects.find((project) => project.id === projectId) ?? projects[0] ?? null;
  const createChat = useCallback(async () => {
    if (!api || !workspaceId) return;
    try {
      const chat = await api.write<Chat>(workspaceId, 'command.chats.create', { title: 'New conversation' });
      setChats((rows) => [chat, ...rows]); setChatId(chat.id); setView('chat'); setNotice('');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Conversation could not be created.'); }
  }, [api, workspaceId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(modelPrefsKey) ?? '{}');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) setProfilePrefs(saved as Record<string, string>);
      } catch { setProfilePrefs({}); }
      const voiceWindow = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
      setVoiceReady(Boolean(voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const refreshChats = useCallback(async () => {
    if (!api || !workspaceId) { setChats([]); setChatId(null); return; }
    const rows = await api.read<Chat[]>(workspaceId, 'command.chats.list');
    setChats(rows);
    setChatId((previous) => previous && rows.some((chat) => chat.id === previous) ? previous : rows[0]?.id ?? null);
  }, [api, workspaceId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!api || !workspaceId) { setChats([]); setProfiles([]); setQueue([]); return; }
      const results = await Promise.allSettled([
        api.read<Chat[]>(workspaceId, 'command.chats.list'),
        api.read<Profile[]>(workspaceId, 'swarm.profiles.list'),
        api.read<QueueEntry[]>(workspaceId, 'swarm.runs.queue', { limit: 100 }),
        api.read<Project[]>(workspaceId, 'forge.projects.list'),
        api.read<LibraryItem[]>(workspaceId, 'forge.sources.list'),
        api.read<LibraryItem[]>(workspaceId, 'brain.memories.list', { limit: 50 }),
        api.read<LibraryItem[]>(workspaceId, 'brain.procedures.list', { limit: 50 }),
      ]);
      if (!active) return;
      if (results[0]?.status === 'fulfilled') {
        const rows = results[0].value;
        setChats(rows);
        setChatId((previous) => previous && rows.some((chat) => chat.id === previous) ? previous : rows[0]?.id ?? null);
      } else setNotice('Conversation history is unavailable. Check the local service and retry.');
      setProfiles(results[1]?.status === 'fulfilled' ? results[1].value : []);
      setQueue(results[2]?.status === 'fulfilled' ? results[2].value : []);
      const projectRows = results[3]?.status === 'fulfilled' ? results[3].value : null;
      if (projectRows) {
        setProjects(projectRows);
        setProjectId((previous) => previous && projectRows.some((project) => project.id === previous) ? previous : projectRows[0]?.id ?? null);
        setProjectStatus('ready');
      } else { setProjects([]); setProjectStatus('unavailable'); }
      const sourceRows = results[4]?.status === 'fulfilled' ? results[4].value : null;
      const memoryRows = results[5]?.status === 'fulfilled' ? results[5].value : null;
      const procedureRows = results[6]?.status === 'fulfilled' ? results[6].value : null;
      setLibraryItems({ sources: sourceRows ?? [], memories: memoryRows ?? [], procedures: procedureRows ?? [] });
      const available = { sources: sourceRows !== null, memories: memoryRows !== null, procedures: procedureRows !== null };
      setLibraryAvailable(available);
      const count = Number(available.sources) + Number(available.memories) + Number(available.procedures);
      setLibraryStatus(count === 3 ? 'ready' : count === 0 ? 'unavailable' : 'partial');
    });
    return () => { active = false; };
  }, [api, workspaceId]);

  useEffect(() => {
    const handleMenuAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; payload?: string }>).detail;
      switch (detail?.action) {
        case 'xio.menu.file.new-chat': void createChat(); break;
        case 'xio.menu.file.new-project': setView('projects'); break;
        case 'xio.menu.file.export-chat': {
          if (!currentChat) { setNotice('Select a conversation before exporting.'); break; }
          const blob = new Blob([JSON.stringify({ chat: currentChat, messages }, null, 2)], { type: 'application/json' });
          const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${currentChat.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'xio-chat'}.json`; link.click(); URL.revokeObjectURL(link.href); break;
        }
        case 'xio.menu.view.space': if (['chat', 'projects', 'world', 'library', 'settings'].includes(detail.payload ?? '')) setView(detail.payload as typeof view); break;
        case 'xio.menu.view.theme': {
          const theme = detail.payload;
          if (theme === 'red' || theme === 'graphite' || theme === 'violet' || theme === 'light') {
            localStorage.setItem('xyra.theme', theme);
            window.dispatchEvent(new CustomEvent('xio:theme-select', { detail: theme }));
          }
          break;
        }
        case 'xio.menu.view.zoom':
          setZoom((value) => detail.payload === 'in' ? Math.min(130, value + 10) : detail.payload === 'out' ? Math.max(80, value - 10) : 100);
          break;
        case 'xio.menu.view.fullscreen':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.();
          break;
        case 'xio.menu.help.shortcuts': setSettingsNotice('Shortcuts: Ctrl+N new chat · Ctrl+Shift+N projects · Ctrl+S export chat · Ctrl+K command search · Enter sends a message.'); setView('settings'); break;
        case 'xio.menu.help.docs': setView('library'); break;
        case 'xio.menu.help.diagnostics': window.location.assign('/ops/doctor/'); break;
        case 'xio.menu.help.about': setSettingsNotice('XIO · governed workspace client. XYRA process and capability controls are documented in the Library.'); setView('settings'); break;
      }
    };
    window.addEventListener('xio:menu-action', handleMenuAction);
    const handleKeys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, [contenteditable="true"]');
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); void createChat(); }
      else if (event.key.toLowerCase() === 'n' && event.shiftKey) { event.preventDefault(); setView('projects'); }
      else if (event.key.toLowerCase() === 's' && !editing && currentChat) { event.preventDefault(); window.dispatchEvent(new CustomEvent('xio:menu-action', { detail: { action: 'xio.menu.file.export-chat' } })); }
    };
    window.addEventListener('keydown', handleKeys);
    return () => { window.removeEventListener('xio:menu-action', handleMenuAction); window.removeEventListener('keydown', handleKeys); };
  }, [api, workspaceId, currentChat, messages, createChat]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!api || !workspaceId || !chatId) { setMessages([]); return; }
      try { const rows = await api.read<Message[]>(workspaceId, 'command.chats.messages', { chatId }); if (active) setMessages(rows); }
      catch { if (active) setNotice('Messages could not be loaded. Retry by reopening this conversation.'); }
    });
    return () => { active = false; };
  }, [api, workspaceId, chatId]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [messages]);

  const createProject = async () => {
    const name = projectNameDraft.trim();
    if (!api || !workspaceId || !name || creatingProject) return;
    setCreatingProject(true);
    try {
      const created = await api.write<Project>(workspaceId, 'forge.projects.create', { name, description: '', requirements: [] });
      setProjects((items) => [created, ...items]); setProjectId(created.id); setProjectNameDraft(''); setSettingsNotice('');
    } catch (cause) { setSettingsNotice(cause instanceof Error ? cause.message : 'Project creation failed; no project was recorded.'); }
    finally { setCreatingProject(false); }
  };

  const selectProfile = (value: string) => {
    if (!chatId) return;
    const next = { ...profilePrefs, [chatId]: value };
    setProfilePrefs(next); localStorage.setItem(modelPrefsKey, JSON.stringify(next));
  };

  const saveMessage = async () => {
    const content = draft.trim();
    if (!api || !workspaceId || !currentChat || !content || saving) return;
    setSaving(true); setNotice('');
    try {
      const message = await api.write<Message>(workspaceId, 'command.chats.send', { chatId: currentChat.id, content: steering ? `Steering update: ${content}` : content });
      setMessages((rows) => rows.some((row) => row.id === message.id) ? rows : [...rows, message]);
      setDraft(''); setSteering(false); await refreshChats();
      if (steering) setNotice('Steering note saved. This build does not yet expose pause/resume controls for an active run.');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Message could not be saved.'); }
    finally { setSaving(false); }
  };

  const toggleVoice = () => {
    const voiceWindow = window as Window & { SpeechRecognition?: new () => SpeechController; webkitSpeechRecognition?: new () => SpeechController };
    if (recording) { recognition.current?.stop(); setRecording(false); return; }
    const Speech = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
    if (!Speech) return;
    const instance = new Speech(); recognition.current = instance;
    instance.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join(' ').trim();
      if (transcript) setDraft((current) => current ? `${current} ${transcript}` : transcript);
    };
    instance.onerror = () => { setRecording(false); setNotice('Voice capture stopped. Review any transcript before sending.'); };
    instance.onend = () => setRecording(false);
    setNotice(''); setRecording(true); instance.start();
  };

  const activeQueue = queue.filter((item) => ['queued', 'claimed', 'running'].includes(item.state));

  return <div className="xyra-chat flex min-h-screen bg-bg text-fg">
    <aside className="flex w-[286px] shrink-0 flex-col border-r border-line bg-surface" aria-label="Conversations">
      <div className="flex h-16 items-center gap-3 border-b border-line px-5"><div className="grid size-9 place-items-center rounded-xl border border-accent/40 bg-accent-soft text-accent-text"><Command aria-hidden className="size-5" /></div><div><p className="text-[10px] font-black uppercase tracking-[.24em] text-accent-text">XIO</p><p className="text-sm font-semibold">Workspace</p></div></div>
      <div className="border-b border-line px-4 py-4"><label htmlFor="workspace-select" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[.16em] text-fg-subtle">Workspace</label><div className="relative"><select id="workspace-select" value={workspaceId ?? ''} aria-label="Current workspace" onChange={(event) => onSelectWorkspace(event.target.value)} className="h-10 w-full appearance-none rounded-lg border border-line bg-surface-2 px-3 pr-9 text-sm font-semibold focus:border-accent"><option value="" disabled>Choose workspace</option>{workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-3 size-4 text-fg-subtle" /></div></div>
      <nav aria-label="XIO spaces" className="grid grid-cols-2 gap-1.5 px-4 py-4">
        {([['chat', 'Chat', MessageSquare], ['projects', 'Projects', FolderKanban], ['world', 'World', Boxes], ['library', 'Library', Library]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} className={`flex h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold ${view === id ? 'bg-accent text-accent-fg' : 'border border-line text-fg-muted hover:bg-surface-2'}`}><Icon aria-hidden className="size-3.5" />{label}</button>)}
        <button type="button" aria-pressed={view === 'settings'} onClick={() => setView('settings')} className={`col-span-2 flex h-9 items-center justify-center gap-2 rounded-lg px-2 text-xs font-semibold ${view === 'settings' ? 'bg-accent text-accent-fg' : 'border border-line text-fg-muted hover:bg-surface-2'}`}><Settings2 aria-hidden className="size-3.5" />Settings</button>
      </nav>
      <div className="flex items-center justify-between px-5 pb-2"><h2 className="text-[10px] font-bold uppercase tracking-[.16em] text-fg-subtle">Recent conversations</h2><button type="button" aria-label="New conversation" onClick={() => void createChat()} disabled={!api || !workspaceId} className="grid size-7 place-items-center rounded-md border border-line text-fg-muted hover:border-accent hover:text-accent-text disabled:opacity-40"><Plus aria-hidden className="size-4" /></button></div>
      <div className="xy-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">{chats.length ? <ul className="space-y-1">{chats.map((chat) => <li key={chat.id}><button type="button" aria-current={chat.id === chatId ? 'true' : undefined} onClick={() => { setChatId(chat.id); setView('chat'); setNotice(''); }} className={`w-full rounded-lg border px-3 py-2.5 text-left ${chat.id === chatId ? 'border-accent/40 bg-accent-soft' : 'border-transparent hover:border-line hover:bg-surface-2'}`}><span className="block truncate text-[13px] font-semibold">{chat.title}</span><span className="mt-1 flex items-center gap-1.5 text-[10px] text-fg-subtle"><CircleDot aria-hidden className="size-2.5" />{chat.status} · {time(chat.created_at)}</span></button></li>)}</ul> : <p className="mx-2 mt-2 rounded-lg border border-dashed border-line p-4 text-xs leading-5 text-fg-subtle">{api ? 'No saved conversations yet. Create one to begin.' : 'Start XYRA Desktop to connect the local workspace.'}</p>}</div>
      <div className="border-t border-line p-4"><div className="flex items-center gap-2.5"><div className="grid size-8 place-items-center rounded-full bg-surface-3 text-xs font-bold">{sessionName.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{sessionName}</p><p className="flex items-center gap-1 text-[10px] text-fg-subtle"><span className={`size-1.5 rounded-full ${api ? 'bg-positive' : 'bg-caution'}`} />{api ? 'Local service connected' : 'Offline'}</p></div><Settings2 aria-hidden className="size-4 text-fg-subtle" /></div></div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col" style={{ zoom: `${zoom}%` }}>
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-line bg-surface/85 px-6"><div><p className="text-[10px] font-black uppercase tracking-[.18em] text-accent-text">{view === 'chat' ? 'XIO · governed workspace' : view === 'projects' ? 'Projects and progress' : view === 'world' ? 'Workspace world' : view === 'library' ? 'Knowledge and process' : 'Workspace preferences'}</p><h1 className="max-w-[45vw] truncate text-sm font-semibold">{view === 'chat' ? currentChat?.title ?? 'Start a conversation' : view === 'projects' ? currentProject?.name ?? 'Projects' : view === 'world' ? workspaceName || 'World' : view === 'library' ? 'Library' : 'Settings'}</h1></div><div className="flex items-center gap-4"><span className="hidden items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[10px] text-fg-muted sm:flex"><span className="size-1.5 rounded-full bg-caution" />{api ? 'Local service connected' : 'Offline'}</span><ThemeToggle /></div></header>
      {view === 'chat' ? <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
          {!currentChat ? <div className="m-auto max-w-xl px-8 text-center"><div className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl border border-accent/40 bg-accent-soft text-accent-text"><AudioLines aria-hidden className="size-7" /></div><p className="text-[10px] font-black uppercase tracking-[.22em] text-accent-text">One workspace. Every capability.</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">What are we working on?</h2><p className="mt-3 text-sm leading-6 text-fg-muted">Start a persistent conversation, pick a configured agent profile, and keep work context together.</p><button type="button" onClick={() => void createChat()} className="mt-6 inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-fg"><Plus aria-hidden className="size-4" />New conversation</button></div> : <>
            <div className="xy-scrollbar flex-1 overflow-y-auto px-5 py-7 md:px-10"><div className="mx-auto flex max-w-3xl flex-col gap-6">{!messages.length ? <div className="rounded-2xl border border-dashed border-line p-8 text-center"><p className="text-sm font-semibold">A clean slate</p><p className="mt-2 text-xs leading-5 text-fg-muted">Messages save to this workspace. Run status and agent results appear when the runtime accepts a task.</p></div> : messages.map((message) => <article key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}><div className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border ${message.role === 'user' ? 'border-accent/30 bg-accent-soft text-accent-text' : 'border-line bg-surface-2 text-fg-muted'}`}>{message.role === 'user' ? <span className="text-[9px] font-black">YOU</span> : <Activity aria-hidden className="size-4" />}</div><div className={`max-w-[82%] rounded-2xl border px-4 py-3 ${message.role === 'user' ? 'border-accent/30 bg-accent-soft/60' : 'border-line bg-surface'}`}><div className="mb-1.5 flex gap-2 text-[10px] font-semibold uppercase text-fg-subtle"><span>{message.role}</span><time>{time(message.created_at)}</time></div><p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p></div></article>)}<div ref={bottom} /></div></div>
            <div className="border-t border-line bg-surface/70 px-4 pb-5 pt-4 md:px-8"><div className="mx-auto max-w-3xl">{notice && <p role="status" className="mb-3 rounded-lg border border-caution/30 bg-caution-soft px-3 py-2 text-xs">{notice}</p>}<div className={`rounded-2xl border bg-surface shadow-1 ${steering ? 'border-accent/60' : 'border-line'} focus-within:border-accent/50`}>
              {steering && <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[11px] text-accent-text"><span>Steering update · saved in conversation</span><button type="button" onClick={() => setSteering(false)} className="rounded px-2 py-1 hover:bg-surface-2">Cancel</button></div>}
              <label htmlFor="chat-composer" className="sr-only">Message</label><textarea id="chat-composer" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveMessage(); } }} placeholder={steering ? 'Describe the change to the task…' : 'Ask XYRA to work across your workspace…'} rows={3} maxLength={10000} className="max-h-44 min-h-24 w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-fg-subtle" />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2"><div className="flex flex-wrap items-center gap-2"><label htmlFor="chat-model" className="sr-only">Model for this conversation</label><select id="chat-model" aria-label="Model for this conversation" value={currentProfile?.id ?? ''} onChange={(event) => selectProfile(event.target.value)} disabled={!profiles.length || !chatId} className="h-8 max-w-64 rounded-lg border border-line bg-surface-2 px-2.5 text-[11px] focus:border-accent disabled:opacity-60"><option value="">{profiles.length ? 'Choose configured profile' : 'No agent profiles configured'}</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.roleId} · {profile.defaultProvider}/{profile.defaultModel}</option>)}</select><button type="button" onClick={() => { setSteering(true); setNotice(''); }} disabled={!currentChat} className="h-8 rounded-lg px-2.5 text-[11px] text-fg-muted hover:bg-surface-2 disabled:opacity-40">Steer task</button><button type="button" onClick={toggleVoice} disabled={!voiceReady} aria-label={recording ? 'Stop voice input' : 'Start voice input'} title={voiceReady ? 'Record a transcript; review it before sending' : 'Voice input not supported by this browser'} className={`grid size-8 place-items-center rounded-lg border ${recording ? 'border-negative bg-negative-soft text-negative' : 'border-line text-fg-muted hover:bg-surface-2'} disabled:opacity-40`}>{recording ? <Square aria-hidden className="size-3.5 fill-current" /> : <Mic aria-hidden className="size-4" />}</button></div><button type="button" onClick={() => void saveMessage()} disabled={!draft.trim() || !api || saving} className="inline-flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-45"><Send aria-hidden className="size-3.5" />{saving ? 'Saving…' : 'Save message'}</button></div>
            </div><p className="mt-2 text-center text-[10px] text-fg-subtle">Enter to save · Shift+Enter for a new line · voice text stays editable</p></div></div>
          </>}
        </section>
        <aside className="hidden w-[290px] shrink-0 border-l border-line bg-surface/55 xl:block" aria-label="Task status and agent profiles"><div className="border-b border-line px-5 py-4"><h2 className="text-[10px] font-bold uppercase tracking-[.18em] text-fg-subtle">Task control</h2><p className="mt-2 truncate text-sm font-semibold">{currentChat?.title ?? 'No active task'}</p></div><div className="space-y-5 p-5"><div className="rounded-xl border border-caution/30 bg-caution-soft/50 p-3"><div className="flex items-center gap-2 text-xs font-semibold"><Shield aria-hidden className="size-4 text-caution" />Runtime connection</div><p className="mt-2 text-[11px] leading-5 text-fg-muted">Conversation storage and model preference are local. This build does not claim to start, pause, resume, or cancel a live agent run.</p></div><section><div className="flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[.16em] text-fg-subtle">Execution queue</h3><span className="rounded-full border border-line px-2 py-0.5 text-[10px]">{activeQueue.length} active</span></div>{queue.length ? <ul className="mt-2 space-y-2">{queue.slice(0, 6).map((run) => <li key={run.runId} className="rounded-lg border border-line bg-surface p-3"><p className="text-xs font-semibold">{run.state}</p><p className="mt-1 font-mono text-[10px] text-fg-subtle">{run.runId.slice(0, 12)}…</p>{run.errorCode && <p className="mt-1 text-[10px] text-negative">{run.errorCode}</p>}</li>)}</ul> : <p className="mt-2 rounded-lg border border-dashed border-line p-3 text-[11px] text-fg-subtle">No queued, claimed or running tasks.</p>}</section><section><h3 className="text-[10px] font-bold uppercase tracking-[.16em] text-fg-subtle">Available profiles</h3>{profiles.length ? <ul className="mt-2 space-y-2">{profiles.slice(0, 5).map((profile) => <li key={profile.id} className="rounded-lg border border-line bg-surface p-3"><p className="text-xs font-semibold">{profile.roleId}</p><p className="mt-1 text-[10px] text-fg-muted">{profile.defaultProvider} / {profile.defaultModel}</p></li>)}</ul> : <p className="mt-2 rounded-lg border border-dashed border-line p-3 text-[11px] text-fg-subtle">No profiles available to this workspace.</p>}</section><a href="/swarm/" className="inline-flex items-center gap-2 text-xs font-medium text-accent-text hover:underline"><Workflow aria-hidden className="size-4" />Open profiles and queue</a></div></aside>
      </div> : view === 'projects' ? <ProjectsView api={api} workspaceId={workspaceId} projects={projects} selectedProject={currentProject} status={projectStatus} draft={projectNameDraft} setDraft={setProjectNameDraft} selectedId={projectId} selectProject={setProjectId} createProject={() => void createProject()} creating={creatingProject} /> : view === 'world' ? <div className="xy-scrollbar min-h-0 flex-1 overflow-auto p-5 md:p-8"><div className="mx-auto max-w-6xl"><div className="rounded-3xl border border-accent/25 bg-surface p-5 md:p-7"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.22em] text-accent-text"><span className="size-1.5 animate-pulse rounded-full bg-accent" />Workspace world</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">A solar system of connected tools</h2><p className="mt-2 max-w-xl text-xs leading-5 text-fg-muted">Each planet links to a registered module. Paths show declared dependencies; the center links to the process library. This is a module map, not live agent movement.</p></div><button type="button" onClick={() => setView('library')} className="inline-flex h-9 items-center gap-2 rounded-lg border border-accent/35 px-3 text-xs font-semibold text-accent-text hover:bg-accent-soft/40"><Workflow aria-hidden className="size-4" />Open the Library</button></div><SolarSystem manifests={manifests} onOpenLibrary={() => setView('library')} /></div><div className="mt-5 grid gap-3 md:grid-cols-3"><WorldStat title="Agent profiles" value={String(profiles.length)} detail="Configured in this workspace" icon={<Activity aria-hidden className="size-4" />} /><WorldStat title="Active runs" value={String(activeQueue.length)} detail="Queued · claimed · running" icon={<CircleDot aria-hidden className="size-4" />} /><WorldStat title="Stored conversations" value={String(chats.length)} detail="Persistent local history" icon={<MessageSquare aria-hidden className="size-4" />} /></div><section className="mt-5 grid gap-3 md:grid-cols-2">{activeQueue.length ? activeQueue.map((run) => <article key={run.runId} className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2 text-xs font-semibold"><span className="size-2 rounded-full bg-caution" />{run.state}</div><p className="mt-2 font-mono text-[10px] text-fg-subtle">Run {run.runId}</p>{run.errorCode && <p className="mt-1 text-[11px] text-negative">{run.errorCode}</p>}</article>) : <p className="rounded-xl border border-dashed border-line p-4 text-xs text-fg-subtle">No active task records. The graph shows module relationships, not running agents.</p>}</section></div></div> : view === 'library' ? <KnowledgeBase onOpenWorld={() => setView('world')} items={libraryItems} status={libraryStatus} available={libraryAvailable} /> : <SettingsView profiles={profiles} currentProfile={currentProfile} onOpenProfiles={() => window.location.assign('/swarm/')} notice={settingsNotice} />}
    </main>
  </div>;
}

function SolarSystem({ manifests, onOpenLibrary }: { manifests: readonly ModuleManifest[]; onOpenLibrary(): void }) {
  const ordered = [...manifests].sort((left, right) => left.order - right.order);
  const center = { x: 400, y: 290 };
  const ringCount = 6;
  const points = new Map<string, { x: number; y: number; manifest: ModuleManifest }>();
  ordered.forEach((manifest, index) => {
    const ring = Math.floor(index / ringCount);
    const slot = index % ringCount;
    const count = Math.min(ringCount, ordered.length - ring * ringCount);
    const radius = 92 + ring * 76;
    const angle = -Math.PI / 2 + (2 * Math.PI * slot) / count + (ring % 2 ? Math.PI / count : 0);
    points.set(manifest.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius * 0.68, manifest });
  });
  const dependencyEdges = ordered.flatMap((manifest) => (manifest.dependsOn ?? []).flatMap((dependency) => {
    const from = points.get(dependency);
    const to = points.get(manifest.id);
    return from && to ? [{ id: `${dependency}-${manifest.id}`, from, to }] : [];
  }));
  return <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-bg/70 p-2" aria-label="Workspace module knowledge graph">
    <svg viewBox="0 0 800 580" role="group" aria-label="Solar system graph of registered XYRA modules and declared dependencies" className="mx-auto min-w-[650px] max-w-full">
      <defs><radialGradient id="xyra-star"><stop offset="0" stopColor="var(--xy-accent)" stopOpacity=".55" /><stop offset="1" stopColor="var(--xy-accent)" stopOpacity=".08" /></radialGradient></defs>
      {[92, 168, 244].map((radius) => <ellipse key={radius} cx={center.x} cy={center.y} rx={radius} ry={radius * .68} fill="none" stroke="var(--xy-line-strong)" strokeWidth="1" strokeDasharray="3 7" opacity=".62" />)}
      {dependencyEdges.map((edge) => <line key={edge.id} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} stroke="var(--xy-accent)" strokeWidth="1" opacity=".27" />)}
      <a href="#library" aria-label="Open the XIO process knowledge base" onClick={(event) => { event.preventDefault(); onOpenLibrary(); }}>
        <title>Open the XIO process and knowledge base</title>
        <circle cx={center.x} cy={center.y} r="48" fill="url(#xyra-star)" stroke="var(--xy-accent)" strokeOpacity=".7" />
        <circle cx={center.x} cy={center.y} r="30" fill="var(--xy-surface-2)" stroke="var(--xy-accent)" strokeWidth="1.5" />
        <text x={center.x} y={center.y - 1} textAnchor="middle" fill="var(--xy-fg)" fontSize="12" fontWeight="800">XIO</text>
        <text x={center.x} y={center.y + 12} textAnchor="middle" fill="var(--xy-fg-muted)" fontSize="7">LIBRARY</text>
      </a>
      {[...points.values()].map(({ x, y, manifest }) => {
        const path = `/${manifest.id}${manifest.nav.find((item) => !item.hidden)?.path ? `/${manifest.nav.find((item) => !item.hidden)?.path}` : ''}/`;
        return <a href={path} key={manifest.id} aria-label={`Open ${manifest.title} module`}>
          <title>{manifest.title} · {manifest.pillar} · opens {path}</title>
          <circle cx={x} cy={y} r="23" fill="var(--xy-surface-2)" stroke="var(--xy-accent)" strokeOpacity=".68" strokeWidth="1.5" />
          <circle cx={x} cy={y} r="3" fill="var(--xy-accent)" />
          <text x={x} y={y + 34} textAnchor="middle" fill="var(--xy-fg)" fontSize="9" fontWeight="650">{manifest.id.length > 10 ? `${manifest.id.slice(0, 9)}…` : manifest.id}</text>
        </a>;
      })}
    </svg>
    <p className="px-3 pb-2 text-[10px] text-fg-subtle">Click a planet to open its module. Red connectors show declared module dependencies; layout is generated from the current module registry.</p>
  </div>;
}

function KnowledgeBase({ onOpenWorld, items, status, available }: {
  onOpenWorld(): void;
  items: { sources: LibraryItem[]; memories: LibraryItem[]; procedures: LibraryItem[] };
  status: 'loading' | 'ready' | 'partial' | 'unavailable';
  available: { sources: boolean; memories: boolean; procedures: boolean };
}) {
  const entries = [
    { title: 'How XYRA is organized', source: 'packages/contracts/src/manifest.ts ? apps/sidecar/src/runtime.ts', body: 'Modules register typed capabilities in a generated registry. The local sidecar composes those modules for a workspace; the web UI calls capabilities instead of opening module databases directly.' },
    { title: 'How a capability call is governed', source: 'apps/sidecar/src/http.ts ? apps/sidecar/src/bus.ts', body: 'The sidecar authenticates the local launch session, derives principal and workspace scope, checks module permissions, records audit and idempotency data, and requires approval for consequential actions. Renderer input is not treated as trusted approval.' },
    { title: 'Local data boundaries', source: 'packages/db/src/scoped.ts ? apps/sidecar/src/runtime.ts', body: 'Workspace reads and writes use scoped local storage with tenant and workspace context. Conversation history is stored in the workspace database. Cloud synchronization is a separate authenticated path.' },
    { title: 'XYRA task process', source: 'docs/xyra-process.md', body: 'The shipped process guide describes context, plan, preview, authorize, execute, verify and resume stages. It also marks which integrations remain disconnected in this build.' },
    { title: 'Desktop trust boundary', source: 'apps/desktop/src-tauri/src ? apps/sidecar/src/http.ts', body: 'The native host launches the sidecar and injects a per-launch renderer token. A separate in-memory native token protects private host-to-sidecar routes; it is not available through chat or renderer APIs.' },
    { title: 'Using voice input', source: 'This interface ? browser speech API', body: 'Voice capture is push-to-talk. The captured transcript is inserted into the composer and remains editable; it is never submitted automatically. Availability depends on WebView or browser speech-recognition support.' },
  ];
  const collections = [
    ['Sources', items.sources, available.sources],
    ['Memory', items.memories, available.memories],
    ['Procedures', items.procedures, available.procedures],
  ] as const;
  return <div className="xy-scrollbar min-h-0 flex-1 overflow-auto p-6 md:p-10"><div className="mx-auto max-w-5xl">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-[10px] font-black uppercase tracking-[.22em] text-accent-text">XIO Library ? XYRA process</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">Knowledge, sources and how XIO works</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-fg-muted">Shipped operator guides and workspace-scoped knowledge are shown separately.</p></div><button type="button" onClick={onOpenWorld} className="inline-flex h-9 items-center gap-2 rounded-lg border border-accent/35 px-3 text-xs font-semibold text-accent-text hover:bg-accent-soft/40"><Boxes aria-hidden className="size-4" />View the solar graph</button></div>
    <section aria-labelledby="workspace-library" className="mt-6"><h3 id="workspace-library" className="text-sm font-semibold">Workspace Library</h3>{status === 'loading' ? <p role="status" className="mt-3 text-xs text-fg-subtle">Loading authorized workspace entries?</p> : status === 'unavailable' ? <p role="status" className="mt-3 rounded-xl border border-caution/30 bg-caution-soft/40 p-4 text-xs text-fg-muted">Workspace sources and memory are unavailable. No entries are being shown as if this data were empty.</p> : <div className="mt-3 grid gap-3 md:grid-cols-3">{collections.map(([label, rows, loaded]) => <article key={label} className="rounded-2xl border border-line bg-surface p-4"><h4 className="text-[10px] font-bold uppercase tracking-[.15em] text-accent-text">{loaded ? label + ' ? ' + rows.length : label}</h4>{!loaded ? <p className="mt-3 text-[11px] text-caution-text">Unavailable for this session.</p> : rows.length ? <ul className="mt-3 space-y-2">{rows.slice(0, 8).map((row) => <li key={row.id} className="rounded-lg border border-line bg-bg/50 p-2.5"><p className="text-xs font-medium">{row.title ?? row.label ?? row.id}</p><p className="mt-1 text-[10px] text-fg-subtle">{row.status ?? 'workspace record'}</p></li>)}</ul> : <p className="mt-3 text-[11px] text-fg-subtle">No entries returned for this workspace.</p>}</article>)}</div>}</section>
    <div className="mt-7"><h3 className="text-sm font-semibold">XIO and the XYRA process</h3><p className="mt-1 text-xs text-fg-subtle">Bundled process guides ? documentation, not proof that unavailable runtime integrations are active.</p><div className="mt-3 grid gap-3 md:grid-cols-2">{entries.map((entry) => <article key={entry.title} className="rounded-2xl border border-line bg-surface p-5"><h4 className="text-sm font-semibold">{entry.title}</h4><p className="mt-2 text-xs leading-5 text-fg-muted">{entry.body}</p><p className="mt-4 border-t border-line pt-3 font-mono text-[9px] leading-4 text-fg-subtle">SOURCE ? {entry.source}</p></article>)}</div></div>
    <div className="mt-6 rounded-2xl border border-caution/30 bg-caution-soft/40 p-4 text-xs leading-5 text-fg-muted">Guides explain current code boundaries. They do not grant permissions or imply that a provider, VM, voice engine or general agent runner is connected.</div>
  </div></div>;
}

function ProjectsView(props: { api: LocalApiClient | null; workspaceId: string | null; projects: Project[]; selectedProject: Project | null; status: 'loading' | 'ready' | 'unavailable'; draft: string; setDraft(value: string): void; selectedId: string | null; selectProject(id: string): void; createProject(): void; creating: boolean }) {
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; title: string; kind: string; state: string }>>([]);
  const [nodeState, setNodeState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!props.api || !props.workspaceId || !props.selectedProject) { if (active) { setNodes([]); setNodeState('ready'); } return; }
      setNodeState('loading');
      try { const rows = await props.api.read<Array<{ id: string; title: string; kind: string; state: string }>>(props.workspaceId, 'forge.nodes.list', { projectId: props.selectedProject.id }); if (active) { setNodes(rows); setNodeState('ready'); } }
      catch { if (active) { setNodes([]); setNodeState('unavailable'); } }
    });
    return () => { active = false; };
  }, [props.api, props.workspaceId, props.selectedProject]);
  return <div className="xy-scrollbar min-h-0 flex-1 overflow-auto p-6 md:p-10"><div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[280px_1fr]">
    <aside className="rounded-2xl border border-line bg-surface p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-bold uppercase tracking-[.16em]">Projects</h2><span className="text-[10px] text-fg-subtle">{props.projects.length}</span></div>{props.status === 'loading' ? <p role="status" className="mt-4 text-xs text-fg-subtle">Loading projects…</p> : props.status === 'unavailable' ? <p role="alert" className="mt-4 text-xs text-caution-text">Project service unavailable.</p> : props.projects.length ? <ul className="mt-3 space-y-1">{props.projects.map((project) => <li key={project.id}><button type="button" aria-current={props.selectedProject?.id === project.id ? 'true' : undefined} onClick={() => props.selectProject(project.id)} className={`w-full rounded-lg border px-3 py-2 text-left ${props.selectedProject?.id === project.id ? 'border-accent/40 bg-accent-soft' : 'border-transparent hover:bg-surface-2'}`}><span className="block truncate text-xs font-semibold">{project.name}</span><span className="text-[10px] text-fg-subtle">{project.status}</span></button></li>)}</ul> : <p className="mt-3 text-xs text-fg-subtle">No projects in this workspace yet.</p>}</aside>
    <section className="space-y-5"><article className="rounded-2xl border border-line bg-surface p-5"><p className="text-[10px] font-black uppercase tracking-[.18em] text-accent-text">New project · preview first</p><h2 className="mt-2 text-lg font-semibold">Create a scoped project</h2><p className="mt-1 text-xs text-fg-muted">Preview the exact fields before saving. Editing the name clears the preview.</p><div className="mt-4 flex flex-wrap gap-2"><label htmlFor="project-name" className="sr-only">Project name</label><input id="project-name" value={props.draft} onChange={(event) => { props.setDraft(event.target.value); setPreviewName(null); }} maxLength={200} placeholder="Project name" className="h-10 min-w-56 flex-1 rounded-lg border border-line bg-bg px-3 text-sm" /><button type="button" onClick={() => { if (props.draft.trim()) setPreviewName(props.draft.trim()); }} disabled={!props.draft.trim() || !props.api || !props.workspaceId} className="h-10 rounded-lg border border-accent/40 px-4 text-xs font-semibold text-accent-text disabled:opacity-40">Preview</button></div>{previewName !== null && <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft/30 p-4"><h3 className="text-xs font-semibold">Project preview</h3><dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-fg-subtle">Name</dt><dd className="font-medium">{previewName}</dd></div><div><dt className="text-fg-subtle">Workspace</dt><dd>Current authenticated workspace</dd></div><div><dt className="text-fg-subtle">Initial requirements</dt><dd>None</dd></div><div><dt className="text-fg-subtle">Effect</dt><dd>Persist one project record</dd></div></dl><button type="button" onClick={props.createProject} disabled={props.creating || previewName !== props.draft.trim()} className="mt-4 h-9 rounded-lg bg-accent px-4 text-xs font-semibold text-accent-fg disabled:opacity-40">{props.creating ? 'Creating…' : 'Approve and create'}</button></div>}</article>
      {props.selectedProject ? <article className="rounded-2xl border border-line bg-surface p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.18em] text-accent-text">Project overview</p><h2 className="mt-1 text-xl font-semibold">{props.selectedProject.name}</h2><p className="mt-1 text-xs text-fg-muted">{props.selectedProject.description || 'No description recorded.'}</p></div><span className="rounded-full border border-line px-3 py-1 text-[10px]">{props.selectedProject.status}</span></div><h3 className="mt-5 text-xs font-bold uppercase tracking-[.14em]">Plan and progress</h3>{nodeState === 'loading' ? <p role="status" className="mt-3 text-xs text-fg-subtle">Loading project hierarchy…</p> : nodeState === 'unavailable' ? <p role="alert" className="mt-3 text-xs text-caution-text">Project hierarchy could not be loaded.</p> : nodes.length ? <ul className="mt-3 grid gap-2 md:grid-cols-2">{nodes.map((node) => <li key={node.id} className="rounded-lg border border-line bg-bg/50 p-3"><p className="text-xs font-semibold">{node.title}</p><p className="mt-1 text-[10px] text-fg-subtle">{node.kind} · {node.state}</p></li>)}</ul> : <p className="mt-3 rounded-lg border border-dashed border-line p-4 text-xs text-fg-subtle">No hierarchy items are recorded. Open Forge for the full planning and evidence workflow.</p>}<a href="/forge/" className="mt-4 inline-flex rounded-lg border border-line px-3 py-2 text-xs font-semibold hover:border-accent">Open full Forge workflow</a></article> : <div className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-fg-subtle">Select a project to see its plan, progress and evidence.</div>}
    </section></div></div>;
}

function SettingsView(props: { profiles: Profile[]; currentProfile: Profile | undefined; onOpenProfiles(): void; notice: string }) {
  return <div className="xy-scrollbar min-h-0 flex-1 overflow-auto p-6 md:p-10"><div className="mx-auto max-w-4xl space-y-5"><div><p className="text-[10px] font-black uppercase tracking-[.22em] text-accent-text">Preferences</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">XIO settings</h2><p className="mt-2 text-sm text-fg-muted">User choices are separate from trusted execution policy and provider credentials.</p></div>{props.notice && <p role="status" className="rounded-xl border border-accent/30 bg-accent-soft/30 p-3 text-xs">{props.notice}</p>}<section className="rounded-2xl border border-line bg-surface p-5"><h3 className="text-sm font-semibold">Appearance</h3><p className="mt-1 text-xs text-fg-muted">Theme choice is saved on this device.</p><div className="mt-4"><ThemeToggle /></div></section><section className="rounded-2xl border border-line bg-surface p-5"><h3 className="text-sm font-semibold">Agent profiles and models</h3><p className="mt-1 text-xs text-fg-muted">Select a configured profile in a conversation. Credentials are never entered in chat or browser preferences.</p>{props.profiles.length ? <ul className="mt-4 space-y-2">{props.profiles.map((profile) => <li key={profile.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3"><span className="text-xs font-semibold">{profile.roleId}</span><span className="text-[11px] text-fg-muted">{profile.defaultProvider} / {profile.defaultModel}</span></li>)}</ul> : <p className="mt-3 rounded-lg border border-dashed border-line p-3 text-xs text-fg-subtle">No profiles are available to this workspace.</p>}<button type="button" onClick={props.onOpenProfiles} className="mt-4 h-9 rounded-lg border border-line px-3 text-xs font-semibold hover:border-accent">Open profile settings</button></section><section className="rounded-2xl border border-caution/30 bg-caution-soft/30 p-5"><h3 className="text-sm font-semibold">Runtime availability</h3><p className="mt-2 text-xs leading-5 text-fg-muted">General chat execution, secure provider onboarding, browser sessions, and local/cloud VM adapters are not connected in this build. XIO will not start a run or claim a backend where none is registered.</p></section></div></div>;
}

function WorldStat(props: { title: string; value: string; detail: string; icon: ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface p-4"><div className="flex items-center gap-2 text-accent-text">{props.icon}<span className="text-[10px] font-bold uppercase tracking-[.15em]">{props.title}</span></div><p className="mt-3 truncate text-lg font-semibold">{props.value}</p><p className="mt-1 text-[11px] text-fg-subtle">{props.detail}</p></div>;
}

interface SpeechController {
  start(): void; stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
}
