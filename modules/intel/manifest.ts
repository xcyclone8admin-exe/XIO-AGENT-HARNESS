import type { ColumnSpec } from '@xyra/contracts';
import { defineModule } from '@xyra/contracts';
import type { z } from 'zod';

type ColumnSpecInput = z.input<typeof ColumnSpec>;

const WATCHLIST_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  name: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 200 },
  created_by: { type: 'uuid', requiredOnInsert: true },
  created_at: { type: 'timestamptz' },
  updated_at: { type: 'timestamptz' },
};

const WATCHLIST_TARGET_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  watchlist_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_watchlists' } },
  name: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 200 },
  kind: { type: 'text', requiredOnInsert: true, enum: ['company', 'project', 'topic'] },
  external_ref: { type: 'text', nullable: true },
};

const SOURCE_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  identifier: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 2000 },
  title: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 500 },
  kind: { type: 'text', requiredOnInsert: true, enum: ['feed', 'filing', 'news', 'manual'] },
  added_by: { type: 'uuid', requiredOnInsert: true },
  created_at: { type: 'timestamptz' },
};

const SOURCE_SNAPSHOT_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  source_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_sources' } },
  content_hash: { type: 'text', requiredOnInsert: true },
  content: { type: 'text', requiredOnInsert: true },
  observed_at: { type: 'timestamptz' },
};

const CHANGE_EVENT_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  watchlist_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_watchlists' } },
  source_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_sources' } },
  previous_snapshot_id: { type: 'uuid', nullable: true, references: { table: 'intel_source_snapshots' } },
  current_snapshot_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_source_snapshots' } },
  detected_at: { type: 'timestamptz' },
  summary: { type: 'text', requiredOnInsert: true },
};

const BRIEF_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  watchlist_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_watchlists' } },
  generated_at: { type: 'timestamptz' },
  generated_by: { type: 'uuid', requiredOnInsert: true },
  created_at: { type: 'timestamptz' },
};

const BRIEF_CLAIM_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  brief_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_briefs' } },
  claim_text: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 4000 },
  relevance_score: { type: 'numeric', requiredOnInsert: true },
  created_at: { type: 'timestamptz' },
};

const BRIEF_CITATION_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  claim_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'intel_brief_claims' } },
  source_id: { type: 'uuid', nullable: true, references: { table: 'intel_sources' } },
  change_event_id: { type: 'uuid', nullable: true, references: { table: 'intel_change_events' } },
  created_at: { type: 'timestamptz' },
};

const RECOMMENDATION_COLUMNS: Record<string, ColumnSpecInput> = {
  id: { type: 'uuid', requiredOnInsert: true },
  brief_id: { type: 'uuid', nullable: true, references: { table: 'intel_briefs' } },
  claim_id: { type: 'uuid', nullable: true, references: { table: 'intel_brief_claims' } },
  text: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 4000 },
  routed_kind: { type: 'text', nullable: true, enum: ['task', 'workflow'] },
  routed_external_id: { type: 'text', nullable: true },
  created_at: { type: 'timestamptz' },
};

export default defineModule({
  id: 'intel',
  version: '1.0.0',
  pillar: 'INTEL',
  title: 'Intel',
  description:
    'Source-backed personalized industry/project intelligence: watchlists, fixture-driven change detection, cited briefs, deterministic relevance scoring and recommendations.',
  icon: 'radar',
  requirements: ['XIO-REQ-INT-001'],
  permissions: [
    'intel:watchlist:read',
    'intel:watchlist:write',
    'intel:source:read',
    'intel:source:write',
    'intel:change:read',
    'intel:change:write',
    'intel:brief:read',
    'intel:brief:write',
    'intel:recommendation:read',
    'intel:recommendation:write',
  ],
  roleGrants: {
    owner: [
      'intel:watchlist:read', 'intel:watchlist:write', 'intel:source:read', 'intel:source:write',
      'intel:change:read', 'intel:change:write', 'intel:brief:read', 'intel:brief:write',
      'intel:recommendation:read', 'intel:recommendation:write',
    ],
    admin: [
      'intel:watchlist:read', 'intel:watchlist:write', 'intel:source:read', 'intel:source:write',
      'intel:change:read', 'intel:change:write', 'intel:brief:read', 'intel:brief:write',
      'intel:recommendation:read', 'intel:recommendation:write',
    ],
    manager: [
      'intel:watchlist:read', 'intel:watchlist:write', 'intel:source:read', 'intel:source:write',
      'intel:change:read', 'intel:change:write', 'intel:brief:read', 'intel:brief:write',
      'intel:recommendation:read', 'intel:recommendation:write',
    ],
    member: [
      'intel:watchlist:read', 'intel:watchlist:write', 'intel:source:read', 'intel:source:write',
      'intel:change:read', 'intel:brief:read', 'intel:recommendation:read', 'intel:recommendation:write',
    ],
    viewer: ['intel:watchlist:read', 'intel:source:read', 'intel:change:read', 'intel:brief:read', 'intel:recommendation:read'],
    auditor: ['intel:watchlist:read', 'intel:source:read', 'intel:change:read', 'intel:brief:read', 'intel:recommendation:read'],
  },
  nav: [
    { path: '', title: 'Overview', keywords: ['watchlists', 'intel'] },
    { path: 'sources', title: 'Sources', keywords: ['feeds', 'filings', 'news'] },
    { path: 'briefs', title: 'Briefs', keywords: ['brief', 'claims', 'citations'] },
    { path: 'recommendations', title: 'Recommendations', keywords: ['recommendations', 'routing'] },
  ],
  dependsOn: [],
  tables: [
    {
      name: 'intel_watchlists',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['name'],
      actorField: 'created_by',
      writePermission: 'intel:watchlist:write',
      readPermission: 'intel:watchlist:read',
      columns: WATCHLIST_COLUMNS,
      serverReadCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_watchlist_targets',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['name', 'kind', 'external_ref'],
      writePermission: 'intel:watchlist:write',
      readPermission: 'intel:watchlist:read',
      columns: WATCHLIST_TARGET_COLUMNS,
      serverReadCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_sources',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['identifier', 'title', 'kind'],
      actorField: 'added_by',
      writePermission: 'intel:source:write',
      readPermission: 'intel:source:read',
      columns: SOURCE_COLUMNS,
      serverReadCapabilities: ['intel_brief_generate', 'intel_change_detect'],
    },
    {
      name: 'intel_source_snapshots',
      class: 'append',
      authority: 'append',
      receivedAtField: 'observed_at',
      writePermission: 'intel:change:write',
      readPermission: 'intel:change:read',
      columns: SOURCE_SNAPSHOT_COLUMNS,
      serverWriteCapabilities: ['intel_change_detect'],
      serverReadCapabilities: ['intel_change_detect', 'intel_brief_generate'],
    },
    {
      name: 'intel_change_events',
      class: 'append',
      authority: 'append',
      receivedAtField: 'detected_at',
      writePermission: 'intel:change:write',
      readPermission: 'intel:change:read',
      columns: CHANGE_EVENT_COLUMNS,
      serverWriteCapabilities: ['intel_change_detect'],
      serverReadCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_briefs',
      class: 'append',
      authority: 'append',
      receivedAtField: 'created_at',
      writePermission: 'intel:brief:write',
      readPermission: 'intel:brief:read',
      columns: BRIEF_COLUMNS,
      serverWriteCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_brief_claims',
      class: 'append',
      authority: 'append',
      receivedAtField: 'created_at',
      writePermission: 'intel:brief:write',
      readPermission: 'intel:brief:read',
      columns: BRIEF_CLAIM_COLUMNS,
      serverWriteCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_brief_citations',
      class: 'append',
      authority: 'append',
      receivedAtField: 'created_at',
      writePermission: 'intel:brief:write',
      readPermission: 'intel:brief:read',
      columns: BRIEF_CITATION_COLUMNS,
      serverWriteCapabilities: ['intel_brief_generate'],
    },
    {
      name: 'intel_recommendations',
      class: 'append',
      authority: 'append',
      receivedAtField: 'created_at',
      writePermission: 'intel:recommendation:write',
      readPermission: 'intel:recommendation:read',
      columns: RECOMMENDATION_COLUMNS,
      serverWriteCapabilities: ['intel_recommendation_create'],
    },
  ],
});
