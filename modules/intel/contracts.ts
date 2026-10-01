import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

export const UUID = z.uuid();

export const TargetKind = z.enum(['company', 'project', 'topic']);
export const WatchlistTarget = z.object({
  name: z.string().min(1).max(200),
  kind: TargetKind,
  externalRef: z.string().max(500).nullable().default(null),
});
export type WatchlistTarget = z.infer<typeof WatchlistTarget>;

export const Watchlist = z.object({
  id: UUID,
  workspaceId: UUID,
  name: z.string().min(1).max(200),
  targets: z.array(WatchlistTarget),
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Watchlist = z.infer<typeof Watchlist>;
export const WatchlistCreate = z.object({
  name: z.string().min(1).max(200),
  targets: z.array(WatchlistTarget).min(1).max(100),
});
export const WatchlistList = z.object({});

export const SourceKind = z.enum(['feed', 'filing', 'news', 'manual']);
export const Source = z.object({
  id: UUID,
  workspaceId: UUID,
  identifier: z.string().min(1).max(2000),
  title: z.string().min(1).max(500),
  kind: SourceKind,
  addedBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Source = z.infer<typeof Source>;
export const SourceAdd = z.object({
  identifier: z.string().min(1).max(2000),
  title: z.string().min(1).max(500),
  kind: SourceKind,
});
export const SourceList = z.object({});

/**
 * Fixture/manual-input driven change detection (NOT a live crawler). Each call supplies the
 * observed content snapshot for one or more sources, deterministically diffed against the
 * last recorded snapshot per source. Wiring a real fetch/poll loop is a future integration,
 * owned outside this module.
 */
export const ObservedSnapshot = z.object({
  sourceId: UUID,
  content: z.string().min(1).max(200000),
  observedAt: z.iso.datetime({ offset: true }).optional(),
});
export type ObservedSnapshot = z.infer<typeof ObservedSnapshot>;
export const ChangeDetect = z.object({
  watchlistId: UUID,
  snapshots: z.array(ObservedSnapshot).min(1).max(200),
});

export const ChangeEvent = z.object({
  id: UUID,
  watchlistId: UUID,
  sourceId: UUID,
  previousSnapshotId: UUID.nullable(),
  currentSnapshotId: UUID,
  detectedAt: z.iso.datetime({ offset: true }),
  summary: z.string(),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;
export const ChangeDetectResult = z.object({ events: z.array(ChangeEvent) });
export const ChangeEventsList = z.object({ watchlistId: UUID });

export const Citation = z.object({
  id: UUID,
  claimId: UUID,
  sourceId: UUID.nullable(),
  changeEventId: UUID.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Citation = z.infer<typeof Citation>;

export const CitationInput = z
  .object({
    sourceId: UUID.nullable().default(null),
    changeEventId: UUID.nullable().default(null),
  })
  .refine((c) => c.sourceId !== null || c.changeEventId !== null, {
    message: 'INTEL_CLAIM_REQUIRES_CITATION',
  });
export type CitationInput = z.infer<typeof CitationInput>;

export const Claim = z.object({
  id: UUID,
  briefId: UUID,
  claimText: z.string().min(1).max(4000),
  relevanceScore: z.number(),
  citations: z.array(Citation).min(1),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Claim = z.infer<typeof Claim>;

export const Brief = z.object({
  id: UUID,
  workspaceId: UUID,
  watchlistId: UUID,
  generatedAt: z.iso.datetime({ offset: true }),
  generatedBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  claims: z.array(Claim),
});
export type Brief = z.infer<typeof Brief>;

export const BriefGenerate = z.object({ watchlistId: UUID });
export const BriefList = z.object({ watchlistId: UUID.optional() });
export const BriefGet = z.object({ briefId: UUID });

/** Pure, deterministic relevance scoring input (unit-testable without a database). */
export const RelevanceScoreInput = z.object({
  text: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  observedAt: z.iso.datetime({ offset: true }),
  now: z.iso.datetime({ offset: true }),
});
export const RelevanceScoreResult = z.object({ score: z.number() });
export type RelevanceScoreResult = z.infer<typeof RelevanceScoreResult>;

export const RouteKind = z.enum(['task', 'workflow']);
export const RoutedTo = z
  .object({ kind: RouteKind, externalId: z.string().min(1).max(500) })
  .nullable();
export type RoutedTo = z.infer<typeof RoutedTo>;

export const Recommendation = z.object({
  id: UUID,
  workspaceId: UUID,
  briefId: UUID.nullable(),
  claimId: UUID.nullable(),
  text: z.string().min(1).max(4000),
  routedTo: RoutedTo,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Recommendation = z.infer<typeof Recommendation>;
export const RecommendationCreate = z.object({
  briefId: UUID.nullable().default(null),
  claimId: UUID.nullable().default(null),
  text: z.string().min(1).max(4000),
});
export const RecommendationList = z.object({});

export const ScheduleDescribe = z.object({ watchlistId: UUID });
export const ScheduleDescriptor = z.object({
  watchlistId: UUID,
  cron: z.string().nullable(),
  enabled: z.boolean(),
});
export type ScheduleDescriptor = z.infer<typeof ScheduleDescriptor>;

export const intelCapabilities = {
  watchlistCreate: defineCapability({
    id: 'intel.watchlist.create',
    title: 'Create watchlist',
    description: 'Create a watchlist of companies, projects or topics to track',
    kind: 'write',
    permission: 'intel:watchlist:write',
    input: WatchlistCreate,
    output: Watchlist,
  }),
  watchlistList: defineCapability({
    id: 'intel.watchlist.list',
    title: 'List watchlists',
    description: 'List workspace watchlists',
    kind: 'read',
    permission: 'intel:watchlist:read',
    input: WatchlistList,
    output: z.array(Watchlist),
  }),
  sourceAdd: defineCapability({
    id: 'intel.source.add',
    title: 'Add source',
    description: 'Register a source (feed, filing, news or manual) to observe',
    kind: 'write',
    permission: 'intel:source:write',
    input: SourceAdd,
    output: Source,
  }),
  sourceList: defineCapability({
    id: 'intel.source.list',
    title: 'List sources',
    description: 'List workspace sources',
    kind: 'read',
    permission: 'intel:source:read',
    input: SourceList,
    output: z.array(Source),
  }),
  changeDetect: defineCapability({
    id: 'intel.change.detect',
    title: 'Detect changes',
    description:
      'Fixture/manual-input driven: diffs supplied observed source snapshots against the last recorded snapshot per source and emits change events on difference. Not a live crawler.',
    kind: 'write',
    permission: 'intel:change:write',
    input: ChangeDetect,
    output: ChangeDetectResult,
  }),
  changeEventsList: defineCapability({
    id: 'intel.change.events.list',
    title: 'List change events',
    description: 'List recorded change events for a watchlist',
    kind: 'read',
    permission: 'intel:change:read',
    input: ChangeEventsList,
    output: z.array(ChangeEvent),
  }),
  briefGenerate: defineCapability({
    id: 'intel.brief.generate',
    title: 'Generate brief',
    description:
      'Generate a brief for a watchlist from recorded change events; every claim must carry at least one citation referencing a source or change event that exists in this tenant/workspace scope',
    kind: 'consequential',
    permission: 'intel:brief:write',
    input: BriefGenerate,
    output: Brief,
  }),
  briefList: defineCapability({
    id: 'intel.brief.list',
    title: 'List briefs',
    description: 'List generated briefs, optionally filtered by watchlist',
    kind: 'read',
    permission: 'intel:brief:read',
    input: BriefList,
    output: z.array(Brief),
  }),
  briefGet: defineCapability({
    id: 'intel.brief.get',
    title: 'Get brief',
    description: 'Get a brief with all its claims and citations',
    kind: 'read',
    permission: 'intel:brief:read',
    input: BriefGet,
    output: Brief,
  }),
  relevanceScore: defineCapability({
    id: 'intel.relevance.score',
    title: 'Score relevance',
    description:
      'Pure deterministic scoring (weighted recency + keyword/target match). Does not touch the database.',
    kind: 'read',
    permission: 'intel:brief:read',
    input: RelevanceScoreInput,
    output: RelevanceScoreResult,
  }),
  recommendationCreate: defineCapability({
    id: 'intel.recommendation.create',
    title: 'Create recommendation',
    description:
      'Create a recommendation referencing a brief/claim; routedTo defaults to null (unrouted). Cross-module routing into modules/command, modules/flow or modules/connect is an integration owned outside this module.',
    kind: 'write',
    permission: 'intel:recommendation:write',
    input: RecommendationCreate,
    output: Recommendation,
  }),
  recommendationList: defineCapability({
    id: 'intel.recommendation.list',
    title: 'List recommendations',
    description: 'List workspace recommendations, honestly showing routed vs unrouted',
    kind: 'read',
    permission: 'intel:recommendation:read',
    input: RecommendationList,
    output: z.array(Recommendation),
  }),
  scheduleDescribe: defineCapability({
    id: 'intel.schedule.describe',
    title: 'Describe watchlist schedule',
    description: 'Typed schedule descriptor only; does not bind a real Cloudflare Cron Trigger',
    kind: 'read',
    permission: 'intel:watchlist:read',
    input: ScheduleDescribe,
    output: ScheduleDescriptor,
  }),
} as const;
