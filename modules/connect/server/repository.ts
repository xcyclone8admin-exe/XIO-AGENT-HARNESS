import type { LocalScopedStore, Scope } from '@xyra/db';
import { randomUUID } from 'node:crypto';
import type { ConnectorGrantRecord, ConnectorGrantRequest, ConnectorRecord } from '../contracts';

export interface ConnectActor {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

interface ConnectorRow extends Record<string, unknown> {
  id: string;
  name: string;
  family: string;
  state: string;
  detail: string;
  checked_at: string | null;
  availability: string;
  custody: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  connector_id: string;
  action: string;
  allowed_tools: unknown;
  reason: string;
  created_by: string;
  created_at: string;
}

/**
 * CONNECT persistence. The catalog table is code-owned (only registerConnector, called by the
 * owning integration's bootstrap, ever inserts a row) so a listing can never surface a connector
 * no integration actually registered.
 */
export class ConnectRepository {
  constructor(private readonly store: LocalScopedStore) {}

  async listConnectors(actor: ConnectActor): Promise<ConnectorRecord[]> {
    const scope: Scope = { tenantId: actor.tenantId, workspaceId: actor.workspaceId };
    const result = await this.store.query<ConnectorRow>(
      scope,
      'SELECT id, name, family, state, detail, checked_at, availability, custody, created_by, created_at, updated_at FROM connect_connectors ORDER BY name',
    );
    return result.rows.map(toConnectorRecord);
  }

  async registerConnector(
    actor: ConnectActor,
    entry: { id: string; name: string; family: string; availability: 'available' | 'not-yet-available'; custody: 'local-keychain' | 'cloud-envelope' | 'none' },
  ): Promise<void> {
    const scope: Scope = { tenantId: actor.tenantId, workspaceId: actor.workspaceId };
    await this.store.query(
      scope,
      `INSERT INTO connect_connectors (id, tenant_id, workspace_id, name, family, state, detail, checked_at, availability, custody, created_by)
       VALUES ($1, $2, $3, $4, $5, 'NOT_CONFIGURED', $6, NULL, $7, $8, $9)`,
      [entry.id, actor.tenantId, actor.workspaceId, entry.name, entry.family, 'Registered; not yet configured.', entry.availability, entry.custody, actor.id],
    );
  }

  async recordGrant(actor: ConnectActor, request: ConnectorGrantRequest): Promise<ConnectorGrantRecord> {
    const scope: Scope = { tenantId: actor.tenantId, workspaceId: actor.workspaceId };
    const id = randomUUID();
    const existing = await this.store.query<ConnectorRow>(
      scope,
      'SELECT id FROM connect_connectors WHERE id = $1',
      [request.connectorId],
    );
    if (existing.rows.length === 0) throw new Error('CONNECT_CONNECTOR_NOT_REGISTERED');
    await this.store.query(
      scope,
      `INSERT INTO connect_grants (id, tenant_id, workspace_id, connector_id, action, allowed_tools, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, actor.tenantId, actor.workspaceId, request.connectorId, request.action, JSON.stringify(request.allowedTools), request.reason, actor.id],
    );
    const row = await this.store.query<GrantRow>(
      scope,
      'SELECT id, connector_id, action, allowed_tools, reason, created_by, created_at FROM connect_grants WHERE id = $1',
      [id],
    );
    return toGrantRecord(row.rows[0] as GrantRow);
  }

  /** The active grant for a connector is the most recent grant/revoke decision, never an aggregate. */
  async currentGrant(actor: ConnectActor, connectorId: string): Promise<ConnectorGrantRecord | null> {
    const scope: Scope = { tenantId: actor.tenantId, workspaceId: actor.workspaceId };
    const result = await this.store.query<GrantRow>(
      scope,
      'SELECT id, connector_id, action, allowed_tools, reason, created_by, created_at FROM connect_grants WHERE connector_id = $1 ORDER BY created_at DESC LIMIT 1',
      [connectorId],
    );
    const row = result.rows[0];
    return row ? toGrantRecord(row) : null;
  }
}

function toConnectorRecord(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    name: row.name,
    family: row.family,
    state: row.state as ConnectorRecord['state'],
    detail: row.detail,
    checkedAt: row.checked_at,
    availability: row.availability as ConnectorRecord['availability'],
    custody: row.custody as ConnectorRecord['custody'],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGrantRecord(row: GrantRow): ConnectorGrantRecord {
  return {
    id: row.id,
    connectorId: row.connector_id,
    action: row.action as ConnectorGrantRecord['action'],
    allowedTools: Array.isArray(row.allowed_tools) ? (row.allowed_tools as string[]) : [],
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
