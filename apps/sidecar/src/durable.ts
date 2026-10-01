import { uuidv7 } from '@xyra/core';
import { hashApprovalInput, hashApprovalScope, VerifiedCapabilityApproval } from '@xyra/contracts';
import type { Principal, VerifiedCapabilityApproval as VerifiedApproval } from '@xyra/contracts';
import type { LocalScopedStore, Scope } from '@xyra/db';
import type { BusApproval, BusAudit, BusIdempotency, VerifiedBusApproval } from './bus';

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

interface ApprovalRow extends Record<string, unknown> {
  approval_id: string;
  decision_id: string;
  tenant_id: string;
  workspace_id: string;
  capability_id: string;
  input_hash: string;
  requested_by: string;
  approver_id: string;
  issued_at: string;
  expires_at: string;
}

interface ApprovalUseMarker {
  approvalId: string;
  decisionId: string;
  capabilityId: string;
  inputDigest: string;
  idempotencyKey: string;
}

function parseApprovalUseMarker(value: unknown): ApprovalUseMarker | undefined {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const marker = candidate as Partial<ApprovalUseMarker>;
  if (
    typeof marker.approvalId !== 'string' || typeof marker.decisionId !== 'string' ||
    typeof marker.capabilityId !== 'string' || typeof marker.inputDigest !== 'string' ||
    typeof marker.idempotencyKey !== 'string'
  ) return undefined;
  return marker as ApprovalUseMarker;
}

/** Reads current scoped approval state and atomically reserves each approval for one call key. */
export class DurableBusApproval implements BusApproval {
  constructor(private readonly store: LocalScopedStore) {}

  async verify(
    principal: Principal,
    workspaceId: string,
    capabilityId: string,
    input: unknown,
    approvalId: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<VerifiedBusApproval | null> {
    const requesterId = principal.kind === 'user'
      ? principal.id
      : principal.kind === 'agent'
        ? principal.delegatedBy
        : undefined;
    if (!approvalId || !requesterId || !idempotencyKey) return null;

    const scope: Scope = { tenantId: principal.tenantId, workspaceId };
    const inputDigest = await hashApprovalInput(input);
    const result = await this.store.query<ApprovalRow>(scope, `
      SELECT r.id AS approval_id,d.id AS decision_id,r.tenant_id,r.workspace_id,
        r.capability_id,r.input_hash,r.requested_by,d.decided_by AS approver_id,
        d.created_at AS issued_at,r.expires_at
      FROM approval_requests r
      JOIN approval_decisions d
        ON (d.tenant_id,d.workspace_id,d.request_id)=(r.tenant_id,r.workspace_id,r.id)
      JOIN memberships m
        ON (m.tenant_id,m.workspace_id,m.user_id)=(d.tenant_id,d.workspace_id,d.decided_by)
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.workspace_id=$3
        AND r.capability_id=$4 AND r.input_hash=$5 AND r.requested_by=$6
        AND r.expires_at>now() AND d.decision='approved' AND d.valid=true
        AND d.decided_by<>r.requested_by AND m.active=true AND m.role IN ('owner','admin')
      LIMIT 1`, [approvalId, principal.tenantId, workspaceId, capabilityId, inputDigest, requesterId]);
    const row = result.rows[0];
    if (!row) return null;

    const markerKey = `approval-use:${approvalId}`;
    const marker: ApprovalUseMarker = { approvalId, decisionId: row.decision_id, capabilityId, inputDigest, idempotencyKey };
    const inserted = await this.store.query<{ key: string } & Record<string, unknown>>(scope,
      `INSERT INTO capability_idempotency(key,tenant_id,workspace_id,input_hash,result)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [markerKey, principal.tenantId, workspaceId, inputDigest, JSON.stringify(marker)]);
    if (!inserted.rows.length) {
      const previous = await this.store.query<{ input_hash: string; result: unknown } & Record<string, unknown>>(
        scope, 'SELECT input_hash,result FROM capability_idempotency WHERE key=$1', [markerKey]);
      const used = previous.rows[0];
      const saved = parseApprovalUseMarker(used?.result);
      if (
        !used || used.input_hash !== inputDigest || saved?.decisionId !== row.decision_id ||
        saved?.capabilityId !== capabilityId || saved?.idempotencyKey !== idempotencyKey
      ) return null;
    }

    const expiresAt = new Date(row.expires_at).toISOString();
    const issuedAt = new Date(row.issued_at).toISOString();
    const proof: Omit<VerifiedApproval, 'scopeHash'> = {
      version: 1,
      approvalId: row.approval_id,
      decisionId: row.decision_id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      principalId: principal.id,
      requestedBy: row.requested_by,
      approverId: row.approver_id,
      capabilityId: row.capability_id,
      inputDigest: row.input_hash,
      issuedAt,
      expiresAt,
    };
    return VerifiedCapabilityApproval.parse({
      ...proof,
      scopeHash: await hashApprovalScope(proof),
    });
  }
}
