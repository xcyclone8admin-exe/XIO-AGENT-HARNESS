import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type {
  AlertSeverity,
  ActionPriority,
  BlueprintNodeKind,
  ChatStatus,
} from '../contracts';

export interface ChatRow extends Record<string, unknown> {
  id: string;
  title: string;
  agent_id: string | null;
  status: ChatStatus;
  created_at: Date;
}

export interface ChatMessageRow extends Record<string, unknown> {
  id: string;
  chat_id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  created_at: Date;
}

export interface AlertRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  dismissed_at: Date | null;
  created_at: Date;
}

export interface ActionRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  priority: ActionPriority;
  done_at: Date | null;
  dismissed_at: Date | null;
  created_at: Date;
}

export interface BlueprintNodeRow extends Record<string, unknown> {
  id: string;
  label: string;
  kind: BlueprintNodeKind;
  x: number;
  y: number;
  meta: Record<string, unknown>;
}

export interface BlueprintEdgeRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  target_id: string;
  label: string | null;
}

export interface PersonaRow extends Record<string, unknown> {
  id: string;
  title: string;
  summary: string;
  north_star_metric: string | null;
  pillars: string[];
}

export interface DoctorCheckRow extends Record<string, unknown> {
  id: string;
  check_id: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  detail: string;
  created_at: Date;
}

export class CommandService {
  constructor(private readonly store: LocalScopedStore) {}

  async dashboardSummary(scope: Scope): Promise<{
    greeting: string;
    systems_live: number;
    systems_total: number;
    agents_live: number;
    agents_total: number;
    pending_approvals: number;
    unread_alerts: number;
  }> {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const unread = await this.store.query<{ count: number } & Record<string, unknown>>(scope,
      'SELECT count(*)::int AS count FROM command_alerts WHERE workspace_id=$1 AND dismissed_at IS NULL',
      [scope.workspaceId]);
    const pending = await this.store.query<{ count: number } & Record<string, unknown>>(scope,
      'SELECT count(*)::int AS count FROM approval_requests WHERE workspace_id=$1 AND expires_at > now()',
      [scope.workspaceId]);
    return {
      greeting,
      systems_live: 0,
      systems_total: 0,
      agents_live: 0,
      agents_total: 0,
      pending_approvals: Number(pending.rows[0]?.count ?? 0),
      unread_alerts: Number(unread.rows[0]?.count ?? 0),
    };
  }

  async chats(scope: Scope): Promise<ChatRow[]> {
    const result = await this.store.query<ChatRow>(scope,
      `SELECT id,title,agent_id,status,created_at FROM command_chats
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }

  async createChat(scope: Scope, actorId: string, title: string): Promise<ChatRow> {
    const result = await this.store.query<ChatRow>(scope,
      `INSERT INTO command_chats(id,tenant_id,workspace_id,title,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,title,agent_id,status,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, title, actorId]);
    if (!result.rows[0]) throw new Error('Chat insert failed');
    return result.rows[0];
  }

  async chatMessages(scope: Scope, chatId: string): Promise<ChatMessageRow[]> {
    const result = await this.store.query<ChatMessageRow>(scope,
      `SELECT id,chat_id,role,content,created_at FROM command_chat_messages
       WHERE workspace_id=$1 AND chat_id=$2 ORDER BY created_at ASC`, [scope.workspaceId, chatId]);
    return result.rows;
  }

  async sendChatMessage(scope: Scope, actorId: string, chatId: string, role: ChatMessageRow['role'],
    content: string): Promise<ChatMessageRow> {
    const result = await this.store.query<ChatMessageRow>(scope,
      `INSERT INTO command_chat_messages(id,tenant_id,workspace_id,chat_id,role,content,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,chat_id,role,content,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, chatId, role, content, actorId]);
    if (!result.rows[0]) throw new Error('Message insert failed');
    return result.rows[0];
  }

  async alerts(scope: Scope, includeDismissed = false): Promise<AlertRow[]> {
    const sql = includeDismissed
      ? `SELECT id,title,body,severity,dismissed_at,created_at FROM command_alerts
         WHERE workspace_id=$1 ORDER BY created_at DESC`
      : `SELECT id,title,body,severity,dismissed_at,created_at FROM command_alerts
         WHERE workspace_id=$1 AND dismissed_at IS NULL ORDER BY created_at DESC`;
    const result = await this.store.query<AlertRow>(scope, sql, [scope.workspaceId]);
    return result.rows;
  }

  async createAlert(scope: Scope, actorId: string, title: string, body: string,
    severity: AlertSeverity): Promise<AlertRow> {
    const result = await this.store.query<AlertRow>(scope,
      `INSERT INTO command_alerts(id,tenant_id,workspace_id,title,body,severity,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,body,severity,dismissed_at,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, title, body, severity, actorId]);
    if (!result.rows[0]) throw new Error('Alert insert failed');
    return result.rows[0];
  }

  async dismissAlert(scope: Scope, alertId: string): Promise<AlertRow | null> {
    const result = await this.store.query<AlertRow>(scope,
      `UPDATE command_alerts SET dismissed_at=now(),updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING id,title,body,severity,dismissed_at,created_at`,
      [alertId, scope.workspaceId]);
    return result.rows[0] ?? null;
  }

  async actions(scope: Scope, includeDone = false): Promise<ActionRow[]> {
    const sql = includeDone
      ? `SELECT id,title,body,priority,done_at,dismissed_at,created_at FROM command_actions
         WHERE workspace_id=$1 ORDER BY created_at DESC`
      : `SELECT id,title,body,priority,done_at,dismissed_at,created_at FROM command_actions
         WHERE workspace_id=$1 AND done_at IS NULL AND dismissed_at IS NULL ORDER BY created_at DESC`;
    const result = await this.store.query<ActionRow>(scope, sql, [scope.workspaceId]);
    return result.rows;
  }

  async createAction(scope: Scope, actorId: string, title: string, body: string,
    priority: ActionPriority): Promise<ActionRow> {
    const result = await this.store.query<ActionRow>(scope,
      `INSERT INTO command_actions(id,tenant_id,workspace_id,title,body,priority,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,body,priority,done_at,dismissed_at,created_at`,
      [uuidv7(), scope.tenantId, scope.workspaceId, title, body, priority, actorId]);
    if (!result.rows[0]) throw new Error('Action insert failed');
    return result.rows[0];
  }

  async completeAction(scope: Scope, actionId: string): Promise<ActionRow | null> {
    const result = await this.store.query<ActionRow>(scope,
      `UPDATE command_actions SET done_at=now(),updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING id,title,body,priority,done_at,dismissed_at,created_at`,
      [actionId, scope.workspaceId]);
    return result.rows[0] ?? null;
  }

  async blueprintNodes(scope: Scope): Promise<BlueprintNodeRow[]> {
    const result = await this.store.query<BlueprintNodeRow>(scope,
      `SELECT id,label,kind,x,y,meta FROM command_blueprint_nodes
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }

  async blueprintEdges(scope: Scope): Promise<BlueprintEdgeRow[]> {
    const result = await this.store.query<BlueprintEdgeRow>(scope,
      `SELECT id,source_id,target_id,label FROM command_blueprint_edges
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }

  async doctorChecks(scope: Scope): Promise<DoctorCheckRow[]> {
    const result = await this.store.query<DoctorCheckRow>(scope,
      `SELECT id,check_id,status,detail,created_at FROM command_doctor_checks
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }

  async personas(scope: Scope): Promise<PersonaRow[]> {
    const result = await this.store.query<PersonaRow>(scope,
      `SELECT id,title,summary,north_star_metric,pillars FROM command_personas
       WHERE workspace_id=$1 ORDER BY created_at DESC`, [scope.workspaceId]);
    return result.rows;
  }
}
