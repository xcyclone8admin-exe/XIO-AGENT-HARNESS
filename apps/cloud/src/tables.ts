import { SERVER_STAMPED_FIELDS, type ColumnSpec, type ModuleManifest } from '@xyra/contracts';
import coreManifest from '@xyra/mod-core/manifest';
import brainManifest from '@xyra/mod-brain/manifest';
import opsManifest from '@xyra/mod-ops/manifest';
import swarmManifest from '@xyra/mod-swarm/manifest';

export type SyncClass = 'lww' | 'append' | 'local';
export type WriteAuthority = 'server' | 'synced' | 'append' | 'local';

export interface TableRule {
  readonly name: string;
  readonly class: SyncClass;
  readonly authority: WriteAuthority;
  /** The owning module's manifest: the policy source for this table's permissions. */
  readonly manifest: ModuleManifest;
  readonly permission?: string;
  /** Absent: any current workspace member may read. */
  readonly readPermission?: string;
  readonly guardedColumns: readonly string[];
  /** Device-writable fields. Empty means every field is rejected (fail closed). */
  readonly allowedColumns: readonly string[];
  /** Column the Worker stamps with the verified principal on insert. */
  readonly actorField?: string;
  /** Column the Worker stamps with server receipt time on insert. */
  readonly receivedAtField?: string;
  /** Typed column specs; a writable table without them rejects every row (fail closed). */
  readonly columns: ReadonlyMap<string, ColumnSpec>;
}

function derive(manifests: readonly ModuleManifest[]): ReadonlyMap<string, TableRule> {
  const rules = new Map<string, TableRule>();
  for (const manifest of manifests) {
    for (const table of manifest.tables) {
      const readPermission = table.readPermission;
      const receivedAtField = table.receivedAtField;
      rules.set(table.name, {
        name: table.name,
        class: table.class,
        authority: table.authority,
        manifest,
        guardedColumns: table.guardedColumns,
        allowedColumns: table.allowedFields ?? [],
        columns: new Map(Object.entries(table.columns ?? {})),
        ...(table.writePermission ? { permission: table.writePermission } : {}),
        ...(readPermission ? { readPermission } : {}),
        ...(table.actorField ? { actorField: table.actorField } : {}),
        ...(receivedAtField ? { receivedAtField } : {}),
      });
    }
  }
  return rules;
}

/**
 * Derived from module manifests, never hand-copied. A Map, not an object: an inherited name such
 * as `constructor` must never resolve to a rule (CLD-R-012). The generated registry feed replaces
 * the manifest list when more modules sync.
 */
export const MANIFESTS: readonly ModuleManifest[] = [coreManifest, brainManifest, opsManifest, swarmManifest];
export const TABLE_RULES: ReadonlyMap<string, TableRule> = derive(MANIFESTS);

export function ruleFor(table: string): TableRule | undefined {
  return TABLE_RULES.get(table);
}

const STAMPED = new Set<string>(SERVER_STAMPED_FIELDS);

export function forbiddenField(
  rule: TableRule,
  field: string,
): 'IMMUTABLE_FIELD' | 'ACTOR_FIELD' | 'GUARDED_FIELD' | 'INVALID_ROW' | null {
  if (rule.actorField === field) return 'ACTOR_FIELD';
  if (STAMPED.has(field) || rule.receivedAtField === field) return 'IMMUTABLE_FIELD';
  if (rule.guardedColumns.includes(field)) return 'GUARDED_FIELD';
  if (!rule.allowedColumns.includes(field)) return 'INVALID_ROW';
  return null;
}
