import { createNeonAppPool } from '@xyra/db/neon';
import type { CandidateClaims, CurrentMembership } from './model';
import { MANIFESTS } from './tables';
import type { Env } from './index';

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}
export type NeonQueryClient = Pick<SqlClient, 'query'>;

type SqlPool = ReturnType<typeof createNeonAppPool>;
const pools = new Map<string, SqlPool>();

function appPool(connectionString: string): SqlPool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = createNeonAppPool(connectionString);
    pools.set(connectionString, pool);
  }
  return pool;
}

export async function withNeonTransaction<T>(
  connectionString: string,
  scope: {
    tenantId?: string;
    workspaceId?: string;
    authTransactionId?: string;
    authCredentialId?: string;
    refreshTokenHash?: string;
  },
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = (await appPool(connectionString).connect()) as unknown as SqlClient;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId ?? '']);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId ?? '']);
    await client.query("SELECT set_config('app.auth_transaction_id', $1, true)", [
      scope.authTransactionId ?? '',
    ]);
    await client.query("SELECT set_config('app.auth_credential_id', $1, true)", [
      scope.authCredentialId ?? '',
    ]);
    await client.query("SELECT set_config('app.refresh_token_hash', $1, true)", [
      scope.refreshTokenHash ?? '',
    ]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const ROLES = ['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'] as const;
type Role = (typeof ROLES)[number];

function rolePermissions(role: Role): string[] {
  const output = new Set<string>();
  for (const manifest of MANIFESTS) {
    const permissions =
      role === 'owner' || role === 'admin' ? manifest.permissions : manifest.roleGrants[role];
    for (const permission of permissions ?? []) output.add(permission);
  }
  return [...output];
}

interface MembershipRow extends Record<string, unknown> {
  role: Role;
  workspace_kind: 'standard' | 'sample';
}

export interface CurrentAuthority {
  readonly membership: CurrentMembership;
  readonly delegator?: CurrentMembership;
}

/** Resolve every request against current database state; no JWT or DO cache grants access. */
export async function resolveCurrentAuthority(
  connectionString: string,
  claims: CandidateClaims,
): Promise<CurrentAuthority | null> {
  if (!claims.workspaceIds.includes(claims.activeWorkspaceId)) return null;
  return withNeonTransaction(
    connectionString,
    { tenantId: claims.tenantId, workspaceId: claims.activeWorkspaceId },
    (client) => readCurrentAuthority(client, claims),
  );
}

export async function recordDpopReplay(
  connectionString: string,
  claims: CandidateClaims,
  proof: { jtiHashHex: string; expiresAtMs: number },
): Promise<boolean> {
  return withNeonTransaction(
    connectionString,
    { tenantId: claims.tenantId, workspaceId: claims.activeWorkspaceId },
    async (client) => {
      const result = await client.query(
        `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
         VALUES ($1,$2,decode($3,'hex'),to_timestamp($4))
         ON CONFLICT DO NOTHING RETURNING 1`,
        [claims.tenantId, claims.deviceId, proof.jtiHashHex, proof.expiresAtMs / 1000],
      );
      return result.rows.length === 1;
    },
  );
}

export async function readCurrentAuthority(
  client: NeonQueryClient,
  claims: CandidateClaims,
): Promise<CurrentAuthority | null> {
  if (!claims.workspaceIds.includes(claims.activeWorkspaceId)) return null;
  if (claims.kind === 'user') {
    const result = await client.query<MembershipRow>(
      `SELECT m.role,w.kind AS workspace_kind
         FROM memberships m JOIN workspaces w
           ON w.tenant_id=m.tenant_id AND w.id=m.workspace_id
        WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND m.user_id=$3
          AND m.active=true AND w.sync_enabled=true AND w.kind='standard'`,
      [claims.tenantId, claims.activeWorkspaceId, claims.principalId],
    );
    const row = result.rows[0];
    if (!row || !ROLES.includes(row.role)) return null;
    return {
      membership: {
        principalId: claims.principalId,
        tenantId: claims.tenantId,
        workspaceId: claims.activeWorkspaceId,
        role: row.role,
        permissions: [],
        kind: 'user',
        workspaceKind: row.workspace_kind,
      },
    };
  }

  if (!claims.delegatedBy || !claims.runId) return null;
  const [delegatorRows, agentRows] = await Promise.all([
    client.query<MembershipRow>(
      `SELECT m.role,w.kind AS workspace_kind FROM memberships m JOIN workspaces w
         ON w.tenant_id=m.tenant_id AND w.id=m.workspace_id
        WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND m.user_id=$3
          AND m.active=true AND w.sync_enabled=true AND w.kind='standard'`,
      [claims.tenantId, claims.activeWorkspaceId, claims.delegatedBy],
    ),
    client.query<{
      capability_grants: unknown;
      autonomy_level: number;
    }>(
      `SELECT p.capability_grants,p.autonomy_level
         FROM swarm_agent_profiles p
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3`,
      [claims.tenantId, claims.activeWorkspaceId, claims.principalId],
    ),
  ]);
  const delegatorRow = delegatorRows.rows[0];
  const agentRow = agentRows.rows[0];
  if (!delegatorRow || !ROLES.includes(delegatorRow.role) || !agentRow) return null;
  if (!Array.isArray(agentRow.capability_grants)) return null;
  const grants = agentRow.capability_grants.filter((value): value is string => typeof value === 'string');
  if (grants.length !== agentRow.capability_grants.length) return null;
  const autonomy = agentRow.autonomy_level;
  if (!Number.isInteger(autonomy) || autonomy < 0 || autonomy > 4) return null;
  return {
    membership: {
      principalId: claims.principalId,
      tenantId: claims.tenantId,
      workspaceId: claims.activeWorkspaceId,
      role: 'member',
      permissions: grants,
      kind: 'agent',
      delegatedBy: claims.delegatedBy,
      autonomy: autonomy as 0 | 1 | 2 | 3 | 4,
      workspaceKind: 'standard',
    },
    delegator: {
      principalId: claims.delegatedBy,
      tenantId: claims.tenantId,
      workspaceId: claims.activeWorkspaceId,
      role: delegatorRow.role,
      permissions: rolePermissions(delegatorRow.role),
      kind: 'user',
      workspaceKind: delegatorRow.workspace_kind,
    },
  };
}

export function databaseUrl(env: Env): string | null {
  return env.NEON_DATABASE_URL?.trim() || null;
}
