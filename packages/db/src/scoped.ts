import type { PGlite } from '@electric-sql/pglite';

export interface Scope { readonly tenantId: string; readonly workspaceId: string }
export interface RowResult<T> { readonly rows: T[]; readonly rowCount: number }

/** SQL here is code-owned and parameterized; no user or agent supplied SQL enters this API. */
export class LocalScopedStore {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(scope: Scope, sql: string, params: unknown[] = []): Promise<RowResult<T>> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new Error('Invalid query scope');
    }
    if (sql.includes(';') || /\/\*|--/.test(sql)) throw new Error('Scoped query must be one code-owned statement');
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

/** The trusted sidecar calls this after migrations; PGlite's login remains a superuser. */
export async function prepareLocalAppRole(db: PGlite): Promise<void> {
  await db.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xyra_app') THEN
      CREATE ROLE xyra_app NOLOGIN;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO xyra_app;
  GRANT SELECT, INSERT, UPDATE ON tenants, workspaces, users, memberships,
    approval_requests, approval_decisions, audit_events, domain_events,
    sync_outbox, sync_conflicts, sync_cursors,
    workspace_settings, ops_projects, ops_tasks, capability_idempotency TO xyra_app`);
}
