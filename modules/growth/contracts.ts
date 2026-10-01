import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

const Empty = z.object({});

const DealStatusSchema = z.enum(['open', 'won', 'lost']);
const SequenceStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
const ContentStatusSchema = z.enum(['draft', 'scheduled', 'published', 'failed']);
const AdStatusSchema = z.enum(['draft', 'active', 'paused', 'ended']);
const AutonomyModeSchema = z.enum(['manual', 'supervised', 'autonomous']);
const BrandDealStatusSchema = z.enum(['prospecting', 'negotiating', 'active', 'completed', 'cancelled']);
const FunnelKindSchema = z.enum(['neural', 'radial', 'linear']);

export type DealStatus = z.infer<typeof DealStatusSchema>;
export type SequenceStatus = z.infer<typeof SequenceStatusSchema>;

const Contact = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company_id: z.uuid().nullable(),
  segment: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  custom: z.record(z.string(), z.unknown()).default({}),
  created_at: z.union([z.date(), z.string()]),
});

const Company = z.object({
  id: z.uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  size_band: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  created_at: z.union([z.date(), z.string()]),
});

const Deal = z.object({
  id: z.uuid(),
  title: z.string(),
  contact_id: z.uuid().nullable(),
  company_id: z.uuid().nullable(),
  pipeline: z.string(),
  stage: z.string(),
  value_cents: z.number().int().nullable(),
  currency: z.string().nullable(),
  expected_close_at: z.union([z.date(), z.string()]).nullable(),
  status: DealStatusSchema,
  created_at: z.union([z.date(), z.string()]),
});

const Sequence = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  steps: z.array(z.unknown()).default([]),
  status: SequenceStatusSchema,
  send_approval_policy: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const Funnel = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: FunnelKindSchema,
  stages: z.array(z.unknown()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  created_at: z.union([z.date(), z.string()]),
});

const ContentPost = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  channels: z.array(z.string()).default([]),
  scheduled_at: z.union([z.date(), z.string()]).nullable(),
  status: ContentStatusSchema,
  publish_approval_id: z.uuid().nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const AdCampaign = z.object({
  id: z.uuid(),
  name: z.string(),
  platform: z.string(),
  autonomy_mode: AutonomyModeSchema,
  daily_budget_cents: z.number().int().nullable(),
  total_budget_cents: z.number().int().nullable(),
  currency: z.string().nullable(),
  status: AdStatusSchema,
  spend_approval_policy: z.string().nullable(),
  created_at: z.union([z.date(), z.string()]),
});

const BrandDeal = z.object({
  id: z.uuid(),
  title: z.string(),
  partner_name: z.string(),
  partner_contact: z.string().nullable(),
  value_cents: z.number().int().nullable(),
  currency: z.string().nullable(),
  deliverables: z.array(z.unknown()).default([]),
  starts_at: z.union([z.date(), z.string()]).nullable(),
  ends_at: z.union([z.date(), z.string()]).nullable(),
  status: BrandDealStatusSchema,
  created_at: z.union([z.date(), z.string()]),
});

export const growthCapabilities = {
  contacts: defineCapability({
    id: 'growth.contacts.list',
    title: 'List contacts',
    description: 'List CRM contacts',
    kind: 'read',
    permission: 'growth:contact:read',
    input: z.object({ segment: z.string().optional(), q: z.string().optional() }),
    output: z.array(Contact),
  }),

  createContact: defineCapability({
    id: 'growth.contacts.create',
    title: 'Create contact',
    description: 'Create a CRM contact',
    kind: 'write',
    permission: 'growth:contact:write',
    input: z.object({
      name: z.string().trim().min(1).max(300),
      email: z.string().email().max(320).optional(),
      phone: z.string().max(30).optional(),
      company_id: z.uuid().optional(),
      segment: z.string().max(100).optional(),
    }),
    output: Contact,
  }),

  companies: defineCapability({
    id: 'growth.companies.list',
    title: 'List companies',
    description: 'List CRM companies',
    kind: 'read',
    permission: 'growth:contact:read',
    input: Empty,
    output: z.array(Company),
  }),

  deals: defineCapability({
    id: 'growth.deals.list',
    title: 'List deals',
    description: 'List pipeline deals',
    kind: 'read',
    permission: 'growth:deal:read',
    input: z.object({ pipeline: z.string().optional(), status: DealStatusSchema.optional() }),
    output: z.array(Deal),
  }),

  createDeal: defineCapability({
    id: 'growth.deals.create',
    title: 'Create deal',
    description: 'Create a pipeline deal',
    kind: 'write',
    permission: 'growth:deal:write',
    input: z.object({
      title: z.string().trim().min(1).max(300),
      pipeline: z.string().trim().min(1).max(100),
      stage: z.string().trim().min(1).max(100),
      contact_id: z.uuid().optional(),
      company_id: z.uuid().optional(),
      value_cents: z.number().int().positive().optional(),
      currency: z.string().length(3).optional(),
    }),
    output: Deal,
  }),

  sequences: defineCapability({
    id: 'growth.sequences.list',
    title: 'List sequences',
    description: 'List outreach sequences',
    kind: 'read',
    permission: 'growth:sequence:read',
    input: z.object({ status: SequenceStatusSchema.optional() }),
    output: z.array(Sequence),
  }),

  enroll: defineCapability({
    id: 'growth.sequences.enroll',
    title: 'Enroll contact',
    description: 'Enroll a contact in an outreach sequence (requires approval)',
    kind: 'consequential',
    permission: 'growth:sequence:send',
    risk: 'high',
    approvalPolicy: 'growth.sequence.send',
    input: z.object({ sequenceId: z.uuid(), contactId: z.uuid() }),
    output: z.object({ queued: z.boolean(), approvalId: z.uuid().nullable() }),
  }),

  funnels: defineCapability({
    id: 'growth.funnels.list',
    title: 'List funnels',
    description: 'List conversion funnels',
    kind: 'read',
    permission: 'growth:funnel:read',
    input: Empty,
    output: z.array(Funnel),
  }),

  contentPosts: defineCapability({
    id: 'growth.content.list',
    title: 'List content posts',
    description: 'List content calendar posts',
    kind: 'read',
    permission: 'growth:content:read',
    input: z.object({ status: ContentStatusSchema.optional() }),
    output: z.array(ContentPost),
  }),

  publishPost: defineCapability({
    id: 'growth.content.publish',
    title: 'Publish post',
    description: 'Schedule or publish a content post (requires approval)',
    kind: 'consequential',
    permission: 'growth:content:publish',
    risk: 'high',
    approvalPolicy: 'growth.content.publish',
    input: z.object({ postId: z.uuid(), scheduledAt: z.string().datetime().optional() }),
    output: z.object({ queued: z.boolean(), approvalId: z.uuid().nullable() }),
  }),

  adCampaigns: defineCapability({
    id: 'growth.ads.list',
    title: 'List ad campaigns',
    description: 'List AdPilot campaigns',
    kind: 'read',
    permission: 'growth:ad:read',
    input: z.object({ status: AdStatusSchema.optional() }),
    output: z.array(AdCampaign),
  }),

  spendAd: defineCapability({
    id: 'growth.ads.spend',
    title: 'Authorize ad spend',
    description: 'Authorize budget activation or increase for an ad campaign (requires approval)',
    kind: 'consequential',
    permission: 'growth:ad:spend',
    risk: 'high',
    approvalPolicy: 'growth.ad.spend',
    input: z.object({ campaignId: z.uuid(), amountCents: z.number().int().positive() }),
    output: z.object({ queued: z.boolean(), approvalId: z.uuid().nullable() }),
  }),

  brandDeals: defineCapability({
    id: 'growth.brand.list',
    title: 'List brand deals',
    description: 'List brand partnership deals',
    kind: 'read',
    permission: 'growth:brand:read',
    input: z.object({ status: BrandDealStatusSchema.optional() }),
    output: z.array(BrandDeal),
  }),
} as const;
