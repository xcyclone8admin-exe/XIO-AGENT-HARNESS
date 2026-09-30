import { SERVER_STAMPED_FIELDS } from '@xyra/contracts';
import coreManifest from '@xyra/mod-core/manifest';
import opsManifest from '@xyra/mod-ops/manifest';
import type { CurrentMembership } from './model';

export type SyncClass = 'lww' | 'append' | 'local';
export type WriteAuthority = 'server' | 'synced' | 'append' | 'local';

export interface TableRule {
  readonly class: SyncClass;
  readonly authority: WriteAuthority;
  readonly permission?: string;
  readonly guardedColumns: readonly string[];
  /** Device-writable fields. Empty means every field is rejected (fail closed). */
  readonly allowedColumns: readonly string[];
  /** Column the Worker stamps with the verified principal on insert. */
  readonly actorField?: string;
}

interface DeclaredTable {
  readonly name: string;
  readonly class: SyncClass;
  readonly authority: WriteAuthority;
  readonly guardedColumns: readonly string[];
  readonly allowedFields?: readonly string[] | undefined;
  readonly actorField?: string | undefined;
  readonly writePermission?: string | undefined;
}

/**
 * Derived from module manifests, never hand-copied, so rules and manifests cannot drift.
 * An unknown table rejects rather than becoming device-writable. When more modules sync, the
 * generated registry feed replaces this import list with the same TABLE_RULES shape.
 */
function derive(tables: readonly DeclaredTable[]): Record<string, TableRule> {
  return Object.fromEntries(
    tables.map((table) => [
      table.name,
      {
        class: table.class,
        authority: table.authority,
        guardedColumns: table.guardedColumns,
        allowedColumns: table.allowedFields ?? [],
        ...(table.writePermission ? { permission: table.writePermission } : {}),
        ...(table.actorField ? { actorField: table.actorField } : {}),
      } satisfies TableRule,
    ]),
  );
}

export const TABLE_RULES: Readonly<Record<string, TableRule>> = derive([
  ...coreManifest.tables,
  ...opsManifest.tables,
]);

const STAMPED = new Set<string>(SERVER_STAMPED_FIELDS);

export function hasPermission(membership: CurrentMembership, permission: string | undefined): boolean {
  if (membership.role === 'owner' || membership.role === 'admin') return true;
  // Rules without a named permission still exclude read-only roles.
  if (permission === undefined) return membership.role !== 'viewer' && membership.role !== 'auditor';
  return membership.permissions.includes(permission);
}

export function forbiddenField(
  rule: TableRule,
  field: string,
): 'IMMUTABLE_FIELD' | 'ACTOR_FIELD' | 'GUARDED_FIELD' | 'INVALID_ROW' | null {
  if (rule.actorField === field) return 'ACTOR_FIELD';
  if (STAMPED.has(field)) return 'IMMUTABLE_FIELD';
  if (rule.guardedColumns.includes(field)) return 'GUARDED_FIELD';
  if (!rule.allowedColumns.includes(field)) return 'INVALID_ROW';
  return null;
}
