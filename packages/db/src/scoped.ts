import type { PGlite } from '@electric-sql/pglite';

export interface Scope {
  readonly tenantId: string;
  readonly workspaceId: string;
}
export interface RowResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
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
}

/** Structural subset of a manifest TableDecl (packages/db does not depend on contracts). */
export interface GrantedTable {
  readonly name: string;
  readonly class: 'lww' | 'append' | 'local';
  /** Columns the app role may never write; UPDATE is then granted per column on the rest. */
  readonly privilegedColumns?: readonly string[];
}

/** Platform bookkeeping relations that no module manifest declares. */
const PLATFORM_TABLES = ['sync_outbox', 'sync_conflicts', 'sync_cursors', 'capability_idempotency'];
/** Platform-migrated tables whose owning module is not yet integrated on every branch. */
const PLATFORM_APPEND_TABLES = [
  'swarm_runs',
  'swarm_run_journal',
  'swarm_model_evals',
  'swarm_prompt_versions',
];
const PLATFORM_MUTABLE_TABLES = ['swarm_agent_profiles'];

/**
 * The trusted sidecar calls this after migrations; PGlite's login remains a superuser.
 * Grants derive from manifest table declarations: append tables get SELECT/INSERT only,
 * everything else SELECT/INSERT/UPDATE. No table gets DELETE. A table with privileged columns
 * gets a column-list UPDATE grant on its other columns (a table-wide UPDATE would override any
 * column REVOKE); the owning module's trigger rejects inserts that set them.
 */
export async function prepareLocalAppRole(db: PGlite, tables: readonly GrantedTable[] = []): Promise<void> {
  const append = new Set(PLATFORM_APPEND_TABLES);
  const mutable = new Set([...PLATFORM_TABLES, ...PLATFORM_MUTABLE_TABLES]);
  const privileged = new Map<string, readonly string[]>();
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table.name)) throw new Error(`Invalid table name ${table.name}`);
    if (table.class === 'append') {
      append.add(table.name);
      mutable.delete(table.name);
    } else if (table.privilegedColumns?.length) {
      privileged.set(table.name, table.privilegedColumns);
      mutable.delete(table.name);
    } else if (!append.has(table.name)) {
      mutable.add(table.name);
    }
  }
  const columnGrants: string[] = [];
  for (const [name, columns] of privileged) {
    const described = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [name],
    );
    if (!described.rows.length) throw new Error(`Table ${name} does not exist`);
    const updatable = described.rows.map((row) => row.column_name).filter((c) => !columns.includes(c));
    columnGrants.push(`GRANT SELECT, INSERT ON ${name} TO xyra_app`);
    if (updatable.length) columnGrants.push(`GRANT UPDATE (${updatable.join(', ')}) ON ${name} TO xyra_app`);
  }
  await db.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_app') THEN
      CREATE ROLE xyra_app NOLOGIN;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO xyra_app;
  GRANT SELECT, INSERT, UPDATE ON ${[...mutable].join(', ')} TO xyra_app;
  GRANT SELECT, INSERT ON ${[...append].join(', ')} TO xyra_app${columnGrants.map((grant) => `;\n  ${grant}`).join('')}`);
}
