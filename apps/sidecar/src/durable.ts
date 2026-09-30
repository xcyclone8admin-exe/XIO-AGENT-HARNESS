import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type { BusAudit, BusIdempotency } from './bus';

const scopeOf = (key: string): Scope => {
  const [tenantId, workspaceId] = key.split(':');
  if (!tenantId || !workspaceId) throw new Error('Malformed idempotency key');
  return { tenantId, workspaceId };
};

export class DurableBusAudit implements BusAudit {
  constructor(private readonly store: LocalScopedStore) {}
  async append(record: Parameters<BusAudit['append']>[0]): Promise<void> {
    await this.store.query({ tenantId: record.principal.tenantId, workspaceId: record.workspaceId },
      `INSERT INTO audit_events(id,tenant_id,workspace_id,actor_id,action,target_type,target_id,detail)
       VALUES ($1,$2,$3,$4,$5,'capability',$6,$7::jsonb)`,
      [uuidv7(), record.principal.tenantId, record.workspaceId, record.principal.id,
        record.capabilityId, record.capabilityId,
        JSON.stringify({ result: record.result, ...(record.detail ? { detail: record.detail } : {}) })]);
  }
}

export class DurableBusIdempotency implements BusIdempotency {
  constructor(private readonly store: LocalScopedStore) {}
  async get(key: string): ReturnType<BusIdempotency['get']> {
    const result = await this.store.query<{ input_hash: string; result: unknown } & Record<string, unknown>>(
      scopeOf(key), 'SELECT input_hash,result FROM capability_idempotency WHERE key=$1', [key]);
    const row = result.rows[0];
    return row ? { inputHash: row.input_hash, result: row.result } : undefined;
  }
  async put(key: string, inputHash: string, result: unknown): Promise<void> {
    const scope = scopeOf(key);
    await this.store.query(scope,
      `INSERT INTO capability_idempotency(key,tenant_id,workspace_id,input_hash,result)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [key, scope.tenantId, scope.workspaceId, inputHash, JSON.stringify(result)]);
  }
}
