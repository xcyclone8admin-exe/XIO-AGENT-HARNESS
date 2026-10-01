import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type { Channel, ThreadStatus } from '../contracts';

export interface ThreadRow extends Record<string, unknown> {
  id: string;
  subject: string;
  channel: Channel;
  status: ThreadStatus;
  participants: unknown[];
  labels: string[];
  snoozed_until: Date | null;
  created_at: Date;
}

export interface MessageRow extends Record<string, unknown> {
  id: string;
  thread_id: string;
  body: string;
  direction: 'inbound' | 'outbound';
  external_id: string | null;
  send_approval_id: string | null;
  created_at: Date;
}

export interface EventRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  attendees: unknown[];
  status: 'tentative' | 'confirmed' | 'cancelled';
}

export interface MeetingRow extends Record<string, unknown> {
  id: string;
  title: string;
  event_id: string | null;
  summary: string | null;
  action_items: unknown[];
  recording_url: string | null;
  created_at: Date;
}

export class CommsService {
  constructor(private readonly store: LocalScopedStore) {}

  async threads(scope: Scope, status?: ThreadStatus, channel?: Channel): Promise<ThreadRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (status) { conditions.push(`status=$${params.push(status)}`); }
    if (channel) { conditions.push(`channel=$${params.push(channel)}`); }
    const result = await this.store.query<ThreadRow>(scope,
      `SELECT id,subject,channel,status,participants,labels,snoozed_until,created_at
       FROM comms_threads WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params);
    return result.rows;
  }

  async createThread(scope: Scope, actorId: string, subject: string, channel: Channel): Promise<ThreadRow> {
    const result = await this.store.query<ThreadRow>(scope,
      `INSERT INTO comms_threads(id,tenant_id,workspace_id,subject,channel,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,subject,channel,status,participants,labels,snoozed_until,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, subject, channel, actorId]);
    if (!result.rows[0]) throw new Error('Thread insert failed');
    return result.rows[0];
  }

  async snoozeThread(scope: Scope, threadId: string, until: string): Promise<ThreadRow | null> {
    const result = await this.store.query<ThreadRow>(scope,
      `UPDATE comms_threads SET status='snoozed',snoozed_until=$1,updated_at=now()
       WHERE id=$2 AND workspace_id=$3
       RETURNING id,subject,channel,status,participants,labels,snoozed_until,created_at`,
      [until, threadId, scope.workspaceId]);
    return result.rows[0] ?? null;
  }

  async doneThread(scope: Scope, threadId: string): Promise<ThreadRow | null> {
    const result = await this.store.query<ThreadRow>(scope,
      `UPDATE comms_threads SET status='done',updated_at=now()
       WHERE id=$1 AND workspace_id=$2
       RETURNING id,subject,channel,status,participants,labels,snoozed_until,created_at`,
      [threadId, scope.workspaceId]);
    return result.rows[0] ?? null;
  }

  async messages(scope: Scope, threadId: string): Promise<MessageRow[]> {
    const result = await this.store.query<MessageRow>(scope,
      `SELECT id,thread_id,body,direction,external_id,send_approval_id,created_at
       FROM comms_messages WHERE workspace_id=$1 AND thread_id=$2 ORDER BY created_at ASC`,
      [scope.workspaceId, threadId]);
    return result.rows;
  }

  async appendOutboundMessage(scope: Scope, actorId: string, threadId: string, body: string,
    approvalId?: string): Promise<MessageRow> {
    const result = await this.store.query<MessageRow>(scope,
      `INSERT INTO comms_messages(id,tenant_id,workspace_id,thread_id,body,direction,send_approval_id,created_by)
       VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7)
       RETURNING id,thread_id,body,direction,external_id,send_approval_id,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, threadId, body, approvalId ?? null, actorId]);
    if (!result.rows[0]) throw new Error('Message insert failed');
    return result.rows[0];
  }

  async events(scope: Scope, from?: string, to?: string): Promise<EventRow[]> {
    const conditions = ['workspace_id=$1'];
    const params: unknown[] = [scope.workspaceId];
    if (from) { conditions.push(`starts_at >= $${params.push(from)}`); }
    if (to) { conditions.push(`starts_at <= $${params.push(to)}`); }
    const result = await this.store.query<EventRow>(scope,
      `SELECT id,title,description,starts_at,ends_at,location,attendees,status
       FROM comms_events WHERE ${conditions.join(' AND ')} ORDER BY starts_at ASC`,
      params);
    return result.rows;
  }

  async createEvent(scope: Scope, actorId: string, title: string, startsAt: string, endsAt: string,
    location?: string, description?: string): Promise<EventRow> {
    const result = await this.store.query<EventRow>(scope,
      `INSERT INTO comms_events(id,tenant_id,workspace_id,title,starts_at,ends_at,location,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,title,description,starts_at,ends_at,location,attendees,status`,
      [uuidv7(), scope.tenantId, scope.workspaceId, title, startsAt, endsAt,
        location ?? null, description ?? null, actorId]);
    if (!result.rows[0]) throw new Error('Event insert failed');
    return result.rows[0];
  }

  async meetings(scope: Scope): Promise<MeetingRow[]> {
    const result = await this.store.query<MeetingRow>(scope,
      `SELECT id,title,event_id,summary,action_items,recording_url,created_at
       FROM comms_meetings WHERE workspace_id=$1 ORDER BY created_at DESC`,
      [scope.workspaceId]);
    return result.rows;
  }
}
