import { PreparedAgentRun, type AgentRunner, type AgentRunResult, type PreparedAgentRunResult, type PreparedReviewResultSink } from '@xyra/agent-core';
import { hashApprovalInput, hashApprovalScope, VerifiedCapabilityApproval, type Principal, type VerifiedCapabilityApproval as VerifiedApproval } from '@xyra/contracts';
import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope, ScopedTransaction } from '@xyra/db';
import type { KillSwitchReader, KillSwitchSnapshot } from '../contracts';
import { z } from 'zod';

const ENQUEUE_CAPABILITY = 'swarm.runs.enqueue';
const KILL_SWITCH_CAPABILITY = 'swarm.kill-switch.set';
const CANCEL_CAPABILITY = 'swarm.runs.cancel';
const SERVER_WRITER = 'swarm_service';

export interface SwarmTrustedCallContext {
  readonly principal: Principal;
  readonly actorId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly permission: string;
  readonly approval: VerifiedApproval | null;
}

export interface SwarmRunQueueOptions {
  readonly maxPendingPerWorkspace: number;
  readonly maxQueuedPayloadBytes: number;
  readonly maxResultPayloadBytes: number;
  readonly maxRunDurationMs: number;
  readonly now?: () => number;
}

export type QueueState = 'queued' | 'claimed' | 'running' | 'completed' | 'failed' | 'canceled' | 'refused';
export interface QueueAdmissionResult {
  readonly accepted: boolean;
  readonly runId: string | null;
  readonly state: QueueState | null;
  readonly reason: string | null;
}

export interface QueuedAgentRun {
  readonly runId: string;
  readonly profileId: string;
  readonly principalId: string;
  readonly state: QueueState;
  readonly cancellationRequested: boolean;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

export interface PreparedReviewExecution {
  readonly admission: QueueAdmissionResult;
  readonly result: PreparedAgentRunResult | null;
  readonly resultDelivery: { readonly delivered: boolean; readonly evidenceIds: readonly string[] } | null;
}

interface QueueRow extends Record<string, unknown> {
  id: string;
  profile_id: string;
  principal_id: string;
  state: QueueState;
  cancellation_requested: boolean;
  error_code: string | null;
  created_at: Date | string;
}

interface AdmissionRow extends Record<string, unknown> {
  id: string;
  input_digest: string;
  approval_id: string;
  state: QueueState;
}

/**
 * Server-only durable admission and cancellation boundary. It deliberately cannot claim or run
 * work while the approved C1 execution substrate is closed.
 */
export class SwarmRunQueueService {
  private readonly now: () => number;
  private readonly activeRunners = new Map<string, AgentRunner>();

  constructor(private readonly store: LocalScopedStore, private readonly options: SwarmRunQueueOptions) {
    if (!Number.isInteger(options.maxPendingPerWorkspace) || options.maxPendingPerWorkspace < 1) throw new Error('SWARM_QUEUE_PENDING_LIMIT_INVALID');
    if (!Number.isInteger(options.maxQueuedPayloadBytes) || options.maxQueuedPayloadBytes < 1024) throw new Error('SWARM_QUEUE_PAYLOAD_LIMIT_INVALID');
    if (!Number.isInteger(options.maxResultPayloadBytes) || options.maxResultPayloadBytes < 1024) throw new Error('SWARM_QUEUE_RESULT_LIMIT_INVALID');
    if (!Number.isInteger(options.maxRunDurationMs) || options.maxRunDurationMs < 1) throw new Error('SWARM_QUEUE_DURATION_LIMIT_INVALID');
    this.now = options.now ?? Date.now;
  }

  /** `accepted:true` is returned only after queue row and append event commit together. */
  async enqueue(prepared: PreparedAgentRun, idempotencyKey: string): Promise<QueueAdmissionResult> {
    if (!(prepared instanceof PreparedAgentRun)) throw new Error('TRUSTED_PREPARED_RUN_REQUIRED');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) throw new Error('SWARM_QUEUE_IDEMPOTENCY_KEY_INVALID');
    const { input, authority } = prepared;
    const proof = authority.verifiedApproval;
    if (!proof || !authority.approvedInput) throw new Error('SWARM_RUN_APPROVAL_REQUIRED');
    if (authority.reviewBinding && (
      authority.approvedInput.review?.councilId !== authority.reviewBinding.councilId ||
      authority.approvedInput.review.assignmentId !== authority.reviewBinding.assignmentId ||
      authority.approvedInput.review.role !== authority.reviewBinding.role ||
      authority.reviewBinding.reviewerPrincipalId !== authority.principalId
    )) throw new Error('SWARM_REVIEW_BINDING_APPROVAL_MISMATCH');
    await verifyApproval(proof, this.now(), {
      capabilityId: ENQUEUE_CAPABILITY,
      principalId: authority.principalId,
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
      input: authority.approvedInput,
    });
    if (input.workspaceId !== authority.workspaceId || input.principal.id !== authority.principalId || input.principal.tenantId !== authority.tenantId) {
      throw new Error('SWARM_PREPARED_AUTHORITY_MISMATCH');
    }

    const runPayload = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      principal: input.principal,
      profile: input.profile,
      prompt: input.prompt,
      spawn: input.spawn,
      route: input.route,
      ...(input.leaseScope === undefined ? {} : { leaseScope: input.leaseScope }),
      approvedInput: authority.approvedInput,
      verifiedApproval: proof,
      ...(authority.reviewBinding === undefined ? {} : { reviewBinding: authority.reviewBinding }),
    };
    const payload = JSON.stringify(runPayload);
    if (new TextEncoder().encode(payload).byteLength > this.options.maxQueuedPayloadBytes) throw new Error('SWARM_QUEUE_PAYLOAD_TOO_LARGE');
    const inputDigest = await hashApprovalInput(runPayload);
    const scope = { tenantId: authority.tenantId, workspaceId: authority.workspaceId };
    const stamp = new Date(this.now()).toISOString();

    return this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      await lockOrCreateKillSwitch(tx, scope, authority.principalId, stamp);
      const prior = await tx.query<AdmissionRow>(
        'SELECT id,input_digest,approval_id,state FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3',
        [scope.tenantId, scope.workspaceId, idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing) {
        if (existing.input_digest !== inputDigest || existing.approval_id !== proof.approvalId) throw new Error('SWARM_QUEUE_IDEMPOTENCY_KEY_REUSED');
        return admissionFor(existing.id, existing.state);
      }

      const kill = await tx.query<{ engaged: boolean } & Record<string, unknown>>(
        'SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE',
        [scope.tenantId, scope.workspaceId],
      );
      if (kill.rows[0]?.engaged) return { accepted: false, runId: null, state: null, reason: 'kill_switch_engaged' };

      const count = await tx.query<{ count: number } & Record<string, unknown>>(
        "SELECT count(*)::int AS count FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('queued','claimed','running')",
        [scope.tenantId, scope.workspaceId],
      );
      if ((count.rows[0]?.count ?? 0) >= this.options.maxPendingPerWorkspace) {
        return { accepted: false, runId: null, state: null, reason: 'workspace_queue_limit' };
      }

      await tx.query(
        `INSERT INTO swarm_run_queue(id,tenant_id,workspace_id,profile_id,principal_id,approval_id,idempotency_key,input_digest,payload,state,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'queued',$5,$10,$10)`,
        [input.runId, scope.tenantId, scope.workspaceId, input.profile.id, authority.principalId, proof.approvalId, idempotencyKey, inputDigest, payload, stamp],
      );
      await appendQueueEvent(tx, {
        id: uuidv7(), scope, runId: input.runId, type: 'queued', fromState: null, toState: 'queued', actorId: authority.principalId,
        approvalId: proof.approvalId, occurredAt: stamp, detail: { inputDigest },
      });
      return { accepted: true, runId: input.runId, state: 'queued', reason: null };
    });
  }

  /** Reads server-owned state through the scoped app's RLS SELECT grant. */
  async list(scope: Scope, limit = 100): Promise<QueuedAgentRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('SWARM_QUEUE_LIST_LIMIT_INVALID');
    const { rows } = await this.store.query<QueueRow>(scope,
      'SELECT id,profile_id,principal_id,state,cancellation_requested,error_code,created_at FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',
      [scope.tenantId, scope.workspaceId, limit]);
    return rows.map((row) => ({ runId: row.id, profileId: row.profile_id, principalId: row.principal_id,
      state: row.state, cancellationRequested: row.cancellation_requested, errorCode: row.error_code,
      createdAt: new Date(row.created_at).toISOString() }));
  }

  /** Capability-bus handler boundary for an authenticated cancel request. */
  async cancel(context: SwarmTrustedCallContext, runId: string): Promise<{ accepted: boolean }> {
    assertTrustedContext(context, CANCEL_CAPABILITY);
    const scope = { tenantId: context.tenantId, workspaceId: context.workspaceId };
    const stamp = new Date(this.now()).toISOString();
    const result = await this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      const found = await tx.query<{ id: string; state: QueueState; cancellation_requested: boolean } & Record<string, unknown>>(
        'SELECT id,state,cancellation_requested FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',
        [scope.tenantId, scope.workspaceId, runId],
      );
      const row = found.rows[0];
      if (!row || ['completed', 'failed', 'canceled', 'refused'].includes(row.state)) return { accepted: false };
      if (row.state === 'queued') {
        await tx.query("UPDATE swarm_run_queue SET state='canceled',error_code='CANCELED_BY_CALLER',ended_at=$4,updated_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [scope.tenantId, scope.workspaceId, runId, stamp]);
        await appendQueueEvent(tx, { id: uuidv7(), scope, runId, type: 'canceled', fromState: 'queued', toState: 'canceled', actorId: context.actorId, approvalId: null, occurredAt: stamp, detail: {} });
      } else if (!row.cancellation_requested) {
        await tx.query('UPDATE swarm_run_queue SET cancellation_requested=true,updated_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, runId, stamp]);
        await appendQueueEvent(tx, { id: uuidv7(), scope, runId, type: 'cancel_requested', fromState: row.state, toState: row.state, actorId: context.actorId, approvalId: null, occurredAt: stamp, detail: {} });
      }
      return { accepted: true };
    });
    if (result.accepted) this.activeRunners.get(runId)?.cancel(runId);
    return result;
  }

  async isCancellationRequested(scope: Scope, runId: string): Promise<boolean> {
    const { rows } = await this.store.query<{ cancellation_requested: boolean } & Record<string, unknown>>(
      scope, 'SELECT cancellation_requested FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
      [scope.tenantId, scope.workspaceId, runId]);
    return rows[0]?.cancellation_requested ?? false;
  }

  /** Fails expired work durably and clears its fencing token so a stale worker cannot complete it. */
  async recoverExpiredClaims(scope: Scope): Promise<number> {
    const stamp = new Date(this.now()).toISOString();
    return this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      const expired = await tx.query<{ id: string; state: QueueState; claim_token: string; principal_id: string; approval_id: string; cancellation_requested: boolean } & Record<string, unknown>>(
        "SELECT id,state,claim_token,principal_id,approval_id,cancellation_requested FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('claimed','running') AND claim_expires_at <= $3 FOR UPDATE",
        [scope.tenantId, scope.workspaceId, stamp]);
      for (const row of expired.rows) {
        if (row.state === 'running') {
          const next = await tx.query<{ seq: number } & Record<string, unknown>>(
            'SELECT COALESCE(MAX(seq),-1)::int+1 AS seq FROM swarm_run_journal WHERE tenant_id=$1 AND workspace_id=$2 AND run_id=$3',
            [scope.tenantId, scope.workspaceId, row.id]);
          await tx.query("INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,detail,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,'run.terminated',$6::jsonb,$7,$8)",
            [uuidv7(), scope.tenantId, scope.workspaceId, row.id, next.rows[0]?.seq ?? 0, JSON.stringify({ termination: row.cancellation_requested ? 'CANCELED' : 'FAILED', reason: 'WORKER_LEASE_EXPIRED' }), stamp, row.principal_id]);
          await tx.query(
            "INSERT INTO swarm_run_outcomes(id,tenant_id,workspace_id,run_id,termination,output,iterations,actions,failures,cost_usd,ended_at,created_by) VALUES($1,$2,$3,$4,$5,NULL,0,0,0,0,$6,$7)",
            [uuidv7(), scope.tenantId, scope.workspaceId, row.id, row.cancellation_requested ? 'CANCELED' : 'FAILED', stamp, row.principal_id]);
        }
        const terminal: QueueState = row.cancellation_requested ? 'canceled' : 'failed';
        const errorCode = row.cancellation_requested ? 'CANCELED_AFTER_WORKER_LEASE_EXPIRED' : 'WORKER_LEASE_EXPIRED';
        await tx.query('UPDATE swarm_run_queue SET state=$5,error_code=$6,ended_at=$7,updated_at=$7,claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND claim_token=$4',
          [scope.tenantId, scope.workspaceId, row.id, row.claim_token, terminal, errorCode, stamp]);
        await appendQueueEvent(tx, { id: uuidv7(), scope, runId: row.id, type: terminal, fromState: row.state, toState: terminal,
          actorId: row.principal_id, approvalId: row.approval_id, occurredAt: stamp, detail: { reason: errorCode } });
      }
      return expired.rows.length;
    });
  }

  /** Worker claim stays closed until the approved execution substrate and C1 gate are wired. */
  async claimNext(_scope: Scope, _workerId: string): Promise<{ claimed: false; reason: 'execution_disabled_until_c1' }> {
    return { claimed: false, reason: 'execution_disabled_until_c1' };
  }

  /**
   * Model-only FORGE review path. It cannot call tools or mutate project state: the prepared
   * profile must grant no capabilities, and AgentRunner's Tier-0 catalog is read-only by design.
   */
  async executePreparedReview(
    prepared: PreparedAgentRun,
    idempotencyKey: string,
    runner: AgentRunner,
    workerId: string,
    sink?: PreparedReviewResultSink,
  ): Promise<PreparedReviewExecution> {
    if (!(prepared instanceof PreparedAgentRun) || !prepared.authority.reviewBinding) throw new Error('SWARM_PREPARED_REVIEW_REQUIRED');
    if (prepared.input.profile.capabilityGrants.length || prepared.input.spawn.capabilityGrants.length ||
      prepared.input.profile.secretScopes.length || prepared.input.profile.filesystemPolicy.mode !== 'none') {
      throw new Error('SWARM_REVIEW_MUST_BE_MODEL_ONLY');
    }
    if (prepared.input.profile.budgets.maxDurationMs > this.options.maxRunDurationMs) throw new Error('SWARM_REVIEW_DURATION_LIMIT_EXCEEDED');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(workerId)) throw new Error('SWARM_REVIEW_WORKER_ID_INVALID');
    const admission = await this.enqueue(prepared, idempotencyKey);
    if (!admission.accepted || !admission.runId) return { admission, result: null, resultDelivery: null };
    const claim = await this.claimPreparedReview(prepared, workerId);
    if (!claim) return { admission, result: null, resultDelivery: null };

    this.activeRunners.set(prepared.input.runId, runner);
    let envelope: PreparedAgentRunResult;
    try {
      envelope = await runner.runPreparedWithAuthority(prepared);
    } catch {
      envelope = await failedReviewEnvelope(prepared, this.now());
    } finally {
      this.activeRunners.delete(prepared.input.runId);
    }
    const persisted = await this.finishPreparedReview(prepared, claim.token, envelope);
    const delivery = sink ? await this.deliverPendingReviewResult(
      { tenantId: prepared.authority.tenantId, workspaceId: prepared.authority.workspaceId }, prepared.input.runId, sink,
    ) : null;
    return { admission: { accepted: persisted.termination === 'COMPLETED', runId: prepared.input.runId, state: persisted.queueState, reason: persisted.queueState === 'completed' ? null : `run_${persisted.queueState}` }, result: persisted.envelope, resultDelivery: delivery };
  }

  /** Retryable, server-only delivery of an already-durable result to Forge. Sink must be idempotent on runId. */
  async deliverPendingReviewResult(scope: Scope, runId: string, sink: PreparedReviewResultSink): Promise<{ delivered: boolean; evidenceIds: readonly string[] }> {
    const token = uuidv7();
    const now = this.now();
    const expiry = new Date(now + 60_000).toISOString();
    const reservation = await this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      const selected = await tx.query<{ state: QueueState; result_delivery_state: string; result_payload: unknown; result_delivery_expires_at: Date | string | null; result_evidence_ids: unknown } & Record<string, unknown>>(
        'SELECT state,result_delivery_state,result_payload,result_delivery_expires_at,result_evidence_ids FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',
        [scope.tenantId, scope.workspaceId, runId]);
      const row = selected.rows[0];
      if (!row || row.state !== 'completed' || !row.result_payload) return undefined;
      const priorEvidence = parseStringArray(row.result_evidence_ids);
      if (row.result_delivery_state === 'delivered') return { delivered: true as const, evidenceIds: priorEvidence, envelope: null };
      if (row.result_delivery_state === 'delivering' && row.result_delivery_expires_at && new Date(row.result_delivery_expires_at).getTime() > now) return undefined;
      const payload = parseReviewResultEnvelope(row.result_payload);
      if (!payload.authority.reviewBinding || payload.runId !== runId || payload.authority.workspaceId !== scope.workspaceId) throw new Error('SWARM_REVIEW_RESULT_BINDING_INVALID');
      await verifyReviewResultEnvelope(payload);
      const digest = await hashApprovalInput(payload);
      const existing = await tx.query<{ result_digest: string | null } & Record<string, unknown>>(
        'SELECT result_digest FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [scope.tenantId, scope.workspaceId, runId]);
      if (existing.rows[0]?.result_digest !== digest) throw new Error('SWARM_REVIEW_RESULT_DIGEST_MISMATCH');
      await tx.query("UPDATE swarm_run_queue SET result_delivery_state='delivering',result_delivery_token=$4,result_delivery_expires_at=$5,result_delivery_attempts=result_delivery_attempts+1,result_delivery_error=NULL,updated_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3",
        [scope.tenantId, scope.workspaceId, runId, token, expiry, new Date(now).toISOString()]);
      await appendQueueEvent(tx, { id: uuidv7(), scope, runId, type: 'result_delivery_claimed', fromState: row.state, toState: row.state, actorId: payload.authority.principalId, approvalId: payload.authority.verifiedApproval?.approvalId ?? null, occurredAt: new Date(now).toISOString(), detail: {} });
      return { delivered: false as const, evidenceIds: [] as readonly string[], envelope: payload };
    });
    if (!reservation || reservation.delivered) return reservation ? { delivered: true, evidenceIds: reservation.evidenceIds } : { delivered: false, evidenceIds: [] };

    try {
      const response = await sink.persist(reservation.envelope);
      const evidenceIds = response.evidenceIds.map((id) => z.uuid().parse(id));
      const stamp = new Date(this.now()).toISOString();
      const committed = await this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
        const updated = await tx.query<{ id: string } & Record<string, unknown>>(
          "UPDATE swarm_run_queue SET result_delivery_state='delivered',result_delivery_token=NULL,result_delivery_expires_at=NULL,result_evidence_ids=$5::jsonb,result_delivery_error=NULL,updated_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND result_delivery_state='delivering' AND result_delivery_token=$4 RETURNING id",
          [scope.tenantId, scope.workspaceId, runId, token, JSON.stringify(evidenceIds), stamp]);
        if (!updated.rows.length) return false;
        await appendQueueEvent(tx, { id: uuidv7(), scope, runId, type: 'result_delivered', fromState: 'completed', toState: 'completed', actorId: reservation.envelope.authority.principalId, approvalId: reservation.envelope.authority.verifiedApproval?.approvalId ?? null, occurredAt: stamp, detail: { evidenceIds } });
        return true;
      });
      return { delivered: committed, evidenceIds: committed ? evidenceIds : [] };
    } catch {
      const stamp = new Date(this.now()).toISOString();
      await this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
        const updated = await tx.query<{ id: string } & Record<string, unknown>>(
          "UPDATE swarm_run_queue SET result_delivery_state='pending',result_delivery_token=NULL,result_delivery_expires_at=NULL,result_delivery_error='REVIEW_RESULT_DELIVERY_FAILED',updated_at=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND result_delivery_state='delivering' AND result_delivery_token=$4 RETURNING id",
          [scope.tenantId, scope.workspaceId, runId, token, stamp]);
        if (updated.rows.length) await appendQueueEvent(tx, { id: uuidv7(), scope, runId, type: 'result_delivery_failed', fromState: 'completed', toState: 'completed', actorId: reservation.envelope.authority.principalId, approvalId: reservation.envelope.authority.verifiedApproval?.approvalId ?? null, occurredAt: stamp, detail: { reason: 'REVIEW_RESULT_DELIVERY_FAILED' } });
      });
      return { delivered: false, evidenceIds: [] };
    }
  }

  private async claimPreparedReview(prepared: PreparedAgentRun, workerId: string): Promise<{ token: string } | undefined> {
    const { input, authority } = prepared;
    const scope = { tenantId: authority.tenantId, workspaceId: authority.workspaceId };
    const token = uuidv7();
    const stamp = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + input.profile.budgets.maxDurationMs + 30_000).toISOString();
    return this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      await tx.query('SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE', [scope.tenantId, scope.workspaceId]);
      const kill = await tx.query<{ engaged: boolean } & Record<string, unknown>>('SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2', [scope.tenantId, scope.workspaceId]);
      if (kill.rows[0]?.engaged) return undefined;
      const selected = await tx.query<{ state: QueueState } & Record<string, unknown>>(
        'SELECT state FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [scope.tenantId, scope.workspaceId, input.runId]);
      if (selected.rows[0]?.state !== 'queued') return undefined;
      const claimed = await tx.query<{ id: string } & Record<string, unknown>>(
        "UPDATE swarm_run_queue SET state='running',claim_token=$4,claimed_by=$5,claim_expires_at=$6,started_at=$7,updated_at=$7 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='queued' RETURNING id",
        [scope.tenantId, scope.workspaceId, input.runId, token, workerId, expiresAt, stamp]);
      if (!claimed.rows.length) return undefined;
      await appendQueueEvent(tx, { id: uuidv7(), scope, runId: input.runId, type: 'claimed', fromState: 'queued', toState: 'claimed', actorId: authority.principalId, approvalId: authority.verifiedApproval?.approvalId ?? null, occurredAt: stamp, detail: { workerId, claimToken: token } });
      await tx.query(
        'INSERT INTO swarm_runs(id,tenant_id,workspace_id,profile_id,parent_run_id,budgets,started_at,created_by) VALUES($1,$2,$3,$4,NULL,$5::jsonb,$6,$7)',
        [input.runId, scope.tenantId, scope.workspaceId, input.profile.id, JSON.stringify(input.profile.budgets), stamp, authority.principalId]);
      await tx.query(
        "INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,detail,occurred_at,created_by) VALUES($1,$2,$3,$4,0,'run.started',$5::jsonb,$6,$7)",
        [uuidv7(), scope.tenantId, scope.workspaceId, input.runId, JSON.stringify({ profileId: input.profile.id, reviewBinding: authority.reviewBinding }), stamp, authority.principalId]);
      await appendQueueEvent(tx, { id: uuidv7(), scope, runId: input.runId, type: 'running', fromState: 'claimed', toState: 'running', actorId: authority.principalId, approvalId: authority.verifiedApproval?.approvalId ?? null, occurredAt: stamp, detail: {} });
      return { token };
    });
  }

  private async finishPreparedReview(prepared: PreparedAgentRun, token: string, original: PreparedAgentRunResult): Promise<{ termination: AgentRunResult['termination']; queueState: QueueState; envelope: PreparedAgentRunResult }> {
    const { input, authority } = prepared;
    let envelope = original;
    const scope = { tenantId: authority.tenantId, workspaceId: authority.workspaceId };
    let resultPayload = JSON.stringify(envelope);
    if (new TextEncoder().encode(resultPayload).byteLength > this.options.maxResultPayloadBytes) {
      const result: AgentRunResult = { ...envelope.result, termination: 'FAILED', output: null,
        counters: { ...envelope.result.counters, failures: envelope.result.counters.failures + 1 }, artifacts: [] };
      envelope = { ...envelope, outputDigest: await hashApprovalInput(null), artifactDigests: [], result };
      resultPayload = JSON.stringify(envelope);
      if (new TextEncoder().encode(resultPayload).byteLength > this.options.maxResultPayloadBytes) throw new Error('SWARM_REVIEW_RESULT_TOO_LARGE');
    }
    const digest = await hashApprovalInput(envelope);
    const stamp = new Date(this.now()).toISOString();
    return this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      await tx.query('SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE', [scope.tenantId, scope.workspaceId]);
      const kill = await tx.query<{ engaged: boolean } & Record<string, unknown>>('SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2', [scope.tenantId, scope.workspaceId]);
      const current = await tx.query<{ state: QueueState; cancellation_requested: boolean; claim_expires_at: Date | string | null } & Record<string, unknown>>(
        'SELECT state,cancellation_requested,claim_expires_at FROM swarm_run_queue WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND claim_token=$4 FOR UPDATE',
        [scope.tenantId, scope.workspaceId, input.runId, token]);
      const row = current.rows[0];
      if (!row || row.state !== 'running' || !row.claim_expires_at || new Date(row.claim_expires_at).getTime() <= this.now()) throw new Error('SWARM_RUN_CLAIM_LOST');
      if ((kill.rows[0]?.engaged || row.cancellation_requested) && envelope.result.termination === 'COMPLETED') {
        const termination = kill.rows[0]?.engaged ? 'KILL_SWITCH' : 'CANCELED';
        const finalResult: AgentRunResult = { ...envelope.result, termination, output: null, artifacts: [] };
        envelope = { ...envelope, outputDigest: await hashApprovalInput(null), artifactDigests: [], result: finalResult };
      }
      const finalDigest = envelope === original ? digest : await hashApprovalInput(envelope);
      const finalPayload = JSON.stringify(envelope);
      const finalState: QueueState = envelope.result.termination === 'COMPLETED' ? 'completed'
        : envelope.result.termination === 'CANCELED' || envelope.result.termination === 'KILL_SWITCH' ? 'canceled' : 'failed';
      const errorCode = finalState === 'completed' ? null : envelope.result.termination;

      const journalEvents = envelope.result.events.filter((event) => event.type !== 'run.started');
      let seq = 1;
      for (const event of journalEvents) {
        await tx.query('INSERT INTO swarm_run_journal(id,tenant_id,workspace_id,run_id,seq,event_type,detail,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
          [uuidv7(), scope.tenantId, scope.workspaceId, input.runId, seq++, event.type, JSON.stringify(event.detail), event.at, authority.principalId]);
      }
      await tx.query(
        'INSERT INTO swarm_run_outcomes(id,tenant_id,workspace_id,run_id,termination,output,iterations,actions,failures,cost_usd,ended_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [uuidv7(), scope.tenantId, scope.workspaceId, input.runId, envelope.result.termination, envelope.result.output, envelope.result.counters.iterations,
          envelope.result.counters.actions, envelope.result.counters.failures, envelope.result.counters.costUsd, stamp, authority.principalId]);
      const changed = await tx.query<{ id: string } & Record<string, unknown>>(
        'UPDATE swarm_run_queue SET state=$5,error_code=$6,ended_at=$7,updated_at=$7,claim_token=NULL,claimed_by=NULL,claim_expires_at=NULL,result_delivery_state=\'pending\',result_payload=$8::jsonb,result_digest=$9 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND claim_token=$4 AND state=\'running\' RETURNING id',
        [scope.tenantId, scope.workspaceId, input.runId, token, finalState, errorCode, stamp, finalPayload, finalDigest]);
      if (!changed.rows.length) throw new Error('SWARM_RUN_CLAIM_LOST');
      await appendQueueEvent(tx, { id: uuidv7(), scope, runId: input.runId, type: finalState === 'completed' ? 'completed' : finalState, fromState: 'running', toState: finalState, actorId: authority.principalId,
        approvalId: authority.verifiedApproval?.approvalId ?? null, occurredAt: stamp, detail: { termination: envelope.result.termination, resultDigest: finalDigest } });
      return { termination: envelope.result.termination, queueState: finalState, envelope };
    });
  }
}

async function failedReviewEnvelope(prepared: PreparedAgentRun, now: number): Promise<PreparedAgentRunResult> {
  const at = new Date(now).toISOString();
  const event = { type: 'run.terminated' as const, runId: prepared.input.runId, at, detail: { termination: 'FAILED' } };
  const result: AgentRunResult = { runId: prepared.input.runId, termination: 'FAILED', output: null,
    counters: { iterations: 0, actions: 0, failures: 1, costUsd: 0 }, events: [event], artifacts: [] };
  return { runId: result.runId, authority: prepared.authority, outputDigest: await hashApprovalInput(null), artifactDigests: [], result };
}

function parseStringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; } catch { return []; }
  }
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

function parseReviewResultEnvelope(value: unknown): PreparedAgentRunResult {
  let candidate = value;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) as unknown; } catch { throw new Error('SWARM_REVIEW_RESULT_INVALID'); }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('SWARM_REVIEW_RESULT_INVALID');
  const envelope = candidate as Partial<PreparedAgentRunResult>;
  if (typeof envelope.runId !== 'string' || !envelope.authority || !envelope.result ||
    typeof envelope.outputDigest !== 'string' || !Array.isArray(envelope.artifactDigests)) throw new Error('SWARM_REVIEW_RESULT_INVALID');
  return envelope as PreparedAgentRunResult;
}

async function verifyReviewResultEnvelope(envelope: PreparedAgentRunResult): Promise<void> {
  const { result } = envelope;
  if (result.runId !== envelope.runId || envelope.authority.verifiedApproval?.capabilityId !== ENQUEUE_CAPABILITY ||
    envelope.outputDigest !== await hashApprovalInput(result.output) || envelope.artifactDigests.length !== result.artifacts.length) {
    throw new Error('SWARM_REVIEW_RESULT_DIGEST_MISMATCH');
  }
  for (let i = 0; i < result.artifacts.length; i += 1) {
    const artifact = result.artifacts[i];
    const digest = envelope.artifactDigests[i];
    if (!artifact || !digest || digest.id !== artifact.id || digest.sha256 !== await hashApprovalInput(artifact.content)) {
      throw new Error('SWARM_REVIEW_RESULT_ARTIFACT_DIGEST_MISMATCH');
    }
  }
}

/** Narrow trusted host read/set API. Host may hydrate its in-memory signal from set's result. */
export class SwarmKillSwitchService implements KillSwitchReader {
  constructor(private readonly store: LocalScopedStore, private readonly now: () => number = Date.now) {}

  async getKillSwitch(scope: Scope): Promise<KillSwitchSnapshot> {
    const { rows } = await this.store.query<{ engaged: boolean; reason: string | null; changed_by: string; changed_at: Date | string } & Record<string, unknown>>(
      scope, 'SELECT engaged,reason,changed_by,changed_at FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2', [scope.tenantId, scope.workspaceId]);
    const row = rows[0];
    return row ? { engaged: row.engaged, reason: row.reason, changedBy: row.changed_by, changedAt: new Date(row.changed_at).toISOString() }
      : { engaged: false, reason: null, changedBy: null, changedAt: null };
  }

  /** Only the verified `swarm.kill-switch.set` capability can mutate durable state. */
  async setKillSwitch(context: SwarmTrustedCallContext, engaged: boolean, reason: string | null): Promise<KillSwitchSnapshot> {
    assertTrustedContext(context, KILL_SWITCH_CAPABILITY);
    if (reason !== null && (reason.trim().length > 500 || reason !== reason.trim())) throw new Error('SWARM_KILL_SWITCH_REASON_INVALID');
    if (engaged && !reason) throw new Error('SWARM_KILL_SWITCH_REASON_REQUIRED');
    const proof = context.approval;
    if (!proof) throw new Error('SWARM_KILL_SWITCH_APPROVAL_REQUIRED');
    await verifyApproval(proof, this.now(), {
      capabilityId: KILL_SWITCH_CAPABILITY,
      principalId: context.principal.id,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      input: { engaged, reason },
    });

    const scope = { tenantId: context.tenantId, workspaceId: context.workspaceId };
    const stamp = new Date(this.now()).toISOString();
    return this.store.withServerScope(scope, SERVER_WRITER, undefined, async (tx) => {
      await lockOrCreateKillSwitch(tx, scope, context.actorId, stamp);
      const current = await tx.query<{ engaged: boolean; reason: string | null; changed_by: string; changed_at: Date | string } & Record<string, unknown>>(
        'SELECT engaged,reason,changed_by,changed_at FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE',
        [scope.tenantId, scope.workspaceId]);
      const row = current.rows[0];
      if (!row) throw new Error('SWARM_KILL_SWITCH_STATE_MISSING');
      if (row.engaged === engaged && row.reason === reason) return { engaged: row.engaged, reason: row.reason, changedBy: row.changed_by, changedAt: new Date(row.changed_at).toISOString() };
      await tx.query('UPDATE swarm_workspace_kill_switch SET engaged=$3,reason=$4,changed_by=$5,changed_at=$6 WHERE tenant_id=$1 AND workspace_id=$2',
        [scope.tenantId, scope.workspaceId, engaged, reason, context.actorId, stamp]);
      await tx.query('INSERT INTO swarm_kill_switch_events(id,tenant_id,workspace_id,engaged,reason,changed_by,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [uuidv7(), scope.tenantId, scope.workspaceId, engaged, reason, context.actorId, stamp]);

      if (engaged) await refusePendingRuns(tx, scope, context.actorId, proof.approvalId, stamp);
      return { engaged, reason, changedBy: context.actorId, changedAt: stamp };
    });
  }
}

async function refusePendingRuns(tx: ScopedTransaction, scope: Scope, actorId: string, approvalId: string, stamp: string): Promise<void> {
  const queued = await tx.query<{ id: string } & Record<string, unknown>>(
    "UPDATE swarm_run_queue SET state='refused',error_code='KILL_SWITCH_ENGAGED',ended_at=$3,updated_at=$3 WHERE tenant_id=$1 AND workspace_id=$2 AND state='queued' RETURNING id",
    [scope.tenantId, scope.workspaceId, stamp]);
  for (const row of queued.rows) await appendQueueEvent(tx, { id: uuidv7(), scope, runId: row.id,
    type: 'refused', fromState: 'queued', toState: 'refused', actorId, approvalId, occurredAt: stamp, detail: { reason: 'kill_switch_engaged' } });

  const active = await tx.query<{ id: string; state: QueueState } & Record<string, unknown>>(
    "UPDATE swarm_run_queue SET cancellation_requested=true,updated_at=$3 WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('claimed','running') AND cancellation_requested=false RETURNING id,state",
    [scope.tenantId, scope.workspaceId, stamp]);
  for (const row of active.rows) await appendQueueEvent(tx, { id: uuidv7(), scope, runId: row.id,
    type: 'cancel_requested', fromState: row.state, toState: row.state, actorId, approvalId, occurredAt: stamp, detail: { reason: 'kill_switch_engaged' } });
}

async function lockOrCreateKillSwitch(tx: ScopedTransaction, scope: Scope, actorId: string, stamp: string): Promise<void> {
  await tx.query(
    'INSERT INTO swarm_workspace_kill_switch(tenant_id,workspace_id,engaged,reason,changed_by,changed_at) VALUES($1,$2,false,NULL,$3,$4) ON CONFLICT(tenant_id,workspace_id) DO NOTHING',
    [scope.tenantId, scope.workspaceId, actorId, stamp]);
  await tx.query('SELECT engaged FROM swarm_workspace_kill_switch WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE', [scope.tenantId, scope.workspaceId]);
}

async function appendQueueEvent(tx: ScopedTransaction, input: {
  readonly id: string; readonly scope: Scope; readonly runId: string; readonly type: string;
  readonly fromState: QueueState | null; readonly toState: QueueState; readonly actorId: string;
  readonly approvalId: string | null; readonly occurredAt: string; readonly detail: Readonly<Record<string, unknown>>;
}): Promise<void> {
  await tx.query(
    'INSERT INTO swarm_run_queue_events(id,tenant_id,workspace_id,run_id,event_type,from_state,to_state,detail,actor_id,approval_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)',
    [input.id, input.scope.tenantId, input.scope.workspaceId, input.runId, input.type, input.fromState, input.toState, JSON.stringify(input.detail), input.actorId, input.approvalId, input.occurredAt]);
}

function admissionFor(runId: string, state: QueueState): QueueAdmissionResult {
  if (state === 'queued' || state === 'claimed' || state === 'running') return { accepted: true, runId, state, reason: null };
  return { accepted: false, runId, state, reason: state === 'refused' ? 'kill_switch_engaged' : `run_${state}` };
}

function assertTrustedContext(context: SwarmTrustedCallContext, capabilityId: string): void {
  if (!context || context.capabilityId !== capabilityId || context.actorId !== context.principal.id ||
    context.tenantId !== context.principal.tenantId || !context.principal.workspaces.some((item) => item.id === context.workspaceId)) {
    throw new Error('SWARM_TRUSTED_CAPABILITY_CONTEXT_REQUIRED');
  }
}

async function verifyApproval(proofValue: VerifiedApproval, now: number, expected: {
  readonly capabilityId: string; readonly principalId: string; readonly tenantId: string; readonly workspaceId: string; readonly input: unknown;
}): Promise<void> {
  const proof = VerifiedCapabilityApproval.parse(proofValue);
  const { scopeHash, ...binding } = proof;
  if (proof.capabilityId !== expected.capabilityId || proof.principalId !== expected.principalId ||
    proof.tenantId !== expected.tenantId || proof.workspaceId !== expected.workspaceId ||
    Date.parse(proof.expiresAt) <= now || proof.inputDigest !== await hashApprovalInput(expected.input) ||
    scopeHash !== await hashApprovalScope(binding)) throw new Error('SWARM_APPROVAL_BINDING_INVALID');
}
