import { canonicalJson, sha256Hex, uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope, ScopedTransaction } from '@xyra/db';
import { ErasureRequestInput, ErasureRetryInput, ErasureStatusInput } from '../contracts';
import {
  AbortCloudPurge, AckCloudLocalPurge, BRAIN_ERASURE_PROTOCOL, BeginCloudErasure,
  parseCloudErasureOperation,
} from './erasure-cloud';
import type { CloudErasureClient } from './erasure-cloud';
import type { CloudErasureOperation, CloudErasureStatus } from './erasure-cloud';
import { brainSourceVersionV2, erasureEvidenceDigest } from './erasure-fingerprint';

type ErasureRow = Record<string, unknown> & {
  id: string; source_id: string; status: string; attempts: number; retention_policy: string;
  external_blob_refs: string[]; last_error_code: string | null; completion_receipt: string | null;
  attempt_id: string | null; source_version: string | null; cloud_operation_id: string | null;
  cloud_request_digest: string | null; reservation_id: string | null; reservation_expires_at: string | null;
  claim_id: string | null; claim_generation: number | null; local_purge_receipt_id: string | null;
  local_purge_receipt_digest: string | null; no_purge_abort_receipt_id: string | null;
  no_purge_abort_receipt_digest: string | null; cloud_audit_receipt_id: string | null;
};
type ReceiptRow = Record<string, unknown> & {
  id: string; receipt_kind: 'local_purge' | 'no_purge_abort'; attempt_id: string;
  operation_id: string; source_version: string; claim_id: string | null; claim_generation: number | null;
  record_counts: Record<string, unknown>; evidence_digest: string;
};
type BeginContext = { id: string; sourceId: string; attemptId: string; approvalId: string; sourceVersion: string | null; operationId: string | null; requestDigest: string | null; isNew?: boolean };

const CAPABILITY = 'brain_erasure';
const EMPTY_COUNTS = { brain_sources: 0, brain_source_versions: 0, brain_chunks: 0, brain_signals: 0, brain_claims: 0, brain_promotions: 0, brain_facts: 0, brain_contradictions: 0, brain_memories: 0, object_edges: 0, index_rows: 0 };
const FINAL_CLOUD_STATES = new Set<CloudErasureStatus>(['completed', 'retained_shared', 'retained_hold', 'unavailable', 'terminal_failure', 'aborted']);

/** Coordinates one scoped BRAIN source erasure. All destructive local work is fenced by Cloud's durable claim. */
export class BrainErasureService {
  constructor(private readonly store: LocalScopedStore, private readonly cloud?: CloudErasureClient) {}

  async request(scope: Scope, actorId: string, verifiedApprovalId: string | undefined, input: unknown) {
    if (!verifiedApprovalId) throw new Error('ERASURE_APPROVAL_REQUIRED');
    const request = ErasureRequestInput.parse(input);
    const inputHash = await sha256Hex(canonicalJson(request));
    const context = await this.ensureIntent(scope, actorId, verifiedApprovalId, inputHash, request.sourceId);
    const row = await this.requireRow(scope, context.id);
    if (!context.isNew) return this.status(scope, { erasureId: context.id });
    if (row.external_blob_refs.length) return this.failClosed(scope, actorId, context.id, 'SOURCE_REFERENCES_UNAVAILABLE', 'unavailable');
    if (!context.sourceVersion) return this.keepWaitingCloud(scope, actorId, context.id, 'CLOUD_INGESTION_REQUIRED');
    if (!this.cloud) return this.keepWaitingCloud(scope, actorId, context.id);
    return this.drive(scope, actorId, context);
  }

  async retry(scope: Scope, actorId: string, verifiedApprovalId: string | undefined, input: unknown) {
    if (!verifiedApprovalId) throw new Error('ERASURE_APPROVAL_REQUIRED');
    const { erasureId } = ErasureRetryInput.parse(input);
    const context = await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      if (row.local_purge_receipt_id) {
        return this.contextFrom(row);
      }
      if (row.no_purge_abort_receipt_id) throw new Error('ERASURE_ABORT_MUST_REPLAY_BEFORE_RETRY');
      if (Number(row.attempts) >= 2) throw new Error('ERASURE_RETRY_LIMIT');
      if (!['waiting_cloud','unavailable','retryable_failure','eligibility_expired','eligibility_invalidated','terminal_failure','aborted','cloud_request_pending'].includes(row.status)) {
        throw new Error('ERASURE_RETRY_STATE_INVALID');
      }
      const attemptId = uuidv7();
      const next = Number(row.attempts) + 1;
      const current = await tx.query<Record<string, unknown> & { source_version: string | null }>(`SELECT r.source_version FROM brain_source_blob_reference_sets r
        JOIN brain_sources s ON (s.tenant_id,s.workspace_id,s.id)=(r.tenant_id,r.workspace_id,r.source_id)
        JOIN brain_source_versions v ON (v.tenant_id,v.workspace_id,v.id,v.source_id)=(r.tenant_id,r.workspace_id,r.source_version_id,r.source_id)
        WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.source_id=$3 AND r.status IN ('verified_empty','verified_nonempty')
          AND r.content_digest=v.content_hash AND s.external_blob_refs='[]'::jsonb AND s.cloud_object_ref_ids=r.object_ref_ids
          AND v.id=(SELECT id FROM brain_source_versions WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 ORDER BY version DESC,id LIMIT 1)
        ORDER BY v.version DESC,v.id LIMIT 1 FOR UPDATE OF r`, [scope.tenantId, scope.workspaceId, row.source_id]);
      const sourceVersion = current.rows[0]?.source_version ?? null;
      const nextStatus = sourceVersion ? 'cloud_request_pending' : 'waiting_cloud';
      await this.insertAttempt(tx, scope, actorId, row.id, attemptId, nextStatus, `retry:${verifiedApprovalId}`, row.retention_policy);
      await this.insertEvent(tx, scope, row.id, attemptId, row.cloud_operation_id, 'retry_approved', nextStatus, null, { approvalRequestId: verifiedApprovalId, attemptNo: next });
      await tx.query(`UPDATE brain_source_erasures SET status=$1,attempt_id=$2,source_version=$3,attempts=$4,last_error_code=NULL,
        updated_at=now() WHERE tenant_id=$5 AND workspace_id=$6 AND id=$7`, [nextStatus, attemptId, sourceVersion, next, scope.tenantId, scope.workspaceId, erasureId]);
      return this.contextFrom({ ...row, status: nextStatus, source_version: sourceVersion }, attemptId, verifiedApprovalId);
    });
    const row = await this.requireRow(scope, context.id);
    if (row.external_blob_refs.length) return this.failClosed(scope, actorId, context.id, 'SOURCE_REFERENCES_UNAVAILABLE', 'unavailable');
    if (!context.sourceVersion) return this.keepWaitingCloud(scope, actorId, context.id, 'CLOUD_INGESTION_REQUIRED');
    if (!this.cloud) return this.keepWaitingCloud(scope, actorId, context.id);
    if (await this.hasReceipt(scope, context.id)) return this.sendReceipt(scope, actorId, context.id, context.attemptId);
    return this.drive(scope, actorId, context);
  }

  async status(scope: Scope, input: unknown) {
    const { erasureId, limit, cursor } = ErasureStatusInput.parse(input);
    const result = await this.store.query<ErasureRow>(scope, `SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt,
      attempt_id,source_version,cloud_operation_id,cloud_request_digest,reservation_id,reservation_expires_at,claim_id,claim_generation,
      local_purge_receipt_id,local_purge_receipt_digest,no_purge_abort_receipt_id,no_purge_abort_receipt_digest,cloud_audit_receipt_id
      FROM brain_source_erasures WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [scope.tenantId, scope.workspaceId, erasureId]);
    const row = result.rows[0];
    if (!row) throw new Error('ERASURE_NOT_FOUND');
    const attempts = await this.store.query<Record<string, unknown> & { id: string; occurred_at: string }>(scope, `SELECT id,outcome,checked_blob_refs,deleted_blob_refs,
      retention_policy,audit_reference,error_code,occurred_at FROM brain_source_erasure_attempts
      WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3
        AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4,$5::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT $6`,
    [scope.tenantId, scope.workspaceId, erasureId, cursor?.occurredAt ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = attempts.rows.length > limit;
    const items = attempts.rows.slice(0, limit);
    const last = items.at(-1);
    return { ...this.view(row), audit: { items, nextCursor: hasMore && last ? { occurredAt: new Date(last.occurred_at).toISOString(), id: last.id } : null } };
  }

  /** Recovery replays a committed receipt, or resumes the same durable Cloud claim. It never aborts a receipt-bearing op. */
  async recover(scope: Scope, actorId: string, erasureId: string) {
    const row = await this.loadErasure(this.readTransaction(scope), scope, erasureId, false);
    if (!row) throw new Error('ERASURE_NOT_FOUND');
    if (row.local_purge_receipt_id) return this.sendReceipt(scope, actorId, erasureId, row.attempt_id ?? '');
    if (row.no_purge_abort_receipt_id) {
      const receipt = await this.getReceipt(scope, erasureId, 'no_purge_abort');
      return this.sendOutboxReceipt(scope, actorId, row, receipt);
    }
    if (!this.cloud || !row.cloud_operation_id) return this.view(row);
    const latest = parseCloudErasureOperation(await this.cloud.get(row.cloud_operation_id));
    this.assertBinding(row, latest);
    if (latest.status !== 'purge_claimed' || !latest.claim) return this.view(row);
    await this.persistClaim(scope, actorId, row.id, latest);
    return this.purgeClaimed(scope, actorId, row.id, latest);
  }

  /** Serializes the no-purge receipt against any purge worker by locking the same operation row. */
  async abortClaim(scope: Scope, actorId: string, erasureId: string, attemptId: string, claimId: string, claimGeneration: number) {
    const abort = await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      const existingPurge = await this.findReceipt(tx, scope, erasureId, 'local_purge');
      if (existingPurge) throw new Error('PURGED_ERASURE_MUST_REPLAY_ACK');
      const existingAbort = await this.findReceipt(tx, scope, erasureId, 'no_purge_abort');
      if (existingAbort) return { row, receipt: existingAbort };
      if (row.status !== 'purge_claimed' || row.attempt_id !== attemptId || row.claim_id !== claimId || Number(row.claim_generation) !== claimGeneration || !row.source_version || !row.cloud_operation_id) {
        throw new Error('ERASURE_CLAIM_GENERATION_STALE');
      }
      const receiptId = uuidv7();
      const body = { protocolVersion: BRAIN_ERASURE_PROTOCOL, receiptKind: 'no_purge_abort', erasureId, operationId: row.cloud_operation_id,
        attemptId, sourceId: row.source_id, sourceVersion: row.source_version, claimId, claimGeneration, recordCounts: EMPTY_COUNTS };
      const digest = await erasureEvidenceDigest(body);
      await tx.query(`INSERT INTO brain_source_erasure_receipts(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,source_id,receipt_kind,
        source_version,claim_id,claim_generation,record_counts,evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,'no_purge_abort',$8,$9,$10,$11::jsonb,$12)`,
      [receiptId, scope.tenantId, scope.workspaceId, erasureId, attemptId, row.cloud_operation_id, row.source_id, row.source_version, claimId, claimGeneration, JSON.stringify(body), digest]);
      await this.insertAttempt(tx, scope, actorId, erasureId, attemptId, 'abort_pending', receiptId, row.retention_policy);
      await this.insertEvent(tx, scope, erasureId, attemptId, row.cloud_operation_id, 'no_purge_abort_committed', 'abort_pending', null, { receiptId, digest, claimId, claimGeneration });
      await tx.query(`UPDATE brain_source_erasures SET status='abort_pending',no_purge_abort_receipt_id=$1,no_purge_abort_receipt_digest=$2,
        last_error_code='LOCAL_PURGE_ABORTED',updated_at=now() WHERE tenant_id=$3 AND workspace_id=$4 AND id=$5`,
      [receiptId, digest, scope.tenantId, scope.workspaceId, erasureId]);
      await tx.query(`INSERT INTO brain_source_erasure_outbox(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,receipt_id,event_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'abort') ON CONFLICT (tenant_id,workspace_id,erasure_id,attempt_id,event_type) DO NOTHING`,
      [uuidv7(), scope.tenantId, scope.workspaceId, erasureId, attemptId, row.cloud_operation_id, receiptId]);
      return { row, receipt: { id: receiptId, receipt_kind: 'no_purge_abort' as const, attempt_id: attemptId, operation_id: row.cloud_operation_id,
        source_version: row.source_version, claim_id: claimId, claim_generation: claimGeneration, record_counts: body, evidence_digest: digest } };
    });
    if (!this.cloud) return this.view(abort.row);
    return this.sendOutboxReceipt(scope, actorId, abort.row, abort.receipt);
  }

  private async ensureIntent(scope: Scope, actorId: string, approvalId: string, inputHash: string, sourceId: string): Promise<BeginContext> {
    return this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const prior = await tx.query<ErasureRow>(`SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt,
        attempt_id,source_version,cloud_operation_id,cloud_request_digest,reservation_id,reservation_expires_at,claim_id,claim_generation,
        local_purge_receipt_id,local_purge_receipt_digest,no_purge_abort_receipt_id,no_purge_abort_receipt_digest,cloud_audit_receipt_id FROM brain_source_erasures
        WHERE tenant_id=$1 AND workspace_id=$2 AND approval_request_id=$3 AND approval_input_hash=$4 FOR UPDATE`,
      [scope.tenantId, scope.workspaceId, approvalId, inputHash]);
      if (prior.rows[0]) {
        if (prior.rows[0].source_id !== sourceId) throw new Error('ERASURE_IDEMPOTENCY_SCOPE_MISMATCH');
        return { ...this.contextFrom(prior.rows[0]), isNew: false };
      }
      const source = await tx.query<Record<string, unknown> & { id: string; retention: string; external_blob_refs: string[] }>(`SELECT id,retention,external_blob_refs FROM brain_sources
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, sourceId]);
      if (!source.rows[0]) throw new Error('SOURCE_NOT_FOUND');
      const snapshot = await tx.query<Record<string, unknown> & { source_version: string | null; status: string; source_version_id: string; content_digest: string }>(`SELECT r.source_version,r.status,r.source_version_id,r.content_digest
        FROM brain_source_blob_reference_sets r JOIN brain_source_versions v
          ON (v.tenant_id,v.workspace_id,v.id,v.source_id)=(r.tenant_id,r.workspace_id,r.source_version_id,r.source_id)
        WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.source_id=$3 AND r.status IN ('verified_empty','verified_nonempty')
          AND v.content_hash=r.content_digest ORDER BY v.version DESC,v.id LIMIT 1 FOR UPDATE OF r`, [scope.tenantId, scope.workspaceId, sourceId]);
      const sourceVersion = snapshot.rows[0]?.source_version ?? null;
      const id = uuidv7();
      const attemptId = uuidv7();
      const status = sourceVersion ? 'cloud_request_pending' : 'waiting_cloud';
      await tx.query(`INSERT INTO brain_source_erasures(id,tenant_id,workspace_id,source_id,status,requested_by,approval_request_id,approval_input_hash,
        retention_policy,external_blob_refs,last_error_code,protocol_version,attempt_id,source_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NULL,$11,$12,$13)`,
      [id, scope.tenantId, scope.workspaceId, sourceId, status, actorId, approvalId, inputHash, source.rows[0].retention,
        JSON.stringify(source.rows[0].external_blob_refs ?? []), BRAIN_ERASURE_PROTOCOL, attemptId, sourceVersion]);
      await this.insertAttempt(tx, scope, actorId, id, attemptId, status, `approval:${approvalId}`, source.rows[0].retention);
      await this.insertEvent(tx, scope, id, attemptId, null, 'intent_created', status, null, { sourceVersion });
      return { id, sourceId, attemptId, approvalId, sourceVersion, operationId: null, requestDigest: null, isNew: true };
    });
  }

  private async drive(scope: Scope, actorId: string, context: BeginContext) {
    if (!this.cloud) throw new Error('CLOUD_ERASURE_CLIENT_UNAVAILABLE');
    try {
      if (!context.sourceVersion) throw new Error('SOURCE_REFERENCES_UNAVAILABLE');
      const request = BeginCloudErasure.parse({ protocolVersion: BRAIN_ERASURE_PROTOCOL, erasureId: context.id, attemptId: context.attemptId,
        approvalId: context.approvalId, source: { kind: 'brain_source', id: context.sourceId }, sourceVersion: context.sourceVersion });
      const response = parseCloudErasureOperation(await this.cloud.begin(request));
      this.assertBinding(context, response);
      await this.persistOperation(scope, actorId, context.id, response);
      if (response.status === 'eligible' && response.eligibility) {
        const latest = parseCloudErasureOperation(await this.cloud.get(response.operationId));
        this.assertBinding(context, latest);
        if (latest.status !== 'eligible' || !latest.eligibility || Date.parse(latest.eligibility.expiresAt) <= Date.now()) {
          await this.persistOperation(scope, actorId, context.id, latest);
          return this.status(scope, { erasureId: context.id });
        }
        const claimed = parseCloudErasureOperation(await this.cloud.claimLocalPurge(response.operationId, {
          protocolVersion: BRAIN_ERASURE_PROTOCOL, attemptId: context.attemptId, reservationId: latest.eligibility.reservationId,
        }));
        this.assertBinding(context, claimed);
        if (claimed.status !== 'purge_claimed' || !claimed.claim) throw new Error('CLOUD_PURGE_CLAIM_NOT_CONFIRMED');
        await this.persistClaim(scope, actorId, context.id, claimed);
        const purged = await this.purgeClaimed(scope, actorId, context.id, claimed);
        if (purged.localPurgeReceiptId) return this.sendReceipt(scope, actorId, context.id, context.attemptId);
        return purged;
      }
      if (response.status === 'purge_claimed' && response.claim) {
        await this.persistClaim(scope, actorId, context.id, response);
        await this.purgeClaimed(scope, actorId, context.id, response);
        return this.sendReceipt(scope, actorId, context.id, context.attemptId);
      }
      return this.status(scope, { erasureId: context.id });
    } catch (error) {
      return this.failClosed(scope, actorId, context.id, errorCode(error), 'retryable_failure');
    }
  }

  private async persistOperation(scope: Scope, actorId: string, erasureId: string, operation: CloudErasureOperation) {
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      this.assertBinding(row, operation);
      const status = this.localStatus(operation.status);
      await this.insertAttempt(tx, scope, actorId, erasureId, operation.attemptId, status, operation.auditReceiptId ?? operation.operationId, row.retention_policy);
      await this.insertEvent(tx, scope, erasureId, operation.attemptId, operation.operationId, 'cloud_phase1', operation.status,
        operation.requestDigest, { objects: operation.objects, eligibility: operation.eligibility, auditReceiptId: operation.auditReceiptId });
      await tx.query(`UPDATE brain_source_erasures SET status=$1,attempt_id=$2,cloud_operation_id=$3,cloud_attempt_no=$4,
        cloud_request_digest=$5,reservation_id=$6,reference_state_version=$7,hold_state_version=$8,reservation_expires_at=$9,
        claim_id=NULL,claim_generation=NULL,cloud_audit_receipt_id=$10,last_error_code=$11,updated_at=now()
        WHERE tenant_id=$12 AND workspace_id=$13 AND id=$14`,
      [status, operation.attemptId, operation.operationId, operation.attemptNo, operation.requestDigest,
        operation.eligibility?.reservationId ?? null, operation.eligibility?.referenceStateVersion ?? null,
        operation.eligibility?.holdStateVersion ?? null, operation.eligibility?.expiresAt ?? null,
        operation.auditReceiptId, status === 'unavailable' ? 'CLOUD_ERASURE_UNAVAILABLE' : null,
        scope.tenantId, scope.workspaceId, erasureId]);
    });
  }

  private async persistClaim(scope: Scope, actorId: string, erasureId: string, operation: CloudErasureOperation) {
    const claim = operation.claim;
    if (operation.status !== 'purge_claimed' || !claim) throw new Error('CLOUD_PURGE_CLAIM_NOT_CONFIRMED');
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      this.assertBinding(row, operation);
      if (row.local_purge_receipt_id) return;
      if (row.status === 'purge_claimed') {
        if (row.claim_id !== claim.claimId || Number(row.claim_generation) !== claim.claimGeneration) throw new Error('ERASURE_CLAIM_GENERATION_STALE');
        return;
      }
      if (!['eligible','cloud_request_pending','retryable_failure'].includes(row.status)) throw new Error('ERASURE_CLAIM_STATE_INVALID');
      await this.insertAttempt(tx, scope, actorId, erasureId, operation.attemptId, 'purge_claimed', claim.claimId, row.retention_policy);
      await this.insertEvent(tx, scope, erasureId, operation.attemptId, operation.operationId, 'cloud_purge_claimed', operation.status,
        operation.requestDigest, { claim: operation.claim, eligibility: operation.eligibility });
      await tx.query(`UPDATE brain_source_erasures SET status='purge_claimed',claim_id=$1,claim_generation=$2,
        reservation_id=$3,reference_state_version=$4,hold_state_version=$5,reservation_expires_at=$6,updated_at=now()
        WHERE tenant_id=$7 AND workspace_id=$8 AND id=$9`,
      [claim.claimId, claim.claimGeneration, operation.eligibility?.reservationId ?? row.reservation_id,
        operation.eligibility?.referenceStateVersion ?? row.reference_state_version, operation.eligibility?.holdStateVersion ?? row.hold_state_version,
        operation.eligibility?.expiresAt ?? row.reservation_expires_at, scope.tenantId, scope.workspaceId, erasureId]);
    });
  }

  private async purgeClaimed(scope: Scope, actorId: string, erasureId: string, operation: CloudErasureOperation) {
    const receipt = await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      const prior = await this.findReceipt(tx, scope, erasureId, 'local_purge');
      if (prior) return prior;
      if (await this.findReceipt(tx, scope, erasureId, 'no_purge_abort')) throw new Error('ERASURE_ABORT_ALREADY_COMMITTED');
      if (!operation.claim || row.status !== 'purge_claimed' || row.attempt_id !== operation.attemptId ||
        row.cloud_operation_id !== operation.operationId || row.source_version !== operation.sourceVersion ||
        row.claim_id !== operation.claim.claimId || Number(row.claim_generation) !== operation.claim.claimGeneration) {
        throw new Error('ERASURE_CLAIM_GENERATION_STALE');
      }
      const source = await tx.query<Record<string, unknown> & { id: string; cloud_object_ref_ids: string[] | null; external_blob_refs: string[] }>(`SELECT id,cloud_object_ref_ids,external_blob_refs FROM brain_sources
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [scope.tenantId, scope.workspaceId, row.source_id]);
      const latest = await tx.query<Record<string, unknown> & { id: string; content_hash: string }>(`SELECT id,content_hash FROM brain_source_versions
        WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 ORDER BY version DESC,id LIMIT 1`, [scope.tenantId, scope.workspaceId, row.source_id]);
      const snapshot = await tx.query<Record<string, unknown> & { source_version_id: string; content_digest: string; object_ref_ids: string[] | null; source_version: string | null; reference_state_version: number }>(`SELECT source_version_id,content_digest,object_ref_ids,source_version,reference_state_version
        FROM brain_source_blob_reference_sets WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3
          AND status IN ('verified_empty','verified_nonempty') ORDER BY finalized_at DESC,id DESC LIMIT 1 FOR UPDATE`, [scope.tenantId, scope.workspaceId, row.source_id]);
      const refs = snapshot.rows[0]?.object_ref_ids;
      const currentVersion = source.rows[0] && latest.rows[0] && snapshot.rows[0] && refs &&
        source.rows[0].external_blob_refs.length === 0 && latest.rows[0].id === snapshot.rows[0].source_version_id &&
        latest.rows[0].content_hash === snapshot.rows[0].content_digest &&
        canonicalJson(source.rows[0].cloud_object_ref_ids) === canonicalJson(refs)
        ? await brainSourceVersionV2({ sourceId: row.source_id, sourceVersionId: snapshot.rows[0].source_version_id,
          tenantId: scope.tenantId, workspaceId: scope.workspaceId, contentDigest: snapshot.rows[0].content_digest,
          objectRefIds: refs, referenceStateVersion: Number(snapshot.rows[0].reference_state_version) }) : null;
      if (!currentVersion || currentVersion !== row.source_version || currentVersion !== snapshot.rows[0]?.source_version) {
        return this.commitNoPurgeAbort(tx, scope, actorId, row, 'SOURCE_VERSION_CHANGED');
      }
      const countsResult = await tx.query<Record<string, unknown> & { brain_purge_source: Record<string, unknown> }>(
        'SELECT brain_purge_source($1,$2,$3,$4,$5,$6) AS brain_purge_source',
        [row.id, row.source_id, operation.attemptId, row.source_version, operation.claim.claimId, operation.claim.claimGeneration]);
      const counts = countsResult.rows[0]?.brain_purge_source;
      if (!counts || typeof counts !== 'object') throw new Error('BRAIN_PURGE_EVIDENCE_MISSING');
      const receiptId = uuidv7();
      const body = { protocolVersion: BRAIN_ERASURE_PROTOCOL, receiptKind: 'local_purge', erasureId: row.id, operationId: operation.operationId,
        attemptId: operation.attemptId, sourceId: row.source_id, sourceVersion: row.source_version, claimId: operation.claim.claimId,
        claimGeneration: operation.claim.claimGeneration, recordCounts: counts };
      const digest = await erasureEvidenceDigest(body);
      await tx.query(`INSERT INTO brain_source_erasure_receipts(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,source_id,receipt_kind,
        source_version,claim_id,claim_generation,record_counts,evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,'local_purge',$8,$9,$10,$11::jsonb,$12)`,
      [receiptId, scope.tenantId, scope.workspaceId, row.id, operation.attemptId, operation.operationId, row.source_id, row.source_version,
        operation.claim.claimId, operation.claim.claimGeneration, JSON.stringify(body), digest]);
      await this.insertAttempt(tx, scope, actorId, row.id, operation.attemptId, 'local_purged_ack_pending', receiptId, row.retention_policy);
      await this.insertEvent(tx, scope, row.id, operation.attemptId, operation.operationId, 'local_purge_committed', 'local_purged_ack_pending',
        row.cloud_request_digest, { receiptId, digest, counts });
      await tx.query(`UPDATE brain_source_erasures SET status='local_purged_ack_pending',local_purge_receipt_id=$1,
        local_purge_receipt_digest=$2,last_error_code=NULL,updated_at=now() WHERE tenant_id=$3 AND workspace_id=$4 AND id=$5`,
      [receiptId, digest, scope.tenantId, scope.workspaceId, row.id]);
      await tx.query(`INSERT INTO brain_source_erasure_outbox(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,receipt_id,event_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'local_ack') ON CONFLICT (tenant_id,workspace_id,erasure_id,attempt_id,event_type) DO NOTHING`,
      [uuidv7(), scope.tenantId, scope.workspaceId, row.id, operation.attemptId, operation.operationId, receiptId]);
      return { id: receiptId, receipt_kind: 'local_purge' as const, attempt_id: operation.attemptId, operation_id: operation.operationId,
        source_version: row.source_version, claim_id: operation.claim.claimId, claim_generation: operation.claim.claimGeneration,
        record_counts: body, evidence_digest: digest };
    });
    if (receipt.receipt_kind === 'no_purge_abort') return this.sendOutboxReceipt(scope, actorId, await this.requireRow(scope, erasureId), receipt);
    return this.status(scope, { erasureId });
  }

  private async commitNoPurgeAbort(tx: ScopedTransaction, scope: Scope, actorId: string, row: ErasureRow, reason: string) {
    const receiptId = uuidv7();
    const body = { protocolVersion: BRAIN_ERASURE_PROTOCOL, receiptKind: 'no_purge_abort', erasureId: row.id,
      operationId: row.cloud_operation_id, attemptId: row.attempt_id, sourceId: row.source_id, sourceVersion: row.source_version,
      claimId: row.claim_id, claimGeneration: row.claim_generation, reason, recordCounts: EMPTY_COUNTS };
    const digest = await erasureEvidenceDigest(body);
    await tx.query(`INSERT INTO brain_source_erasure_receipts(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,source_id,receipt_kind,
      source_version,claim_id,claim_generation,record_counts,evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,'no_purge_abort',$8,$9,$10,$11::jsonb,$12)`,
    [receiptId, scope.tenantId, scope.workspaceId, row.id, row.attempt_id, row.cloud_operation_id, row.source_id, row.source_version,
      row.claim_id, row.claim_generation, JSON.stringify(body), digest]);
    await this.insertAttempt(tx, scope, actorId, row.id, row.attempt_id!, 'abort_pending', receiptId, row.retention_policy);
    await this.insertEvent(tx, scope, row.id, row.attempt_id!, row.cloud_operation_id, 'no_purge_abort_committed', 'abort_pending',
      row.cloud_request_digest, { receiptId, digest, reason, claimId: row.claim_id, claimGeneration: row.claim_generation });
    await tx.query(`UPDATE brain_source_erasures SET status='abort_pending',no_purge_abort_receipt_id=$1,no_purge_abort_receipt_digest=$2,
      last_error_code=$3,updated_at=now() WHERE tenant_id=$4 AND workspace_id=$5 AND id=$6`,
    [receiptId, digest, reason, scope.tenantId, scope.workspaceId, row.id]);
    await tx.query(`INSERT INTO brain_source_erasure_outbox(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,receipt_id,event_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'abort') ON CONFLICT (tenant_id,workspace_id,erasure_id,attempt_id,event_type) DO NOTHING`,
    [uuidv7(), scope.tenantId, scope.workspaceId, row.id, row.attempt_id, row.cloud_operation_id, receiptId]);
    return { id: receiptId, receipt_kind: 'no_purge_abort' as const, attempt_id: row.attempt_id!, operation_id: row.cloud_operation_id!,
      source_version: row.source_version!, claim_id: row.claim_id, claim_generation: row.claim_generation, record_counts: body, evidence_digest: digest };
  }

  private async sendReceipt(scope: Scope, actorId: string, erasureId: string, attemptId: string) {
    const row = await this.requireRow(scope, erasureId);
    const receipt = await this.store.query<ReceiptRow>(scope, `SELECT id,receipt_kind,attempt_id,operation_id,source_version,claim_id,claim_generation,record_counts,evidence_digest
      FROM brain_source_erasure_receipts WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND receipt_kind='local_purge'`,
    [scope.tenantId, scope.workspaceId, erasureId]);
    if (!receipt.rows[0]) throw new Error('LOCAL_PURGE_RECEIPT_NOT_FOUND');
    if (!this.cloud || !row.cloud_operation_id) return this.view(row);
    const outbox = await this.ensureAckOutbox(scope, row, receipt.rows[0], attemptId || receipt.rows[0].attempt_id);
    return this.sendOutboxReceipt(scope, actorId, row, outbox);
  }

  private async sendOutboxReceipt(scope: Scope, actorId: string, row: ErasureRow, receipt: ReceiptRow) {
    if (!this.cloud || !receipt.operation_id || !receipt.source_version) return this.view(row);
    const outboxType = receipt.receipt_kind === 'no_purge_abort' ? 'abort' : 'local_ack';
    try {
      let raw: unknown;
      if (outboxType === 'abort') {
        if (!receipt.claim_id || !receipt.claim_generation) throw new Error('ABORT_CLAIM_EVIDENCE_MISSING');
        raw = await this.cloud.abortLocalPurge(receipt.operation_id, AbortCloudPurge.parse({ protocolVersion: BRAIN_ERASURE_PROTOCOL,
          attemptId: receipt.attempt_id, abortReceiptId: receipt.id, abortReceiptDigest: receipt.evidence_digest,
          sourceVersion: receipt.source_version, claimId: receipt.claim_id, claimGeneration: receipt.claim_generation }));
      } else {
        raw = await this.cloud.acknowledgeLocalPurge(receipt.operation_id, AckCloudLocalPurge.parse({ protocolVersion: BRAIN_ERASURE_PROTOCOL,
          attemptId: receipt.attempt_id, localPurgeReceiptId: receipt.id, localPurgeReceiptDigest: receipt.evidence_digest, sourceVersion: receipt.source_version }));
      }
      const operation = parseCloudErasureOperation(raw);
      this.assertBinding(row, operation, receipt.attempt_id);
      if (operation.status === 'completed' && receipt.receipt_kind !== 'local_purge') throw new Error('ABORT_CANNOT_COMPLETE_ERASURE');
      if (operation.status === 'completed' && !operation.auditReceiptId) throw new Error('CLOUD_COMPLETION_RECEIPT_MISSING');
      await this.persistAck(scope, actorId, row.id, receipt, operation, outboxType);
      return this.status(scope, { erasureId: row.id });
    } catch (error) {
      await this.recordOutboxFailure(scope, actorId, row, receipt, errorCode(error));
      return this.status(scope, { erasureId: row.id });
    }
  }

  private async persistAck(scope: Scope, actorId: string, erasureId: string, receipt: ReceiptRow, operation: CloudErasureOperation, outboxType: string) {
    const status = operation.status === 'completed' ? 'complete' : operation.status === 'retained_shared' ? 'retained_shared'
      : operation.status === 'retained_hold' || operation.status === 'hold_unknown' ? 'retained_hold'
      : operation.status === 'aborted' ? 'aborted' : operation.status === 'terminal_failure' ? 'terminal_failure'
      : operation.status === 'unavailable' ? 'unavailable' : 'local_purged_ack_pending';
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row) throw new Error('ERASURE_NOT_FOUND');
      const expectedReceiptId = receipt.receipt_kind === 'local_purge' ? row.local_purge_receipt_id : row.no_purge_abort_receipt_id;
      const expectedDigest = receipt.receipt_kind === 'local_purge' ? row.local_purge_receipt_digest : row.no_purge_abort_receipt_digest;
      if (expectedReceiptId !== receipt.id || expectedDigest !== receipt.evidence_digest) throw new Error('ERASURE_RECEIPT_MISMATCH');
      this.assertBinding(row, operation, receipt.attempt_id);
      if (status === 'complete' && (!receipt.receipt_kind || !operation.auditReceiptId)) throw new Error('CLOUD_COMPLETION_NOT_VERIFIABLE');
      await this.insertAttempt(tx, scope, actorId, erasureId, receipt.attempt_id, status, operation.auditReceiptId ?? receipt.id, row.retention_policy);
      await this.insertEvent(tx, scope, erasureId, receipt.attempt_id, operation.operationId, `cloud_${outboxType}_response`, operation.status,
        operation.requestDigest, { auditReceiptId: operation.auditReceiptId, objects: operation.objects });
      if (FINAL_CLOUD_STATES.has(operation.status)) {
        await tx.query(`UPDATE brain_source_erasure_outbox SET delivered_at=now(),last_error_code=NULL,updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND attempt_id=$4 AND event_type=$5`,
        [scope.tenantId, scope.workspaceId, erasureId, receipt.attempt_id, outboxType]);
      }
      await tx.query(`UPDATE brain_source_erasures SET status=$1,cloud_audit_receipt_id=$2,
        completion_receipt=$3,completed_at=CASE WHEN $1='complete' THEN now() ELSE completed_at END,
        last_error_code=$4,updated_at=now() WHERE tenant_id=$5 AND workspace_id=$6 AND id=$7`,
      [status, operation.auditReceiptId, status === 'complete' ? operation.auditReceiptId : null,
        status === 'local_purged_ack_pending' ? 'CLOUD_ACK_PENDING' : null, scope.tenantId, scope.workspaceId, erasureId]);
    });
  }

  private async ensureAckOutbox(scope: Scope, row: ErasureRow, receipt: ReceiptRow, attemptId: string) {
    return this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      if (attemptId !== receipt.attempt_id) throw new Error('ACK_ATTEMPT_MISMATCH');
      await tx.query(`INSERT INTO brain_source_erasure_outbox(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,receipt_id,event_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'local_ack') ON CONFLICT (tenant_id,workspace_id,erasure_id,attempt_id,event_type) DO NOTHING`,
      [uuidv7(), scope.tenantId, scope.workspaceId, row.id, receipt.attempt_id, receipt.operation_id, receipt.id]);
      const result = await tx.query<ReceiptRow>(`SELECT id,receipt_kind,attempt_id,operation_id,source_version,claim_id,claim_generation,record_counts,evidence_digest
        FROM brain_source_erasure_receipts WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND receipt_kind='local_purge'`,
      [scope.tenantId, scope.workspaceId, row.id]);
      return result.rows[0]!;
    });
  }

  private async recordOutboxFailure(scope: Scope, actorId: string, row: ErasureRow, receipt: ReceiptRow, code: string) {
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const type = receipt.receipt_kind === 'no_purge_abort' ? 'abort' : 'local_ack';
      const q = await tx.query<Record<string, unknown> & { attempt_count: number }>(`SELECT attempt_count FROM brain_source_erasure_outbox
        WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND attempt_id=$4 AND event_type=$5 FOR UPDATE`,
      [scope.tenantId, scope.workspaceId, row.id, receipt.attempt_id, type]);
      const count = Number(q.rows[0]?.attempt_count ?? 0);
      const nextCount = Math.min(2, count + 1);
      const status = nextCount >= 2 ? 'retryable_failure' : 'local_purged_ack_pending';
      await this.insertAttempt(tx, scope, actorId, row.id, receipt.attempt_id, status, receipt.id, row.retention_policy, code);
      await this.insertEvent(tx, scope, row.id, receipt.attempt_id, receipt.operation_id, 'outbox_retry_failed', status, null, { code, retryCount: nextCount });
      await tx.query(`UPDATE brain_source_erasure_outbox SET attempt_count=$1,last_error_code=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now()
        WHERE tenant_id=$3 AND workspace_id=$4 AND erasure_id=$5 AND attempt_id=$6 AND event_type=$7`,
      [nextCount, code, scope.tenantId, scope.workspaceId, row.id, receipt.attempt_id, type]);
      await tx.query(`UPDATE brain_source_erasures SET status=$1,last_error_code=$2,updated_at=now() WHERE tenant_id=$3 AND workspace_id=$4 AND id=$5`,
      [status, code, scope.tenantId, scope.workspaceId, row.id]);
    });
  }

  private async failClosed(scope: Scope, actorId: string, erasureId: string, code: string, status: 'unavailable' | 'retryable_failure') {
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row || row.local_purge_receipt_id || row.no_purge_abort_receipt_id) return;
      const attemptId = row.attempt_id ?? uuidv7();
      await this.insertAttempt(tx, scope, actorId, erasureId, attemptId, status, `blocked:${code}`, row.retention_policy, code);
      await this.insertEvent(tx, scope, erasureId, attemptId, row.cloud_operation_id, 'cloud_unavailable', status, row.cloud_request_digest, { code });
      await tx.query(`UPDATE brain_source_erasures SET status=$1,last_error_code=$2,updated_at=now() WHERE tenant_id=$3 AND workspace_id=$4 AND id=$5`,
      [status, code, scope.tenantId, scope.workspaceId, erasureId]);
    });
    return this.status(scope, { erasureId });
  }

  private async keepWaitingCloud(scope: Scope, actorId: string, erasureId: string, code = 'CLOUD_ERASURE_CLIENT_UNAVAILABLE') {
    await this.store.withServerScope(scope, CAPABILITY, undefined, async (tx) => {
      const row = await this.loadErasure(tx, scope, erasureId, true);
      if (!row || row.local_purge_receipt_id) return;
      const attemptId = row.attempt_id ?? uuidv7();
      await this.insertAttempt(tx, scope, actorId, erasureId, attemptId, 'waiting_cloud', code, row.retention_policy, code);
      await tx.query(`UPDATE brain_source_erasures SET status='waiting_cloud',last_error_code=$1,updated_at=now()
        WHERE tenant_id=$2 AND workspace_id=$3 AND id=$4`, [code, scope.tenantId, scope.workspaceId, erasureId]);
    });
    return this.status(scope, { erasureId });
  }

  private async loadErasure(tx: Pick<ScopedTransaction, 'query'>, scope: Scope, erasureId: string, lock: boolean) {
    const result = await tx.query<ErasureRow>(`SELECT id,source_id,status,attempts,retention_policy,external_blob_refs,last_error_code,completion_receipt,
      attempt_id,source_version,cloud_operation_id,cloud_request_digest,reservation_id,reservation_expires_at,claim_id,claim_generation,
      local_purge_receipt_id,local_purge_receipt_digest,no_purge_abort_receipt_id,no_purge_abort_receipt_digest,cloud_audit_receipt_id FROM brain_source_erasures
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`, [scope.tenantId, scope.workspaceId, erasureId]);
    return result.rows[0];
  }

  private async findReceipt(tx: Pick<ScopedTransaction, 'query'>, scope: Scope, erasureId: string, kind: ReceiptRow['receipt_kind']) {
    const result = await tx.query<ReceiptRow>(`SELECT id,receipt_kind,attempt_id,operation_id,source_version,claim_id,claim_generation,record_counts,evidence_digest
      FROM brain_source_erasure_receipts WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND receipt_kind=$4`,
    [scope.tenantId, scope.workspaceId, erasureId, kind]);
    return result.rows[0];
  }

  private async getReceipt(scope: Scope, erasureId: string, kind: ReceiptRow['receipt_kind']) {
    const receipt = await this.store.query<ReceiptRow>(scope, `SELECT id,receipt_kind,attempt_id,operation_id,source_version,claim_id,claim_generation,record_counts,evidence_digest
      FROM brain_source_erasure_receipts WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND receipt_kind=$4`,
    [scope.tenantId, scope.workspaceId, erasureId, kind]);
    if (!receipt.rows[0]) throw new Error('ERASURE_RECEIPT_NOT_FOUND');
    return receipt.rows[0];
  }

  private async insertAttempt(tx: Pick<ScopedTransaction, 'query'>, scope: Scope, actorId: string, erasureId: string, attemptId: string,
    outcome: string, auditRef: string, retention: string, errorCode: string | null = null) {
    await tx.query(`INSERT INTO brain_source_erasure_attempts(id,tenant_id,workspace_id,erasure_id,actor_id,outcome,checked_blob_refs,deleted_blob_refs,
      retention_policy,audit_reference,error_code) VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,'[]'::jsonb,$7,$8,$9)`,
    [uuidv7(), scope.tenantId, scope.workspaceId, erasureId, actorId, outcome, retention, auditRef, errorCode]);
  }

  private async insertEvent(tx: Pick<ScopedTransaction, 'query'>, scope: Scope, erasureId: string, attemptId: string, operationId: string | null,
    eventType: string, cloudStatus: string | null, requestDigest: string | null, details: unknown) {
    const clean = sanitizeDetails(details);
    await tx.query(`INSERT INTO brain_source_erasure_events(id,tenant_id,workspace_id,erasure_id,attempt_id,operation_id,event_type,cloud_status,
      request_digest,reservation_id,reference_state_version,hold_state_version,claim_id,claim_generation,audit_receipt_id,response_digest,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
    [uuidv7(), scope.tenantId, scope.workspaceId, erasureId, attemptId, operationId, eventType, cloudStatus, requestDigest,
      clean.reservationId ?? null, clean.referenceStateVersion ?? null, clean.holdStateVersion ?? null, clean.claimId ?? null,
      clean.claimGeneration ?? null, clean.auditReceiptId ?? null, clean.responseDigest ?? null, JSON.stringify(clean.details)]);
  }

  private assertBinding(expected: BeginContext | ErasureRow, operation: CloudErasureOperation, attemptId?: string) {
    const isRow = 'source_id' in expected;
    const erasureId = expected.id;
    const sourceId = isRow ? expected.source_id : expected.sourceId;
    const expectedAttempt = attemptId ?? (isRow ? expected.attempt_id : expected.attemptId);
    const sourceVersion = isRow ? expected.source_version : expected.sourceVersion;
    const operationId = isRow ? expected.cloud_operation_id : expected.operationId;
    const digest = isRow ? expected.cloud_request_digest : expected.requestDigest;
    if (operation.protocolVersion !== BRAIN_ERASURE_PROTOCOL) throw new Error('LEGACY_CLOUD_ERASURE_PROTOCOL');
    if (operation.erasureId !== erasureId || operation.source.kind !== 'brain_source' || operation.source.id !== sourceId ||
      operation.attemptId !== expectedAttempt || operation.sourceVersion !== sourceVersion ||
      (operationId && operation.operationId !== operationId) || (digest && operation.requestDigest !== digest)) {
      throw new Error('CLOUD_ERASURE_BINDING_MISMATCH');
    }
  }

  private localStatus(status: CloudErasureStatus): string {
    if (status === 'local_purge_acknowledged' || status === 'delete_pending') return 'local_purged_ack_pending';
    return status;
  }

  private contextFrom(row: ErasureRow, attemptId = row.attempt_id ?? uuidv7(), approvalId = ''): BeginContext {
    return { id: row.id, sourceId: row.source_id, attemptId, approvalId, sourceVersion: row.source_version,
      operationId: row.cloud_operation_id, requestDigest: row.cloud_request_digest };
  }

  private async hasReceipt(scope: Scope, erasureId: string) {
    return (await this.store.query(scope, `SELECT id FROM brain_source_erasure_receipts
      WHERE tenant_id=$1 AND workspace_id=$2 AND erasure_id=$3 AND receipt_kind='local_purge'`, [scope.tenantId, scope.workspaceId, erasureId])).rows.length > 0;
  }

  private async requireRow(scope: Scope, erasureId: string) {
    const row = await this.loadErasure(this.readTransaction(scope), scope, erasureId, false);
    if (!row) throw new Error('ERASURE_NOT_FOUND');
    return row;
  }

  private readTransaction(scope: Scope): ScopedTransaction {
    // Read-only adapter is used only by loadErasure; all mutations use withServerScope.
    return { query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => this.store.query<T>(scope, sql, params) };
  }

  private view(row: ErasureRow) {
    return { id: row.id, sourceId: row.source_id, status: row.status, attempts: Number(row.attempts), retentionPolicy: row.retention_policy,
      externalBlobRefs: row.external_blob_refs ?? [], lastErrorCode: row.last_error_code, completionReceipt: row.completion_receipt,
      cloudOperationId: row.cloud_operation_id, localPurgeReceiptId: row.local_purge_receipt_id, cloudAuditReceiptId: row.cloud_audit_receipt_id };
  }
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 160);
  if (error instanceof Error) return error.message.slice(0, 160).replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return 'CLOUD_ERASURE_REQUEST_FAILED';
}

function sanitizeDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { details: {} };
  const record = value as Record<string, unknown>;
  const { objects, eligibility, claim, ...rest } = record;
  return {
    reservationId: (eligibility as Record<string, unknown> | undefined)?.reservationId,
    referenceStateVersion: (eligibility as Record<string, unknown> | undefined)?.referenceStateVersion,
    holdStateVersion: (eligibility as Record<string, unknown> | undefined)?.holdStateVersion,
    claimId: (claim as Record<string, unknown> | undefined)?.claimId,
    claimGeneration: (claim as Record<string, unknown> | undefined)?.claimGeneration,
    auditReceiptId: record.auditReceiptId,
    responseDigest: typeof record.digest === 'string' ? record.digest : undefined,
    details: { ...rest, objectDispositions: Array.isArray(objects) ? objects.map((x) => {
      const o = x as Record<string, unknown>; return { opaqueRefId: o.opaqueRefId, disposition: o.disposition };
    }) : undefined },
  };
}
