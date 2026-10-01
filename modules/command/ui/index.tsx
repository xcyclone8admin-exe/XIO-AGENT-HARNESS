'use client';

import {
  AlertTriangle,
  Check,
  Map,
  MessageSquare,
  ShieldCheck,
  Stethoscope,
  Users,
} from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, LoadingState, OfflineState, PageHeader, Panel, Stat } from '@xyra/ui';
import { useCapability } from '@xyra/sdk/use-capability';

type DashboardSummary = {
  greeting: string;
  systems_live: number;
  systems_total: number;
  agents_live: number;
  agents_total: number;
  pending_approvals: number;
  unread_alerts: number;
};

type Alert = {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  dismissed_at: string | Date | null;
  created_at: string | Date;
};

type Action = {
  id: string;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  done_at: string | Date | null;
  dismissed_at: string | Date | null;
  created_at: string | Date;
};

type Chat = {
  id: string;
  title: string;
  agent_id: string | null;
  status: string;
  created_at: string | Date;
};

type Persona = {
  id: string;
  title: string;
  summary: string;
  north_star_metric: string | null;
  pillars: string[];
};

type DoctorCheck = {
  id: string;
  check_id: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  detail: string;
  created_at: string | Date;
};

type BlueprintNode = {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
};

const SEVERITY_TONE: Record<string, 'neutral' | 'caution' | 'negative'> = {
  info: 'neutral',
  warning: 'caution',
  critical: 'negative',
};

const PRIORITY_TONE: Record<string, 'neutral' | 'caution' | 'negative'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'negative',
};

const HEALTH_TONE: Record<string, 'positive' | 'caution' | 'negative'> = {
  healthy: 'positive',
  degraded: 'caution',
  unhealthy: 'negative',
};

function Home({ workspaceId, api }: ModulePageProps) {
  const summary = useCapability<DashboardSummary>(api, workspaceId, 'command.dashboard.summary', {});
  const alerts = useCapability<Alert[]>(api, workspaceId, 'command.alerts.list', { includeDismissed: false });
  const actions = useCapability<Action[]>(api, workspaceId, 'command.actions.list', { includeDone: false });

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Command center"
          description="Your priorities, inbox, alerts and next-best actions in one view." />
        <Panel><OfflineState what="Command center" /></Panel>
      </>
    );
  }

  const s = summary.data;

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title={s?.greeting ? `${s.greeting} — Command` : 'Command center'}
        description="Your priorities, inbox, alerts and next-best actions in one view."
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Panel>
          <Stat label="Systems live" value={summary.loading ? '—' : `${s?.systems_live ?? 0} / ${s?.systems_total ?? 0}`} />
        </Panel>
        <Panel>
          <Stat label="Agents live" value={summary.loading ? '—' : `${s?.agents_live ?? 0} / ${s?.agents_total ?? 0}`} />
        </Panel>
        <Panel>
          <Stat
            label="Pending approvals"
            value={summary.loading ? '—' : String(s?.pending_approvals ?? 0)}
            {...(s && s.pending_approvals > 0 ? { tone: 'caution' as const } : {})}
          />
        </Panel>
        <Panel>
          <Stat
            label="Unread alerts"
            value={summary.loading ? '—' : String(s?.unread_alerts ?? 0)}
            {...(s && s.unread_alerts > 0 ? { tone: 'negative' as const } : {})}
          />
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel
          title="Active alerts"
          actions={<Button size="sm" onClick={alerts.refresh}>Refresh</Button>}
        >
          {alerts.loading ? <LoadingState label="Loading alerts" rows={3} /> :
            alerts.error ? <ErrorState error={alerts.error} onRetry={alerts.refresh} /> :
            !alerts.data?.length ? (
              <EmptyState icon={AlertTriangle} title="No active alerts">
                Alerts will appear here when they are raised.
              </EmptyState>
            ) : (
              <ul role="list" className="space-y-2">
                {alerts.data.map((a: Alert) => (
                  <li key={a.id} className="flex items-start gap-3 rounded-md border border-line p-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                        <span className="text-sm font-medium text-fg truncate">{a.title}</span>
                      </div>
                      {a.body ? <p className="mt-0.5 text-[0.857rem] text-fg-muted">{a.body}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </Panel>

        <Panel
          title="Next-best actions"
          actions={<Button size="sm" onClick={actions.refresh}>Refresh</Button>}
        >
          {actions.loading ? <LoadingState label="Loading actions" rows={3} /> :
            actions.error ? <ErrorState error={actions.error} onRetry={actions.refresh} /> :
            !actions.data?.length ? (
              <EmptyState icon={Check} title="No pending actions">
                Recommended actions will appear here as context builds.
              </EmptyState>
            ) : (
              <ul role="list" className="space-y-2">
                {actions.data.map((a: Action) => (
                  <li key={a.id} className="flex items-start gap-3 rounded-md border border-line p-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={PRIORITY_TONE[a.priority] ?? 'neutral'}>{a.priority}</Badge>
                        <span className="text-sm font-medium text-fg truncate">{a.title}</span>
                      </div>
                      {a.body ? <p className="mt-0.5 text-[0.857rem] text-fg-muted">{a.body}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </Panel>
      </div>
    </>
  );
}

function Chats({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Chat[]>(
    api, workspaceId, 'command.chats.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Chats" description="Universal chat and Conductor routing." />
        <Panel><OfflineState what="Chats" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title="Chats"
        description="Universal chat and Conductor routing. The agent runtime will be connected when WP-SWARM integrates."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Chat threads">
        {loading ? <LoadingState label="Loading chats" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={MessageSquare} title="No chats">
              Start a conversation to see it here. The agent runtime is not yet connected.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-1.5">
              {data.map((chat: Chat) => (
                <li key={chat.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-surface-2 transition-colors">
                  <span className="flex-1 truncate text-sm font-medium text-fg">{chat.title}</span>
                  {chat.agent_id ? (
                    <Badge tone="accent">Agent</Badge>
                  ) : null}
                  <Badge tone={chat.status === 'active' ? 'positive' : 'neutral'}>{chat.status}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function Approvals({ workspaceId, api }: ModulePageProps) {
  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Governance" title="Approvals inbox"
          description="Consequential actions waiting for your decision." />
        <Panel><OfflineState what="Approvals inbox" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Approvals inbox"
        description="Consequential actions waiting for your decision."
      />
      <Panel>
        <EmptyState icon={ShieldCheck} title="No pending approvals">
          Approval requests from agents and automated workflows will appear here.
        </EmptyState>
      </Panel>
    </>
  );
}

function Alerts({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Alert[]>(
    api, workspaceId, 'command.alerts.list', { includeDismissed: true },
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Alerts" description="Warnings and notifications that need attention." />
        <Panel><OfflineState what="Alerts" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title="Alerts"
        description="Warnings and notifications that need attention."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="All alerts">
        {loading ? <LoadingState label="Loading alerts" rows={5} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={AlertTriangle} title="No alerts">
              The system is quiet. Alerts appear here as the agent network runs.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((a: Alert) => (
                <li key={a.id} className="flex items-start gap-3 rounded-md border border-line p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                      <span className="text-sm font-medium text-fg">{a.title}</span>
                      {a.dismissed_at ? <Badge tone="neutral">Dismissed</Badge> : null}
                    </div>
                    {a.body ? <p className="mt-0.5 text-[0.857rem] text-fg-muted">{a.body}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function Blueprint({ workspaceId, api }: ModulePageProps) {
  const nodes = useCapability<BlueprintNode[]>(api, workspaceId, 'command.blueprint.nodes', {});

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Blueprint"
          description="Interactive system map of agents, connectors, stores and pages." />
        <Panel><OfflineState what="Blueprint" /></Panel>
      </>
    );
  }

  const KIND_COLOR: Record<string, string> = {
    operator: 'bg-accent-soft text-accent-text',
    agent: 'bg-positive-soft text-positive',
    department: 'bg-info-soft text-info',
    connector: 'bg-caution-soft text-caution',
    store: 'bg-negative-soft text-negative',
    page: 'bg-surface-3 text-fg-muted',
    daemon: 'bg-surface-3 text-fg-muted',
    model: 'bg-surface-3 text-fg-muted',
    skill: 'bg-surface-3 text-fg-muted',
  };

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title="Blueprint"
        description="Interactive system map of agents, connectors, stores and pages."
        actions={<Button size="sm" onClick={nodes.refresh}>Refresh</Button>}
      />
      <Panel title="System nodes">
        {nodes.loading ? <LoadingState label="Loading blueprint" rows={4} /> :
          nodes.error ? <ErrorState error={nodes.error} onRetry={nodes.refresh} /> :
          !nodes.data?.length ? (
            <EmptyState icon={Map} title="Blueprint empty">
              Nodes appear here as modules register their agents, connectors and stores.
            </EmptyState>
          ) : (
            <ul role="list" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {nodes.data.map((node: BlueprintNode) => (
                <li key={node.id}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
                  <span className={`inline-flex h-5 items-center rounded-sm px-1.5 text-[0.786rem] font-medium ${KIND_COLOR[node.kind] ?? 'bg-surface-3 text-fg-muted'}`}>
                    {node.kind}
                  </span>
                  <span className="truncate text-sm text-fg">{node.label}</span>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function Doctor({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<DoctorCheck[]>(
    api, workspaceId, 'command.doctor.checks', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Doctor" description="Diagnostic health checks across pillars." />
        <Panel><OfflineState what="Doctor" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title="Doctor"
        description="Diagnostic health checks across pillars."
        actions={<Button size="sm" onClick={refresh}>Run checks</Button>}
      />
      <Panel title="Health checks">
        {loading ? <LoadingState label="Running diagnostics" rows={5} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Stethoscope} title="No check results">
              Run diagnostics to see health status across all pillars.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-1.5">
              {data.map((check: DoctorCheck) => (
                <li key={check.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                  <Badge tone={HEALTH_TONE[check.status] ?? 'neutral'}>{check.status}</Badge>
                  <span className="flex-1 truncate text-sm font-medium text-fg font-mono">{check.check_id}</span>
                  {check.detail ? (
                    <span className="text-[0.857rem] text-fg-muted max-w-xs truncate">{check.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function Personas({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Persona[]>(
    api, workspaceId, 'command.personas.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Command" title="Personas" description="Business-type templates and workspace starting points." />
        <Panel><OfflineState what="Personas" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Command"
        title="Personas"
        description="Business-type templates and workspace starting points."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Business personas">
        {loading ? <LoadingState label="Loading personas" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Users} title="No personas">
              Personas provide pre-configured module setups for common business types.
            </EmptyState>
          ) : (
            <ul role="list" className="grid gap-3 sm:grid-cols-2">
              {data.map((p: Persona) => (
                <li key={p.id} className="rounded-md border border-line p-4">
                  <div className="font-semibold text-fg">{p.title}</div>
                  {p.summary ? (
                    <p className="mt-1 text-[0.857rem] text-fg-muted line-clamp-2">{p.summary}</p>
                  ) : null}
                  {p.north_star_metric ? (
                    <div className="mt-2 text-[0.786rem] text-fg-subtle">
                      North star: <span className="text-fg-muted">{p.north_star_metric}</span>
                    </div>
                  ) : null}
                  {p.pillars.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.pillars.map((pl: string) => (
                        <span key={pl} className="inline-flex h-5 items-center rounded-sm border border-line px-1.5 text-[0.714rem] text-fg-muted">
                          {pl}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

const ui: ModuleUi = {
  pages: {
    '': Home,
    chats: Chats,
    approvals: Approvals,
    alerts: Alerts,
    blueprint: Blueprint,
    doctor: Doctor,
    personas: Personas,
  },
};
export default ui;
