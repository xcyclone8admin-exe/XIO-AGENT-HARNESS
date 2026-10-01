import { withNeonTransaction } from './neon';
import type { NeonQueryClient } from './neon';

type Scope = { tenantId?: string; workspaceId?: string };
type TransactionRunner = <T>(
  connectionString: string,
  scope: Scope,
  operation: (client: NeonQueryClient) => Promise<T>,
) => Promise<T>;

interface PendingWorkspace extends Record<string, unknown> {
  tenant_id: string;
  workspace_id: string;
  server_seq: string | number;
}

/**
 * Replay committed cache invalidations. The Hub applies a monotonic max sequence, so overlapping
 * Cron runs and crash/retry duplicates are safe. A failed delivery remains pending and records an
 * attempt; the canonical Neon rows/log/conflicts are never rolled back or discarded.
 */
export async function drainSyncOutbox(
  connectionString: string,
  deliver: (workspaceId: string, serverSeq: string) => Promise<boolean>,
  maxWorkspaces = 100,
  transact: TransactionRunner = (url, scope, operation) =>
    withNeonTransaction(url, scope, (client) => operation(client)),
): Promise<{ delivered: number; failed: number; pruned: number }> {
  const pending = await transact(connectionString, {}, async (client) => {
    const result = await client.query<PendingWorkspace>(
      `SELECT tenant_id,workspace_id,max(server_seq)::text AS server_seq
         FROM cloud_sync_outbox WHERE delivered_at IS NULL
        GROUP BY tenant_id,workspace_id ORDER BY min(server_seq) LIMIT $1`,
      [maxWorkspaces],
    );
    return result.rows;
  });
  let delivered = 0;
  let failed = 0;
  for (const row of pending) {
    const sequence = String(row.server_seq);
    let ok = false;
    try {
      ok = await deliver(row.workspace_id, sequence);
    } catch {
      ok = false;
    }
    await transact(
      connectionString,
      { tenantId: row.tenant_id, workspaceId: row.workspace_id },
      async (client) => {
        if (ok) {
          await client.query(
            `UPDATE cloud_sync_outbox SET delivered_at=COALESCE(delivered_at,now()),attempts=attempts+1
              WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq <= $3 AND delivered_at IS NULL`,
            [row.tenant_id, row.workspace_id, sequence],
          );
        } else {
          await client.query(
            `UPDATE cloud_sync_outbox SET attempts=attempts+1
              WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq <= $3 AND delivered_at IS NULL`,
            [row.tenant_id, row.workspace_id, sequence],
          );
        }
      },
    );
    if (ok) delivered += 1;
    else failed += 1;
  }

  // Delivered cache invalidations are operational metadata, not canonical history. Retain them
  // for 30 days for diagnosis, then delete in bounded tenant/workspace-scoped batches. Conflict
  // history and canonical pull changes are never part of this cleanup.
  const expiredScopes = await transact(connectionString, {}, async (client) => {
    const result = await client.query<PendingWorkspace>(
      `SELECT tenant_id,workspace_id,max(server_seq)::text AS server_seq
         FROM cloud_sync_outbox
        WHERE delivered_at < now() - interval '30 days'
        GROUP BY tenant_id,workspace_id ORDER BY min(delivered_at) LIMIT $1`,
      [maxWorkspaces],
    );
    return result.rows;
  });
  let pruned = 0;
  for (const scope of expiredScopes) {
    const removed = await transact(
      connectionString,
      { tenantId: scope.tenant_id, workspaceId: scope.workspace_id },
      async (client) => {
        const result = await client.query(
          `DELETE FROM cloud_sync_outbox
            WHERE tenant_id=$1 AND workspace_id=$2 AND ctid IN (
              SELECT ctid FROM cloud_sync_outbox
               WHERE tenant_id=$1 AND workspace_id=$2
                 AND delivered_at < now() - interval '30 days'
               ORDER BY delivered_at LIMIT 500
            )
          RETURNING 1`,
          [scope.tenant_id, scope.workspace_id],
        );
        return result.rows.length;
      },
    );
    pruned += removed;
  }
  return { delivered, failed, pruned };
}
