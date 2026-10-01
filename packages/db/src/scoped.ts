import type { PGlite } from '@electric-sql/pglite';

export interface Scope {
  readonly tenantId: string;
  readonly workspaceId: string;
}
export interface RowResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
}
export interface ScopedTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<RowResult<T>>;
}

/** Statements a scoped query may start with; everything else (DO, COPY, SET, DDL, ...) is refused. */
const ALLOWED_LEADING = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
/** Role and session escapes that must not appear anywhere in a scoped statement (ADR-0005 A1 §C). */
const FORBIDDEN_ANYWHERE =
  /\bset_config\s*\(|\bSESSION\s+AUTHORIZATION\b|\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b|\bRESET\b/i;

/** Rejects anything but one code-owned DML statement without role or session escapes. */
export function assertScopedStatement(sql: string): void {
  if (sql.includes(';') || /\/\*|--/.test(sql))
    throw new Error('Scoped query must be one code-owned statement');
  if (!ALLOWED_LEADING.test(sql) || FORBIDDEN_ANYWHERE.test(sql))
    throw new Error('Scoped query must be DML without role or session changes');
}

/** SQL here is code-owned and parameterized; no user or agent supplied SQL enters this API. */
export class LocalScopedStore {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(
    scope: Scope,
    sql: string,
    params: unknown[] = [],
  ): Promise<RowResult<T>> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new Error('Invalid query scope');
    }
    assertScopedStatement(sql);
    return this.db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE xyra_app');
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await tx.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const role = await tx.query<{ current_user: string }>('SELECT current_user');
      if (role.rows[0]?.current_user !== 'xyra_app') throw new Error('Local app role not active');
      const result = await tx.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    });
  }

  /**
   * Run code-owned capability writes as the non-login server role in one tenant/workspace-scoped
   * transaction. `xyra_server` is never available through LocalScopedStore.query or client SQL.
   */
  async withServerScope<T>(
    scope: Scope,
    capability: string,
    hlc: string | undefined,
    work: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new Error('Invalid query scope');
    }
    if (hlc !== undefined && !/^\d{13}-[0-9a-f]{4}-[a-z0-9]{1,32}$/.test(hlc)) {
      throw new Error('Invalid workspace HLC');
    }
    if (hlc !== undefined && Number(hlc.slice(0, 13)) > Date.now() + 60_000) {
      throw new Error('Workspace HLC is too far in the future');
    }
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(capability)) throw new Error('Invalid server capability');
    const roleName = `xyra_cap_${capability}`;
    return this.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${roleName}`);
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await tx.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await tx.query("SELECT set_config('app.hlc', $1, true)", [hlc ?? '']);
      const role = await tx.query<{ current_user: string }>('SELECT current_user');
      if (role.rows[0]?.current_user !== roleName) throw new Error('Local capability role not active');
      const client: ScopedTransaction = {
        query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          assertScopedStatement(sql);
          const result = await tx.query<T>(sql, params);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      };
      return work(client);
    });
  }
}

/** Structural subset of a manifest TableDecl (packages/db does not depend on contracts). */
export interface GrantedTable {
  readonly name: string;
  readonly class: 'lww' | 'append' | 'local';
  /** Manifest authority; server tables are readable but never writable by the app role. */
  readonly authority?: 'server' | 'synced' | 'append' | 'local';
  /** Module capabilities own writes to these columns; local SQL cannot update them. */
  readonly guardedColumns?: readonly string[];
  /** Columns the app role may never write; UPDATE is then granted per column on the rest. */
  readonly privilegedColumns?: readonly string[];
  /** Only these named capability roles may write this relation as trusted code. */
  readonly serverWriteCapabilities?: readonly string[];
}

/** Platform bookkeeping relations that no module manifest declares. */
const PLATFORM_TABLES = ['sync_outbox', 'sync_conflicts', 'sync_cursors', 'capability_idempotency'];
/**
 * The trusted sidecar calls this after migrations; PGlite's login remains a superuser.
 * `xyra_app` is the local app/sync role and follows manifest authority. Trusted writers use
 * manifest-declared per-capability roles, each granted only its explicitly named relations.
 * The legacy `xyra_server` role receives platform bookkeeping access only. No module table gets
 * an implicit privileged grant, and all roles remain subject to table RLS.
 */
export async function prepareLocalAppRole(db: PGlite, tables: readonly GrantedTable[] = []): Promise<void> {
  const append = new Set<string>();
  const mutable = new Set<string>(PLATFORM_TABLES);
  const privileged = new Map<string, readonly string[]>();
  const readOnly = new Set<string>();
  const declarations = new Map<string, GrantedTable>();
  const capabilityTables = new Map<string, Set<string>>();
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table.name)) throw new Error(`Invalid table name ${table.name}`);
    declarations.set(table.name, table);
    for (const capability of table.serverWriteCapabilities ?? []) {
      if (!/^[a-z][a-z0-9_]{1,47}$/.test(capability)) throw new Error(`Invalid server capability ${capability}`);
      const granted = capabilityTables.get(capability) ?? new Set<string>();
      granted.add(table.name);
      capabilityTables.set(capability, granted);
    }
    const authority = table.authority ?? (table.class === 'append' ? 'append' : table.class === 'local' ? 'local' : 'synced');
    if (authority === 'server') {
      readOnly.add(table.name);
      mutable.delete(table.name);
      append.delete(table.name);
    } else if (authority === 'append' || table.class === 'append') {
      append.add(table.name);
      mutable.delete(table.name);
    } else if ((table.guardedColumns?.length ?? 0) || (table.privilegedColumns?.length ?? 0)) {
      const columns = [...new Set([...(table.guardedColumns ?? []), ...(table.privilegedColumns ?? [])])];
      for (const column of columns) {
        if (!/^[a-z][a-z0-9_]*$/.test(column)) throw new Error(`Invalid guarded column ${column} on ${table.name}`);
      }
      privileged.set(table.name, columns);
      mutable.delete(table.name);
    } else if (authority === 'local' || authority === 'synced') {
      mutable.add(table.name);
    }
  }
  const names = [...new Set([...PLATFORM_TABLES, ...declarations.keys()])];
  const existingCapabilities = await db.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'xyra_cap_%'",
  );
  const managedRoles = [...new Set([
    'xyra_app',
    'xyra_server',
    ...existingCapabilities.rows.map((row) => row.rolname),
    ...[...capabilityTables.keys()].map((capability) => `xyra_cap_${capability}`),
  ])];
  const columnsByTable = new Map<string, string[]>();
  const revokes: string[] = [];
  for (const name of names) {
    const described = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [name],
    );
    if (!described.rows.length) throw new Error(`Table ${name} does not exist`);
    const allColumns = described.rows.map((row) => row.column_name);
    columnsByTable.set(name, allColumns);
    // Privileges are additive. Clear table and column grants for both managed roles, including
    // stale server-role access, before reapplying the current declarations.
    const roleList = managedRoles.join(', ');
    revokes.push(`REVOKE INSERT, UPDATE, DELETE ON ${name} FROM ${roleList}`);
    if (allColumns.length) {
      revokes.push(`REVOKE UPDATE (${allColumns.join(', ')}) ON ${name} FROM ${roleList}`);
      revokes.push(`REVOKE INSERT (${allColumns.join(', ')}) ON ${name} FROM ${roleList}`);
    }
  }
  const appGrants = [
    `GRANT SELECT, INSERT, UPDATE ON ${[...mutable].join(', ')} TO xyra_app`,
    ...(append.size ? [`GRANT SELECT, INSERT ON ${[...append].join(', ')} TO xyra_app`] : []),
    ...[...readOnly].map((name) => `GRANT SELECT ON ${name} TO xyra_app`),
    ...[...privileged].flatMap(([name, blocked]) => {
      const updatable = (columnsByTable.get(name) ?? []).filter((column) => !blocked.includes(column));
      return [
        `GRANT SELECT, INSERT ON ${name} TO xyra_app`,
        ...(updatable.length ? [`GRANT UPDATE (${updatable.join(', ')}) ON ${name} TO xyra_app`] : []),
      ];
    }),
  ];
  const serverGrants = [
    `GRANT SELECT, INSERT, UPDATE ON ${[...PLATFORM_TABLES].join(', ')} TO xyra_server`,
    ...[...capabilityTables].flatMap(([capability, granted]) => [
      ...[...granted].map((name) => `GRANT SELECT, INSERT, UPDATE ON ${name} TO xyra_cap_${capability}`),
    ]),
  ];
  const grants = [
    ...revokes,
    ...appGrants,
    ...serverGrants,
  ];
  await db.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_app') THEN
      CREATE ROLE xyra_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_server') THEN
      CREATE ROLE xyra_server NOLOGIN;
    END IF;
    ${[...capabilityTables.keys()].map((capability) => `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_cap_${capability}') THEN CREATE ROLE xyra_cap_${capability} NOLOGIN; END IF;`).join('\n    ')}
  END $$;
  GRANT USAGE ON SCHEMA public TO ${managedRoles.join(', ')};
  ${grants.join(';\n  ')}`);
}
