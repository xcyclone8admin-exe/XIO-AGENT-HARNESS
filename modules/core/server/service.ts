import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@xyra/contracts';
import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: 'standard' | 'sample';
  sync_enabled: boolean;
}
interface MembershipRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  role: 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'auditor';
  kind: 'standard' | 'sample';
}

/** Trusted first-run path. The sidecar supplies osSubject from native identity, never HTTP input. */
export async function bootstrapLocalIdentity(
  db: PGlite,
  osSubject: string,
  displayName: string,
): Promise<Principal> {
  if (!osSubject.trim() || !displayName.trim()) throw new Error('Local identity required');
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE os_subject=$1 ORDER BY created_at LIMIT 1', [osSubject],
    );
    let user = existing.rows[0];
    if (!user) {
      const tenantId = uuidv7();
      const userId = uuidv7();
      const workspaceId = uuidv7();
      const sampleId = uuidv7();
      await tx.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantId, `${displayName} local`]);
      await tx.query('INSERT INTO users(id,tenant_id,display_name,os_subject) VALUES ($1,$2,$3,$4)',
        [userId, tenantId, displayName, osSubject]);
      await tx.query(`INSERT INTO workspaces(id,tenant_id,name,kind,sync_enabled)
        VALUES ($1,$2,$3,'standard',false),($4,$2,$5,'sample',false)`,
        [workspaceId, tenantId, 'My workspace', sampleId, 'Sample workspace']);
      await tx.query(`INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role)
        VALUES ($1,$2,$3,$4,'owner'),($5,$2,$6,$4,'owner')`,
        [uuidv7(), tenantId, workspaceId, userId, uuidv7(), sampleId]);
      await tx.query(`INSERT INTO workspace_settings(tenant_id,workspace_id) VALUES ($1,$2),($1,$3)`,
        [tenantId, workspaceId, sampleId]);
      const sampleProjectId = uuidv7();
      await tx.query(`INSERT INTO ops_projects(id,tenant_id,workspace_id,name,description,created_by)
        VALUES ($1,$2,$3,$4,$5,$6)`, [sampleProjectId, tenantId, sampleId,
        'Launch checklist', 'Sample project; no external actions are enabled.', userId]);
      await tx.query(`INSERT INTO ops_tasks(id,tenant_id,workspace_id,project_id,title,created_by)
        VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), tenantId, sampleId, sampleProjectId,
        'Review the first milestone', userId]);
      user = { id: userId, tenant_id: tenantId };
    }
    const memberships = await tx.query<MembershipRow>(`
      SELECT m.id,m.workspace_id,m.role,w.kind FROM memberships m
      JOIN workspaces w ON w.tenant_id=m.tenant_id AND w.id=m.workspace_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active=true ORDER BY w.created_at`,
    [user.tenant_id, user.id]);
    return {
      kind: 'user' as const,
      id: user.id,
      tenantId: user.tenant_id,
      workspaces: memberships.rows.map((m) => ({ id: m.workspace_id, role: m.role, kind: m.kind })),
      grants: [],
      displayName,
    };
  });
}

export class CoreService {
  constructor(private readonly store: LocalScopedStore) {}

  async workspace(scope: Scope): Promise<WorkspaceRow | null> {
    const result = await this.store.query<WorkspaceRow>(scope,
      'SELECT id,name,kind,sync_enabled FROM workspaces WHERE id=$1', [scope.workspaceId]);
    return result.rows[0] ?? null;
  }

  async members(scope: Scope): Promise<Array<{ id: string; displayName: string; role: string }>> {
    const result = await this.store.query<{ id: string; display_name: string; role: string } & Record<string, unknown>>(
      scope, `SELECT u.id,u.display_name,m.role FROM memberships m
        JOIN users u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
        WHERE m.workspace_id=$1 AND m.active=true ORDER BY u.display_name`, [scope.workspaceId]);
    return result.rows.map((r) => ({ id: r.id, displayName: r.display_name, role: r.role }));
  }

  async approvals(scope: Scope): Promise<Array<Record<string, unknown>>> {
    const result = await this.store.query<Record<string, unknown>>(scope,
      `SELECT id,capability_id,reason,requested_by,expires_at,created_at
       FROM approval_requests WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`, [scope.workspaceId]);
    return result.rows;
  }

  async audit(scope: Scope): Promise<Array<Record<string, unknown>>> {
    const result = await this.store.query<Record<string, unknown>>(scope,
      `SELECT id,actor_id,action,target_type,target_id,detail,occurred_at
       FROM audit_events WHERE workspace_id=$1 ORDER BY occurred_at DESC LIMIT 100`, [scope.workspaceId]);
    return result.rows;
  }

  async theme(scope: Scope): Promise<string> {
    const result = await this.store.query<{ theme: string } & Record<string, unknown>>(scope,
      'SELECT theme FROM workspace_settings WHERE workspace_id=$1', [scope.workspaceId]);
    return result.rows[0]?.theme ?? 'system';
  }

  async setTheme(scope: Scope, theme: 'system' | 'light' | 'dark'): Promise<string> {
    const result = await this.store.query<{ theme: string } & Record<string, unknown>>(scope,
      `INSERT INTO workspace_settings(tenant_id,workspace_id,theme) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id) DO UPDATE SET theme=EXCLUDED.theme,updated_at=now()
       RETURNING theme`, [scope.tenantId, scope.workspaceId, theme]);
    return result.rows[0]?.theme ?? theme;
  }
}
