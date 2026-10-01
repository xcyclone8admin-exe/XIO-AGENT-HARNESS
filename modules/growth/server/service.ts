import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type { DealStatus, SequenceStatus } from '../contracts';

export interface ContactRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  segment: string | null;
  tags: string[];
  custom: Record<string, unknown>;
  created_at: Date;
}

export interface CompanyRow extends Record<string, unknown> {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size_band: string | null;
  tags: string[];
  created_at: Date;
}

export interface DealRow extends Record<string, unknown> {
  id: string;
  title: string;
  contact_id: string | null;
  company_id: string | null;
  pipeline: string;
  stage: string;
  value_cents: number | null;
  currency: string | null;
  expected_close_at: Date | null;
  status: DealStatus;
  created_at: Date;
}

export interface SequenceRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  steps: unknown[];
  status: SequenceStatus;
  send_approval_policy: string | null;
  created_at: Date;
}

export interface FunnelRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: 'neural' | 'radial' | 'linear';
  stages: unknown[];
  metrics: Record<string, unknown>;
  created_at: Date;
}

export interface ContentPostRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  channels: string[];
  scheduled_at: Date | null;
  status: 'draft' | 'scheduled' | 'published' | 'failed';
  publish_approval_id: string | null;
  created_at: Date;
}

export interface AdCampaignRow extends Record<string, unknown> {
  id: string;
  name: string;
  platform: string;
  autonomy_mode: 'manual' | 'supervised' | 'autonomous';
  daily_budget_cents: number | null;
  total_budget_cents: number | null;
  currency: string | null;
  status: 'draft' | 'active' | 'paused' | 'ended';
  spend_approval_policy: string | null;
  created_at: Date;
}

export interface BrandDealRow extends Record<string, unknown> {
  id: string;
  title: string;
  partner_name: string;
  partner_contact: string | null;
  value_cents: number | null;
  currency: string | null;
  deliverables: unknown[];
  starts_at: Date | null;
  ends_at: Date | null;
  status: string;
  created_at: Date;
}

export class GrowthService {
  constructor(private readonly store: LocalScopedStore) {}

  async contacts(scope: Scope, segment?: string, q?: string): Promise<ContactRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (segment) { conditions.push(`segment=$${params.push(segment)}`); }
    if (q) { conditions.push(`name ILIKE $${params.push(`%${q}%`)}`); }
    const result = await this.store.query<ContactRow>(scope,
      `SELECT id,name,email,phone,company_id,segment,tags,custom,created_at
       FROM growth_contacts WHERE ${conditions.join(' AND ')} ORDER BY name ASC`,
      params);
    return result.rows;
  }

  async createContact(scope: Scope, actorId: string, name: string,
    opts: { email?: string; phone?: string; company_id?: string; segment?: string }): Promise<ContactRow> {
    const result = await this.store.query<ContactRow>(scope,
      `INSERT INTO growth_contacts(id,tenant_id,workspace_id,name,email,phone,company_id,segment,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,name,email,phone,company_id,segment,tags,custom,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, name,
        opts.email ?? null, opts.phone ?? null, opts.company_id ?? null, opts.segment ?? null, actorId]);
    if (!result.rows[0]) throw new Error('Contact insert failed');
    return result.rows[0];
  }

  async companies(scope: Scope): Promise<CompanyRow[]> {
    const result = await this.store.query<CompanyRow>(scope,
      `SELECT id,name,domain,industry,size_band,tags,created_at
       FROM growth_companies WHERE workspace_id=$1 ORDER BY name ASC`,
      [scope.workspaceId]);
    return result.rows;
  }

  async deals(scope: Scope, pipeline?: string, status?: DealStatus): Promise<DealRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (pipeline) { conditions.push(`pipeline=$${params.push(pipeline)}`); }
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    const result = await this.store.query<DealRow>(scope,
      `SELECT id,title,contact_id,company_id,pipeline,stage,value_cents,currency,expected_close_at,status,created_at
       FROM growth_deals WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params);
    return result.rows;
  }

  async createDeal(scope: Scope, actorId: string, title: string, pipeline: string, stage: string,
    opts: { contact_id?: string; company_id?: string; value_cents?: number; currency?: string }): Promise<DealRow> {
    const result = await this.store.query<DealRow>(scope,
      `INSERT INTO growth_deals(id,tenant_id,workspace_id,title,pipeline,stage,contact_id,company_id,value_cents,currency,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id,title,contact_id,company_id,pipeline,stage,value_cents,currency,expected_close_at,status,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, title, pipeline, stage,
        opts.contact_id ?? null, opts.company_id ?? null, opts.value_cents ?? null, opts.currency ?? null, actorId]);
    if (!result.rows[0]) throw new Error('Deal insert failed');
    return result.rows[0];
  }

  async sequences(scope: Scope, status?: SequenceStatus): Promise<SequenceRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    const result = await this.store.query<SequenceRow>(scope,
      `SELECT id,name,description,steps,status,send_approval_policy,created_at
       FROM growth_sequences WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params);
    return result.rows;
  }

  async enrollContact(scope: Scope, actorId: string, sequenceId: string, contactId: string,
    approvalId?: string): Promise<void> {
    await this.store.query(scope,
      `INSERT INTO growth_sequence_enrollments(id,tenant_id,workspace_id,sequence_id,contact_id,send_approval_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), scope.tenantId, scope.workspaceId, sequenceId, contactId, approvalId ?? null, actorId]);
  }

  async funnels(scope: Scope): Promise<FunnelRow[]> {
    const result = await this.store.query<FunnelRow>(scope,
      `SELECT id,name,kind,stages,metrics,created_at FROM growth_funnels
       WHERE workspace_id=$1 ORDER BY created_at DESC`,
      [scope.workspaceId]);
    return result.rows;
  }

  async contentPosts(scope: Scope, status?: string): Promise<ContentPostRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    const result = await this.store.query<ContentPostRow>(scope,
      `SELECT id,title,body,channels,scheduled_at,status,publish_approval_id,created_at
       FROM growth_content_posts WHERE ${conditions.join(' AND ')} ORDER BY scheduled_at DESC NULLS LAST, created_at DESC`,
      params);
    return result.rows;
  }

  async adCampaigns(scope: Scope, status?: string): Promise<AdCampaignRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    const result = await this.store.query<AdCampaignRow>(scope,
      `SELECT id,name,platform,autonomy_mode,daily_budget_cents,total_budget_cents,currency,status,spend_approval_policy,created_at
       FROM growth_ad_campaigns WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params);
    return result.rows;
  }

  async brandDeals(scope: Scope, status?: string): Promise<BrandDealRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    const result = await this.store.query<BrandDealRow>(scope,
      `SELECT id,title,partner_name,partner_contact,value_cents,currency,deliverables,starts_at,ends_at,status,created_at
       FROM growth_brand_deals WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params);
    return result.rows;
  }
}
