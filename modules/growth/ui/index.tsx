'use client';

import {
  BarChart2,
  Briefcase,
  Calendar,
  Megaphone,
  Repeat,
  Target,
  Users,
} from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, LoadingState, OfflineState, PageHeader, Panel, Stat } from '@xyra/ui';
import { useCapability } from '@xyra/sdk/use-capability';

type Contact = { id: string; name: string; email: string | null; segment: string | null; created_at: string | Date };
type Company = { id: string; name: string; domain: string | null; industry: string | null; size_band: string | null };
type Deal = { id: string; title: string; pipeline: string; stage: string; value_cents: number | null; currency: string | null; status: string };
type Sequence = { id: string; name: string; status: string; send_approval_policy: string | null; created_at: string | Date };
type Funnel = { id: string; name: string; kind: string; stages: unknown[]; metrics: Record<string, unknown> };
type ContentPost = { id: string; title: string; channels: string[]; scheduled_at: string | Date | null; status: string };
type AdCampaign = { id: string; name: string; platform: string; autonomy_mode: string; daily_budget_cents: number | null; status: string };
type BrandDeal = { id: string; title: string; partner_name: string; value_cents: number | null; currency: string | null; status: string };

const STATUS_TONE: Record<string, 'neutral' | 'positive' | 'negative' | 'caution' | 'info' | 'accent'> = {
  open: 'accent',
  won: 'positive',
  lost: 'negative',
  active: 'positive',
  draft: 'neutral',
  paused: 'caution',
  archived: 'neutral',
  prospecting: 'info',
  negotiating: 'caution',
  completed: 'positive',
  cancelled: 'negative',
  scheduled: 'info',
  published: 'positive',
  failed: 'negative',
  ended: 'neutral',
};

function fmtMoney(cents: number | null, currency: string | null) {
  if (cents == null) return '—';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : (currency ?? '');
  return `${sym}${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function CrmPage({ workspaceId, api }: ModulePageProps) {
  const contacts = useCapability<Contact[]>(api, workspaceId, 'growth.contacts.list', {});
  const companies = useCapability<Company[]>(api, workspaceId, 'growth.companies.list', {});
  const deals = useCapability<Deal[]>(api, workspaceId, 'growth.deals.list', {});

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="CRM" description="Contacts, companies, deals and pipeline." />
        <Panel><OfflineState what="CRM" /></Panel>
      </>
    );
  }

  const totalValue = (deals.data ?? [])
    .filter((d) => d.status === 'open')
    .reduce((sum, d) => sum + (d.value_cents ?? 0), 0);

  return (
    <>
      <PageHeader eyebrow="Growth" title="CRM" description="Contacts, companies, deals and pipeline." />
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Panel>
          <Stat label="Contacts" value={contacts.loading ? '—' : String(contacts.data?.length ?? 0)} />
        </Panel>
        <Panel>
          <Stat label="Companies" value={companies.loading ? '—' : String(companies.data?.length ?? 0)} />
        </Panel>
        <Panel>
          <Stat label="Open pipeline" value={deals.loading ? '—' : fmtMoney(totalValue, 'USD')} />
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel
          title="Contacts"
          actions={<Button size="sm" onClick={contacts.refresh}>Refresh</Button>}
        >
          {contacts.loading ? <LoadingState label="Loading contacts" rows={4} /> :
            contacts.error ? <ErrorState error={contacts.error} onRetry={contacts.refresh} /> :
            !contacts.data?.length ? (
              <EmptyState icon={Users} title="No contacts">Add contacts to build your CRM.</EmptyState>
            ) : (
              <ul role="list" className="space-y-1.5">
                {contacts.data.slice(0, 10).map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate font-medium text-fg">{c.name}</span>
                    {c.email ? <span className="text-fg-muted text-[0.857rem]">{c.email}</span> : null}
                    {c.segment ? <Badge tone="neutral">{c.segment}</Badge> : null}
                  </li>
                ))}
                {contacts.data.length > 10 ? (
                  <li className="text-[0.857rem] text-fg-muted">+{contacts.data.length - 10} more</li>
                ) : null}
              </ul>
            )}
        </Panel>

        <Panel
          title="Open deals"
          actions={<Button size="sm" onClick={deals.refresh}>Refresh</Button>}
        >
          {deals.loading ? <LoadingState label="Loading deals" rows={4} /> :
            deals.error ? <ErrorState error={deals.error} onRetry={deals.refresh} /> :
            !deals.data?.length ? (
              <EmptyState icon={Briefcase} title="No deals">Create deals to track your pipeline.</EmptyState>
            ) : (
              <ul role="list" className="space-y-1.5">
                {deals.data.filter((d) => d.status === 'open').slice(0, 10).map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate font-medium text-fg">{d.title}</span>
                    <span className="shrink-0 text-[0.857rem] text-fg-muted">{d.stage}</span>
                    <span className="shrink-0 text-[0.857rem] font-medium text-fg">
                      {fmtMoney(d.value_cents, d.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </Panel>
      </div>
    </>
  );
}

function SequencesPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Sequence[]>(
    api, workspaceId, 'growth.sequences.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="Sequences" description="Outreach sequences with approval-gated sends." />
        <Panel><OfflineState what="Sequences" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Growth"
        title="Sequences"
        description="Outreach sequences with approval-gated sends."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Sequences">
        {loading ? <LoadingState label="Loading sequences" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Repeat} title="No sequences">
              Build outreach sequences to automate contact follow-up.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((seq) => (
                <li key={seq.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{seq.name}</div>
                    {seq.send_approval_policy ? (
                      <div className="text-[0.857rem] text-fg-muted">Approval required to send</div>
                    ) : null}
                  </div>
                  <Badge tone={STATUS_TONE[seq.status] ?? 'neutral'}>{seq.status}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function FunnelsPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<Funnel[]>(
    api, workspaceId, 'growth.funnels.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="Funnels" description="Neural flow and radial wheel conversion funnels." />
        <Panel><OfflineState what="Funnels" /></Panel>
      </>
    );
  }

  const KIND_ICON: Record<string, string> = { neural: '⬡', radial: '◎', linear: '→' };

  return (
    <>
      <PageHeader
        eyebrow="Growth"
        title="Funnels"
        description="Neural flow and radial wheel conversion funnels."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Funnels">
        {loading ? <LoadingState label="Loading funnels" rows={3} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Target} title="No funnels">
              Create a funnel to visualise conversion from awareness to close.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                  <span className="text-xl" aria-hidden>{KIND_ICON[f.kind] ?? '→'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{f.name}</div>
                    <div className="text-[0.857rem] text-fg-muted">
                      {Array.isArray(f.stages) ? f.stages.length : 0} stages
                    </div>
                  </div>
                  <Badge tone="neutral">{f.kind}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function ContentPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<ContentPost[]>(
    api, workspaceId, 'growth.content.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="Content" description="Social content calendar with approval-gated publishing." />
        <Panel><OfflineState what="Content" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Growth"
        title="Content"
        description="Social content calendar with approval-gated publishing."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Content calendar">
        {loading ? <LoadingState label="Loading posts" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Calendar} title="No content scheduled">
              Create posts and schedule them to appear on connected channels.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((post) => (
                <li key={post.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{post.title}</div>
                    <div className="text-[0.857rem] text-fg-muted">
                      {post.scheduled_at
                        ? new Date(post.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : 'Unscheduled'}
                      {post.channels.length > 0 ? ` · ${post.channels.join(', ')}` : ''}
                    </div>
                  </div>
                  <Badge tone={STATUS_TONE[post.status] ?? 'neutral'}>{post.status}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function AdsPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<AdCampaign[]>(
    api, workspaceId, 'growth.ads.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="Ads" description="AdPilot campaigns with autonomy modes and spend caps." />
        <Panel><OfflineState what="Ads" /></Panel>
      </>
    );
  }

  const AUTONOMY_TONE: Record<string, 'neutral' | 'caution' | 'positive'> = {
    manual: 'neutral',
    supervised: 'caution',
    autonomous: 'positive',
  };

  return (
    <>
      <PageHeader
        eyebrow="Growth"
        title="Ads"
        description="AdPilot campaigns with autonomy modes and spend caps."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Ad campaigns">
        {loading ? <LoadingState label="Loading campaigns" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={Megaphone} title="No ad campaigns">
              Create a campaign and configure spend caps before activation.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((c) => (
                <li key={c.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{c.name}</div>
                    <div className="text-[0.857rem] text-fg-muted">
                      {c.platform}
                      {c.daily_budget_cents != null ? ` · ${fmtMoney(c.daily_budget_cents, 'USD')}/day` : ''}
                    </div>
                  </div>
                  <Badge tone={AUTONOMY_TONE[c.autonomy_mode] ?? 'neutral'}>{c.autonomy_mode}</Badge>
                  <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </>
  );
}

function BrandDealsPage({ workspaceId, api }: ModulePageProps) {
  const { data, loading, error, refresh } = useCapability<BrandDeal[]>(
    api, workspaceId, 'growth.brand.list', {},
  );

  if (!api || !workspaceId) {
    return (
      <>
        <PageHeader eyebrow="Growth" title="Brand Deals" description="Partnerships, sponsorships and collaborations." />
        <Panel><OfflineState what="Brand Deals" /></Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Growth"
        title="Brand Deals"
        description="Partnerships, sponsorships and collaborations."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>}
      />
      <Panel title="Brand deals">
        {loading ? <LoadingState label="Loading deals" rows={4} /> :
          error ? <ErrorState error={error} onRetry={refresh} /> :
          !data?.length ? (
            <EmptyState icon={BarChart2} title="No brand deals">
              Track partnership deals and sponsorship agreements here.
            </EmptyState>
          ) : (
            <ul role="list" className="space-y-2">
              {data.map((deal) => (
                <li key={deal.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg truncate">{deal.title}</div>
                    <div className="text-[0.857rem] text-fg-muted">{deal.partner_name}</div>
                  </div>
                  {deal.value_cents != null ? (
                    <span className="text-sm font-medium text-fg">{fmtMoney(deal.value_cents, deal.currency)}</span>
                  ) : null}
                  <Badge tone={STATUS_TONE[deal.status] ?? 'neutral'}>{deal.status}</Badge>
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
    '': CrmPage,
    sequences: SequencesPage,
    funnels: FunnelsPage,
    content: ContentPage,
    ads: AdsPage,
    'brand-deals': BrandDealsPage,
  },
};
export default ui;
