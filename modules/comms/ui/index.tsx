'use client';

import { Calendar, Inbox, Mic } from 'lucide-react';
import type { ModuleUi } from '@xyra/sdk/module-ui';
import type { ModulePageProps } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, LoadingState, OfflineState, PageHeader, Panel } from '@xyra/ui';
import { useCapability } from '@xyra/sdk/use-capability';

type Thread = {
  id: string;
  subject: string;
  channel: string;
  status: string;
  created_at: string | Date;
};

type Event = {
  id: string;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
  location: string | null;
  status: string;
};

type Meeting = {
  id: string;
  title: string;
  summary: string | null;
  recording_url: string | null;
  created_at: string | Date;
};

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  slack: 'Slack',
  sms: 'SMS',
  in_app: 'In-app',
};

const CHANNEL_TONE: Record<string, 'neutral' | 'accent' | 'info' | 'positive'> = {
  email: 'neutral',
  slack: 'accent',
  sms: 'info',
  in_app: 'positive',
};

function ThreadItem({ thread }: { thread: Thread }) {
  const tone = CHANNEL_TONE[thread.channel] ?? 'neutral';
  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge tone={tone}>{CHANNEL_LABELS[thread.channel] ?? thread.channel}</Badge>
          <span className="truncate text-sm font-medium text-fg">{thread.subject}</span>
        </div>
      </div>
      {thread.status === 'done' ? (
        <Badge tone="positive">Done</Badge>
      ) : thread.status === 'snoozed' ? (
        <Badge tone="caution">Snoozed</Badge>
      ) : null}
    </li>
  );
}

function InboxPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Thread[]>(
    api, workspaceId, 'comms.threads.list', { status: 'open' },
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Comms" title="Inbox" description="Unified three-pane inbox with keyboard triage." />
        <Panel><OfflineState what="Inbox" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Comms"
        title="Inbox"
        description="Unified three-pane inbox with keyboard triage."
        actions={
          <Button size="sm" onClick={refresh} aria-label="Refresh inbox">Refresh</Button>
        }
      />
      <Panel title="Open threads">
        {loading ? (
          <LoadingState label="Loading threads" rows={5} />
        ) : error ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : !data || data.length === 0 ? (
          <EmptyState icon={Inbox} title="Inbox zero">
            No open threads. Messages will appear here when connected.
          </EmptyState>
        ) : (
          <ul role="list" className="-mx-4 -my-4">
            {data.map((thread) => (
              <ThreadItem key={thread.id} thread={thread} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function CalendarPage({ workspaceId, api }: ModulePageProps) {
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data, loading, error, refresh } = useCapability<Event[]>(
    api, workspaceId, 'comms.events.list',
    { from: now.toISOString(), to: weekEnd.toISOString() },
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Comms" title="Calendar" description="Upcoming events and schedule." />
        <Panel><OfflineState what="Calendar" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Comms"
        title="Calendar"
        description="Upcoming events and schedule."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Next 7 days">
        {loading ? (
          <LoadingState label="Loading events" rows={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : !data || data.length === 0 ? (
          <EmptyState icon={Calendar} title="No upcoming events">
            Events will appear here when the calendar connector is active.
          </EmptyState>
        ) : (
          <ul role="list" className="space-y-2">
            {data.map((ev) => {
              const start = new Date(ev.starts_at);
              return (
                <li key={ev.id} className="flex items-start gap-3 rounded-md border border-line bg-surface p-3">
                  <div className="shrink-0 text-center">
                    <div className="text-[0.714rem] font-medium uppercase text-fg-subtle">
                      {start.toLocaleDateString(undefined, { weekday: 'short' })}
                    </div>
                    <div className="text-lg font-semibold leading-none text-fg">
                      {start.getDate()}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">{ev.title}</div>
                    <div className="mt-0.5 text-[0.857rem] text-fg-muted">
                      {start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      {' – '}
                      {new Date(ev.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      {ev.location ? ` · ${ev.location}` : ''}
                    </div>
                  </div>
                  <Badge tone={ev.status === 'confirmed' ? 'positive' : ev.status === 'cancelled' ? 'negative' : 'neutral'}>
                    {ev.status}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}

function MeetingsPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Meeting[]>(
    api, workspaceId, 'comms.meetings.list',
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Comms" title="Meetings" description="Recordings, summaries and follow-up actions." />
        <Panel><OfflineState what="Meetings" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Comms"
        title="Meetings"
        description="Recordings, summaries and follow-up actions."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Meeting records">
        {loading ? (
          <LoadingState label="Loading meetings" rows={3} />
        ) : error ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : !data || data.length === 0 ? (
          <EmptyState icon={Mic} title="No meetings recorded">
            Meeting records appear here after a call ends and notes are generated.
          </EmptyState>
        ) : (
          <ul role="list" className="space-y-2">
            {data.map((meeting) => (
              <li key={meeting.id} className="rounded-md border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-fg">{meeting.title}</span>
                  {meeting.recording_url ? (
                    <Badge tone="info">Recording</Badge>
                  ) : null}
                </div>
                {meeting.summary ? (
                  <p className="mt-1 text-[0.857rem] text-fg-muted line-clamp-2">{meeting.summary}</p>
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
    '': InboxPage,
    calendar: CalendarPage,
    meetings: MeetingsPage,
  },
};
export default ui;
