import type { CurrentMembership } from './model';

export type SyncClass = 'lww' | 'append' | 'local';
export type WriteAuthority = 'server' | 'synced' | 'append' | 'local';

export interface TableRule {
  readonly class: SyncClass;
  readonly authority: WriteAuthority;
  readonly permission?: string;
  readonly guardedColumns?: readonly string[];
  readonly allowedColumns?: readonly string[];
}

const SERVER: TableRule = { class: 'lww', authority: 'server' };
const APPEND: TableRule = { class: 'append', authority: 'append' };

/**
 * The frozen platform + ops manifests available at Worker implementation start.
 * An unknown table rejects rather than becoming device-writable. A generated
 * manifest feed is a required shared integration before more modules can sync.
 */
export const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  tenants: SERVER,
  workspaces: SERVER,
  users: SERVER,
  memberships: SERVER,
  approval_requests: APPEND,
  approval_decisions: SERVER,
  audit_events: APPEND,
  domain_events: APPEND,
  workspace_settings: SERVER,
  ops_projects: {
    class: 'lww',
    authority: 'synced',
    permission: 'ops:project:write',
    guardedColumns: ['status'],
    allowedColumns: ['name', 'description'],
  },
  ops_tasks: {
    class: 'lww',
    authority: 'synced',
    permission: 'ops:task:write',
    guardedColumns: ['status'],
    allowedColumns: ['project_id', 'title', 'description', 'assignee_id', 'due_at'],
  },
  sync_outbox: { class: 'local', authority: 'local' },
  sync_cursors: { class: 'local', authority: 'local' },
  sync_conflicts: { class: 'local', authority: 'local' },
};

const IMMUTABLE = new Set([
  'id',
  'tenant_id',
  'workspace_id',
  'created_by',
  'created_at',
  'tenantId',
  'workspaceId',
  'createdBy',
  'createdAt',
]);

export function hasPermission(membership: CurrentMembership, permission: string | undefined): boolean {
  if (membership.role === 'owner' || membership.role === 'admin') return true;
  // Rules without a named permission (append tables) still exclude read-only roles.
  if (permission === undefined) return membership.role !== 'viewer' && membership.role !== 'auditor';
  return membership.permissions.includes(permission);
}

export function forbiddenField(
  rule: TableRule,
  field: string,
): 'IMMUTABLE_FIELD' | 'GUARDED_FIELD' | 'INVALID_ROW' | null {
  if (IMMUTABLE.has(field)) return 'IMMUTABLE_FIELD';
  if (rule.guardedColumns?.includes(field)) return 'GUARDED_FIELD';
  if (rule.allowedColumns && !rule.allowedColumns.includes(field)) return 'INVALID_ROW';
  return null;
}
