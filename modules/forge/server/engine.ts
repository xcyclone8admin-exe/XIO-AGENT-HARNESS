import { createHash } from 'node:crypto';
import { uuidv7 } from '@xyra/core';
import {
  ApprovalRecord, ChaosRequest, Evidence, Gate, GateEvaluation, HierarchyNode, Promotion, RiskAcceptance,
  ScheduleRequest, type Finding as FindingType, type HierarchyNode as NodeType, type ScheduleResult,
} from '../contracts';

const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');

/** Deterministic planner only: this service has no process, shell, network or deployment dependency. */
export function planSchedule(input: unknown): zReturn<typeof ScheduleResult> {
  const request = ScheduleRequest.parse(input);
  if (request.killSwitchEngaged) return { runId: uuidv7(), state: 'stopped', runnableTicketIds: [], blockedTicketIds: request.tickets.map((t) => t.id), reason: 'KILL_SWITCH_ENGAGED', externalExecution: false };
  const approval = ApprovalRecord.parse(request.approval);
  const workspaceIds = new Set(request.tickets.map((ticket) => ticket.workspaceId));
  if (approval.epicId !== request.epicId || (workspaceIds.size > 0 && (workspaceIds.size !== 1 || !workspaceIds.has(approval.workspaceId))) || approval.status !== 'approved' || Date.parse(approval.expiresAt) <= Date.now()) {
    return { runId: uuidv7(), state: 'blocked', runnableTicketIds: [], blockedTicketIds: request.tickets.map((t) => t.id), reason: 'VALID_EPIC_APPROVAL_REQUIRED', externalExecution: false };
  }
  if (request.spentUsd >= request.config.maxBudgetUsd) return { runId: uuidv7(), state: 'blocked', runnableTicketIds: [], blockedTicketIds: request.tickets.map((t) => t.id), reason: 'BUDGET_EXHAUSTED', externalExecution: false };
  const nodes = request.tickets.map((ticket) => HierarchyNode.parse(ticket));
  const done = new Set(nodes.filter((ticket) => ticket.state === 'done').map((ticket) => ticket.id));
  const blocked = new Set<string>();
  const runnable = nodes.filter((ticket) => {
    if (ticket.kind !== 'ticket' && ticket.kind !== 'subtask') return false;
    if (ticket.state !== 'ready' && ticket.state !== 'queued') return false;
    if (ticket.dependencies.some((id) => !done.has(id))) { blocked.add(ticket.id); return false; }
    if (ticket.dependencies.some((id) => !nodes.some((node) => node.id === id) && !done.has(id))) { blocked.add(ticket.id); return false; }
    if (request.config.resourceLocks.some((lock) => lock.startsWith(`${ticket.id}:`))) { blocked.add(ticket.id); return false; }
    return true;
  }).slice(0, request.config.maxConcurrency);
  const runId = uuidv7();
  return { runId, state: runnable.length ? 'queued' : 'blocked', runnableTicketIds: runnable.map((ticket) => ticket.id), blockedTicketIds: [...new Set([...blocked, ...nodes.filter((t) => (t.kind === 'ticket' || t.kind === 'subtask') && !runnable.includes(t) && t.state !== 'done' && t.state !== 'canceled').map((t) => t.id)])], reason: runnable.length ? null : 'NO_RUNNABLE_TICKETS', externalExecution: false };
}

export function classifyDiscovery(ticket: NodeType, summary: string, evidenceIds: string[], affectedTicketIds: string[]) {
  const classification = /security|tenant|architecture|requirement|data loss|secret/i.test(summary) ? 'critical' : /scope|contract|dependency|acceptance|migration/i.test(summary) ? 'material' : 'informational';
  return {
    id: uuidv7(), workspaceId: ticket.workspaceId, ticketId: ticket.id, classification, summary,
    evidenceIds, affectedTicketIds: classification === 'informational' ? [] : [...new Set([ticket.id, ...affectedTicketIds])],
    escalated: classification !== 'informational', createdAt: now(),
  };
}

export function createFinding(input: Omit<FindingType, 'id' | 'createdAt'>): FindingType {
  return { ...input, id: uuidv7(), createdAt: now() };
}

export function authorizeChaosTarget(input: unknown) {
  const request = ChaosRequest.parse(input);
  if (!request.authorizedTargets.includes(request.target)) throw new Error(`UNAUTHORIZED_CHAOS_TARGET:${request.target}`);
  if (request.target !== 'sandbox' && request.target !== 'staging') throw new Error(`UNSAFE_CHAOS_TARGET:${request.target}`);
  return { target: request.target, executed: false as const, reason: 'PROCESS_EXECUTION_DISABLED' as const };
}

export function evaluateGates(rawGates: readonly unknown[], riskAcceptances: readonly unknown[]) {
  const gates = rawGates.map((gate) => Gate.parse(gate));
  for (const gate of gates) if (gate.kind === 'deterministic' && gate.status === 'pass' && gate.evidenceIds.length === 0) throw new Error(`DETERMINISTIC_GATE_WITHOUT_EVIDENCE:${gate.id}`);
  const acceptances = riskAcceptances.map((acceptance) => {
    const parsed = RiskAcceptance.parse(acceptance);
    if (parsed.approval.status !== 'approved' || Date.parse(parsed.approval.expiresAt) <= Date.now()) throw new Error(`INVALID_RISK_ACCEPTANCE:${parsed.gateId}`);
    return parsed;
  });
  const acceptedGateIds = new Set(acceptances.map((acceptance) => acceptance.gateId));
  for (const acceptance of acceptances) {
    const gate = gates.find((candidate) => candidate.id === acceptance.gateId);
    if (!gate || !gate.hard || gate.status !== 'fail') throw new Error(`RISK_ACCEPTANCE_NOT_APPLICABLE:${acceptance.gateId}`);
  }
  const deterministicFailure = gates.some((gate) => gate.kind === 'deterministic' && gate.hard && gate.status === 'fail' && !acceptedGateIds.has(gate.id));
  const failedHard = gates.some((gate) => gate.hard && gate.status === 'fail' && !acceptedGateIds.has(gate.id));
  const pendingHard = gates.some((gate) => gate.hard && gate.status !== 'pass' && !(gate.status === 'fail' && acceptedGateIds.has(gate.id)));
  return GateEvaluation.parse({ gates, overall: deterministicFailure || failedHard ? 'fail' : pendingHard ? 'blocked' : 'pass', aiJudgmentAllowed: false, deterministicBeforeJudgment: true });
}

export function deriveGateMatrix(requirements: readonly { requirementId: string; risk: 'low' | 'medium' | 'high' | 'critical'; evidenceIds: readonly string[] }[], evidenceRows: readonly zReturn<typeof Evidence>[]) {
  const evidenceById = new Map(evidenceRows.map((item) => [item.id, item]));
  const gates = requirements.map((requirement) => {
    const matched = requirement.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is zReturn<typeof Evidence> => item !== undefined);
    const complete = matched.length === requirement.evidenceIds.length && matched.length > 0;
    const status = !complete ? 'pending' : matched.some((item) => item.result === 'fail') ? 'fail' : matched.some((item) => item.result !== 'pass') ? 'blocked' : 'pass';
    return { id: `req:${requirement.requirementId}`, requirementId: requirement.requirementId, kind: 'deterministic' as const, evidenceIds: matched.map((item) => item.id), status: status as 'pass' | 'fail' | 'pending' | 'blocked', hard: requirement.risk === 'high' || requirement.risk === 'critical' };
  });
  return evaluateGates(gates, []);
}

export function createEvidence(input: Omit<zReturn<typeof Evidence>, 'id' | 'verifiedAt' | 'sha256'> & { sha256?: string | undefined; payload?: unknown }) {
  const { payload, ...metadata } = input;
  const sourceHash = metadata.sha256 ?? hash(payload ?? metadata);
  return Evidence.parse({ ...metadata, sha256: sourceHash, id: uuidv7(), verifiedAt: now() });
}

export function requestPromotion(input: unknown) {
  const { promotion: raw, gates: rawGates, productionApproval: rawApproval } = input as { promotion: unknown; gates: unknown[]; productionApproval: unknown };
  const promotion = Promotion.parse(raw);
  const gates = rawGates.map((gate) => Gate.parse(gate));
  const missingGateIds = gates.filter((gate) => gate.hard && gate.status !== 'pass').map((gate) => gate.id);
  if (promotion.to === 'main') {
    if (!rawApproval) throw new Error('PRODUCTION_APPROVAL_REQUIRED');
    const productionApproval = ApprovalRecord.parse(rawApproval);
    if (productionApproval.status !== 'approved' || Date.parse(productionApproval.expiresAt) <= Date.now()) throw new Error('PRODUCTION_APPROVAL_REQUIRED');
    if (productionApproval.workspaceId !== promotion.workspaceId || productionApproval.scopeHash !== hash({ workspaceId: promotion.workspaceId, commitSha: promotion.commitSha, from: promotion.from, to: promotion.to })) throw new Error('PRODUCTION_APPROVAL_SCOPE_MISMATCH');
  }
  if (missingGateIds.length) throw new Error(`PROMOTION_GATES_MISSING:${missingGateIds.join(',')}`);
  return Promotion.parse({ ...promotion, state: 'proposed', missingGateIds, createdAt: now(), approvalId: promotion.to === 'main' ? ApprovalRecord.parse(rawApproval).id : promotion.approvalId });
}

export function rollbackPromotion(promotion: unknown, rollbackEvidence: unknown) {
  const current = Promotion.parse(promotion);
  const evidence = Evidence.parse(rollbackEvidence);
  if (current.state !== 'promoted') throw new Error('ROLLBACK_REQUIRES_PROMOTED_RECORD');
  if (evidence.workspaceId !== current.workspaceId || evidence.result !== 'pass') throw new Error('ROLLBACK_EVIDENCE_REQUIRED');
  return Promotion.parse({ ...current, id: uuidv7(), state: 'rolled-back', rollbackOf: current.id, evidenceIds: [...current.evidenceIds, evidence.id], createdAt: now() });
}

export type zReturn<T extends { parse: (value: unknown) => unknown }> = ReturnType<T['parse']>;
