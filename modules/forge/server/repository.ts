import { uuidv7 } from '@xyra/core';
import { createHash } from 'node:crypto';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { ApprovalRecord, CreateEvidenceRequest, CreateFindingRequest, DiscoveryRequest, EpicState, Evidence, Finding, FindingStateUpdate, ForgeNodeCreate, ForgeNodeUpdate, ForgeProjectCreate, ForgeProjectUpdate, ForgeRunEvent, ForgeSchedule, GateMatrixRequest, HierarchyNode, SourceRecordCreate, TicketState } from '../contracts';
import { createEvidence, createFinding, classifyDiscovery, deriveGateMatrix } from './engine';
import { transitionEpic, transitionFinding, transitionTicket } from './state-machine';

export interface ForgeActor { readonly id: string; readonly tenantId: string; readonly workspaceId: string }
type ProjectRow = Record<string, unknown> & { id: string; workspace_id: string; name: string; description: string; status: string; requirements: unknown; created_at: string; updated_at: string };
type NodeRow = Record<string, unknown> & { id: string; tenant_id: string; workspace_id: string; project_id: string; parent_id: string | null; kind: string; title: string; description: string; state: string; priority: string; dependencies: unknown; requirement_refs: unknown; acceptance_criteria: unknown; evidence_ids: unknown; owner_id: string | null; created_by: string; created_at: string; updated_at: string };
const json = (value: unknown) => JSON.stringify(value);
const timestamp = (value: unknown) => new Date(value as string | Date).toISOString();

/** Workspace-scoped durable Forge operations. Identity values always come from trusted BusCall context. */
export class ForgeRepository {
  constructor(private readonly store: LocalScopedStore) {}
  private scope(actor: ForgeActor): Scope { return { tenantId: actor.tenantId, workspaceId: actor.workspaceId }; }

  async projects(actor: ForgeActor) {
    const { rows } = await this.store.query<ProjectRow>(this.scope(actor), 'SELECT id, workspace_id, name, description, status, requirements, created_at, updated_at FROM forge_projects ORDER BY created_at DESC');
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description, status: row.status, requirements: row.requirements, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
  }
  async createProject(actor: ForgeActor, raw: unknown) {
    const input = ForgeProjectCreate.parse(raw); const id = uuidv7();
    const { rows } = await this.store.query<ProjectRow>(this.scope(actor), 'INSERT INTO forge_projects(id,tenant_id,workspace_id,name,description,requirements,created_by) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id,workspace_id,name,description,status,requirements,created_at,updated_at', [id, actor.tenantId, actor.workspaceId, input.name, input.description, json(input.requirements), actor.id]);
    const row = rows[0]; if (!row) throw new Error('FORGE_PROJECT_CREATE_FAILED');
    return { id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description, status: row.status, requirements: row.requirements, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
  }
  async updateProject(actor: ForgeActor, raw: unknown) {
    const { projectId, ...input } = ForgeProjectUpdate.parse(raw);
    const row = await this.store.query<ProjectRow>(this.scope(actor), 'UPDATE forge_projects SET name=COALESCE($3,name), description=COALESCE($4,description), requirements=COALESCE($5::jsonb,requirements), updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$6 RETURNING id,workspace_id,name,description,status,requirements,created_at,updated_at', [actor.tenantId, actor.workspaceId, input.name ?? null, input.description ?? null, input.requirements === undefined ? null : json(input.requirements), projectId]);
    const value = row.rows[0]; if (!value) throw new Error('FORGE_PROJECT_NOT_FOUND');
    return { id: value.id, workspaceId: value.workspace_id, name: value.name, description: value.description, status: value.status, requirements: value.requirements, createdAt: timestamp(value.created_at), updatedAt: timestamp(value.updated_at) };
  }
  async nodes(actor: ForgeActor, projectId: string) {
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,evidence_ids,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY created_at', [actor.tenantId, actor.workspaceId, projectId]);
    return rows.map((row) => HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, evidenceIds: row.evidence_ids, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
  }
  async createNode(actor: ForgeActor, projectId: string, raw: unknown) {
    const node = ForgeNodeCreate.parse(raw); const id = uuidv7();
    if (node.kind === 'epic' || node.kind === 'spec' || node.kind === 'plan' || node.kind === 'wave') EpicState.parse(node.state);
    else TicketState.parse(node.state);
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15) RETURNING id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,evidence_ids,owner_id,created_by,created_at,updated_at', [id, actor.tenantId, actor.workspaceId, projectId, node.parentId, node.kind, node.title, node.description, node.state, node.priority, json(node.dependencies), json(node.requirements), json(node.acceptanceCriteria), node.ownerId, actor.id]);
    const row = rows[0]; if (!row) throw new Error('FORGE_NODE_CREATE_FAILED');
    return HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, evidenceIds: row.evidence_ids, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }
  async updateNode(actor: ForgeActor, raw: unknown) {
    const { nodeId, ...input } = ForgeNodeUpdate.parse(raw);
    const current = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,evidence_ids,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, nodeId]);
    const old = current.rows[0]; if (!old) throw new Error('FORGE_NODE_NOT_FOUND');
    if (input.state && input.state !== old.state) {
      if (old.kind === 'epic' || old.kind === 'spec' || old.kind === 'plan' || old.kind === 'wave') transitionEpic(old.state, input.state);
      else if (old.kind === 'ticket' || old.kind === 'subtask') {
        const { transitionTicket } = await import('./state-machine'); transitionTicket(old.state, input.state);
      } else throw new Error('FORGE_NODE_STATE_TRANSITION_UNSUPPORTED');
    }
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'UPDATE forge_nodes SET title=COALESCE($4,title),description=COALESCE($5,description),state=COALESCE($6,state),priority=COALESCE($7,priority),dependencies=COALESCE($8::jsonb,dependencies),requirement_refs=COALESCE($9::jsonb,requirement_refs),acceptance_criteria=COALESCE($10::jsonb,acceptance_criteria),owner_id=CASE WHEN $12 THEN $11 ELSE owner_id END,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,evidence_ids,owner_id,created_by,created_at,updated_at', [actor.tenantId, actor.workspaceId, nodeId, input.title ?? null, input.description ?? null, input.state ?? null, input.priority ?? null, input.dependencies === undefined ? null : json(input.dependencies), input.requirements === undefined ? null : json(input.requirements), input.acceptanceCriteria === undefined ? null : json(input.acceptanceCriteria), input.ownerId ?? null, input.ownerId !== undefined]);
    const row = rows[0]; if (!row) throw new Error('FORGE_NODE_NOT_FOUND');
    return HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, evidenceIds: row.evidence_ids, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }
  async sources(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; label: string; locator: string; authority: string; status: string; sha256: string; created_at: string }>(this.scope(actor), 'SELECT id,label,locator,authority,status,sha256,created_at FROM forge_sources ORDER BY created_at DESC');
    return rows.map((row) => ({ id: row.id, label: row.label, locator: row.locator, authority: row.authority, status: row.status, sha256: row.sha256, createdAt: timestamp(row.created_at) }));
  }
  async createSource(actor: ForgeActor, raw: unknown) {
    const input = SourceRecordCreate.parse(raw); const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; label: string; locator: string; authority: string; status: string; sha256: string; created_at: string }>(this.scope(actor), 'INSERT INTO forge_sources(id,tenant_id,workspace_id,label,locator,authority,status,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,label,locator,authority,status,sha256,created_at', [id, actor.tenantId, actor.workspaceId, input.label, input.locator, 'user', 'draft', input.sha256, actor.id]);
    const row = rows[0]; if (!row) throw new Error('FORGE_SOURCE_CREATE_FAILED');
    return { id: row.id, label: row.label, locator: row.locator, authority: row.authority, status: row.status, sha256: row.sha256, createdAt: timestamp(row.created_at) };
  }
  async requestApproval(actor: ForgeActor, raw: { epicId: string }) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const epic = await this.store.query<Record<string, unknown> & { id: string; project_id: string; title: string; state: string; requirements: unknown; acceptance_criteria: unknown }>(this.scope(actor), "SELECT id,project_id,title,state,requirement_refs AS requirements,acceptance_criteria FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND kind='epic'", [actor.tenantId, actor.workspaceId, raw.epicId]);
    const epicRow = epic.rows[0]; if (!epicRow) throw new Error('FORGE_APPROVAL_EPIC_NOT_FOUND');
    if (epicRow.state !== 'proposed') throw new Error('FORGE_EPIC_MUST_BE_PROPOSED');
    const scopeHash = createHash('sha256').update(JSON.stringify({ workspaceId: actor.workspaceId, epicId: epicRow.id, projectId: epicRow.project_id, title: epicRow.title, state: epicRow.state, requirements: epicRow.requirements, acceptanceCriteria: epicRow.acceptance_criteria })).digest('hex');
    const id = uuidv7(); const { rows } = await this.store.query<Record<string, unknown> & { id: string; epic_id: string; workspace_id: string; scope_hash: string; created_at: string; expires_at: string }>(this.scope(actor), 'INSERT INTO forge_approvals(id,tenant_id,workspace_id,epic_id,scope_hash,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,epic_id,workspace_id,scope_hash,created_at,expires_at', [id, actor.tenantId, actor.workspaceId, raw.epicId, scopeHash, actor.id, expiresAt]);
    const row = rows[0]; if (!row) throw new Error('FORGE_APPROVAL_CREATE_FAILED');
    return ApprovalRecord.parse({ id: row.id, epicId: row.epic_id, workspaceId: row.workspace_id, scopeHash: row.scope_hash, status: 'pending', approvedBy: null, createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at) });
  }
  async approvals(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; epic_id: string; workspace_id: string; scope_hash: string; expires_at: string; created_at: string; decision: string | null; decided_by: string | null }>(this.scope(actor), 'SELECT a.id,a.epic_id,a.workspace_id,a.scope_hash,a.expires_at,a.created_at,d.decision,d.decided_by FROM forge_approvals a LEFT JOIN forge_approval_decisions d ON d.approval_id=a.id AND d.tenant_id=a.tenant_id AND d.workspace_id=a.workspace_id ORDER BY a.created_at DESC');
    return rows.map((row) => ApprovalRecord.parse({ id: row.id, epicId: row.epic_id, workspaceId: row.workspace_id, scopeHash: row.scope_hash, status: row.decision ?? (Date.parse(timestamp(row.expires_at)) <= Date.now() ? 'expired' : 'pending'), approvedBy: row.decision === 'approved' ? row.decided_by : null, createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at) }));
  }
  async approvedPlanData(actor: ForgeActor, approvalId: string) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; epic_id: string; workspace_id: string; scope_hash: string; expires_at: string; created_at: string; decision: string | null; decided_by: string | null; project_id: string }>(this.scope(actor), 'SELECT a.id,a.epic_id,a.workspace_id,a.scope_hash,a.expires_at,a.created_at,d.decision,d.decided_by,n.project_id FROM forge_approvals a JOIN forge_nodes n ON n.id=a.epic_id AND n.tenant_id=a.tenant_id AND n.workspace_id=a.workspace_id LEFT JOIN forge_approval_decisions d ON d.approval_id=a.id AND d.tenant_id=a.tenant_id AND d.workspace_id=a.workspace_id WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.id=$3', [actor.tenantId, actor.workspaceId, approvalId]);
    const row = rows[0];
    if (!row || row.decision !== 'approved' || !row.decided_by || Date.parse(timestamp(row.expires_at)) <= Date.now()) throw new Error('FORGE_APPROVED_DURABLE_APPROVAL_REQUIRED');
    const approval = ApprovalRecord.parse({ id: row.id, epicId: row.epic_id, workspaceId: row.workspace_id, scopeHash: row.scope_hash, status: 'approved', approvedBy: row.decided_by, createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at) });
    const tickets = await this.nodesForProject(actor, row.project_id);
    return { approval, tickets };
  }

  async persistSchedule(actor: ForgeActor, request: { epicId: string; approval: { id: string }; config: { maxConcurrency: number; maxBudgetUsd: number; resourceLocks: string[] }; spentUsd: number }, result: { runId: string; state: 'queued' | 'stopped' | 'blocked'; runnableTicketIds: string[]; blockedTicketIds: string[]; reason: string | null }) {
    await this.store.query(this.scope(actor), 'INSERT INTO forge_schedules(id,tenant_id,workspace_id,epic_id,approval_id,state,max_concurrency,max_budget_usd,spent_usd,resource_locks,runnable_ticket_ids,blocked_ticket_ids,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)', [result.runId, actor.tenantId, actor.workspaceId, request.epicId, request.approval.id, result.state, request.config.maxConcurrency, request.config.maxBudgetUsd, request.spentUsd, json(request.config.resourceLocks), json(result.runnableTicketIds), json(result.blockedTicketIds), result.reason, actor.id]);
    const queued = result.state === 'queued' ? result.runnableTicketIds : [];
    const blocked = result.state === 'stopped' ? result.blockedTicketIds.map((ticketId) => ({ ticketId, state: 'stopped' as const })) : result.blockedTicketIds.map((ticketId) => ({ ticketId, state: 'blocked' as const }));
    for (const item of [...queued.map((ticketId) => ({ ticketId, state: 'queued' as const })), ...blocked]) {
      await this.store.query(this.scope(actor), 'INSERT INTO forge_runs(id,tenant_id,workspace_id,schedule_id,ticket_id,state,external_execution,detail,created_by) VALUES($1,$2,$3,$4,$5,$6,false,$7::jsonb,$8)', [uuidv7(), actor.tenantId, actor.workspaceId, result.runId, item.ticketId, item.state, json({ reason: result.reason }), actor.id]);
    }
    return this.schedule(actor, result.runId);
  }
  async schedules(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; epic_id: string; approval_id: string; state: string; max_concurrency: number; max_budget_usd: number | string; spent_usd: number | string; resource_locks: unknown; runnable_ticket_ids: unknown; blocked_ticket_ids: unknown; reason: string | null; created_at: string }>(this.scope(actor), 'SELECT id,epic_id,approval_id,state,max_concurrency,max_budget_usd,spent_usd,resource_locks,runnable_ticket_ids,blocked_ticket_ids,reason,created_at FROM forge_schedules ORDER BY created_at DESC');
    return rows.map((row) => ForgeSchedule.parse({ id: row.id, epicId: row.epic_id, approvalId: row.approval_id, state: row.state, maxConcurrency: row.max_concurrency, maxBudgetUsd: Number(row.max_budget_usd), spentUsd: Number(row.spent_usd), resourceLocks: row.resource_locks, runnableTicketIds: row.runnable_ticket_ids, blockedTicketIds: row.blocked_ticket_ids, reason: row.reason, createdAt: timestamp(row.created_at) }));
  }
  private async schedule(actor: ForgeActor, scheduleId: string) {
    const schedule = (await this.schedules(actor)).find((item) => item.id === scheduleId);
    if (!schedule) throw new Error('FORGE_SCHEDULE_NOT_FOUND');
    return schedule;
  }
  async runs(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; schedule_id: string; ticket_id: string; state: string; external_execution: boolean; detail: unknown; created_at: string }>(this.scope(actor), 'SELECT id,schedule_id,ticket_id,state,external_execution,detail,created_at FROM forge_runs ORDER BY created_at DESC');
    return rows.map((row) => ForgeRunEvent.parse({ id: row.id, scheduleId: row.schedule_id, ticketId: row.ticket_id, state: row.state, externalExecution: row.external_execution, detail: row.detail, createdAt: timestamp(row.created_at) }));
  }
  async cancelSchedule(actor: ForgeActor, scheduleId: string, reason: string) {
    const current = await this.schedule(actor, scheduleId);
    if (current.state !== 'queued') throw new Error('FORGE_SCHEDULE_NOT_QUEUED');
    await this.store.query(this.scope(actor), "UPDATE forge_schedules SET state='canceled' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [actor.tenantId, actor.workspaceId, scheduleId]);
    for (const ticketId of current.runnableTicketIds) await this.store.query(this.scope(actor), 'INSERT INTO forge_runs(id,tenant_id,workspace_id,schedule_id,ticket_id,state,external_execution,detail,created_by) VALUES($1,$2,$3,$4,$5,\'canceled\',false,$6::jsonb,$7)', [uuidv7(), actor.tenantId, actor.workspaceId, scheduleId, ticketId, json({ reason }), actor.id]);
    return this.schedule(actor, scheduleId);
  }
  async createEvidence(actor: ForgeActor, raw: unknown) {
    const { ticketId, payload, ...request } = CreateEvidenceRequest.parse(raw);
    if (ticketId) {
      const ticket = await this.store.query(this.scope(actor), "SELECT id FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND kind IN ('ticket','subtask')", [actor.tenantId, actor.workspaceId, ticketId]);
      if (!ticket.rows.length) throw new Error('FORGE_EVIDENCE_TICKET_NOT_FOUND');
    }
    const evidence = createEvidence({ ...request, workspaceId: actor.workspaceId, ...(payload === undefined ? {} : { payload }) });
    await this.store.query(this.scope(actor), 'INSERT INTO forge_evidence(id,tenant_id,workspace_id,requirement_id,kind,source,sha256,deterministic,result,verified_at,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)', [evidence.id, actor.tenantId, actor.workspaceId, evidence.requirementId, evidence.kind, evidence.source, evidence.sha256, evidence.deterministic, evidence.result, evidence.verifiedAt, actor.id, json({ payloadIncludedInHash: payload !== undefined })]);
    if (ticketId) {
      await this.store.query(this.scope(actor), 'INSERT INTO forge_node_evidence(tenant_id,workspace_id,ticket_id,evidence_id,created_by) VALUES($1,$2,$3,$4,$5)', [actor.tenantId, actor.workspaceId, ticketId, evidence.id, actor.id]);
      await this.store.query(this.scope(actor), 'UPDATE forge_nodes SET evidence_ids=(SELECT COALESCE(jsonb_agg(evidence_id ORDER BY created_at),\'[]\'::jsonb) FROM forge_node_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND ticket_id=$3),updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, ticketId]);
    }
    return evidence;
  }
  async evidence(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; workspace_id: string; requirement_id: string; kind: string; source: string; sha256: string; verified_at: string; deterministic: boolean; result: string }>(this.scope(actor), 'SELECT id,workspace_id,requirement_id,kind,source,sha256,verified_at,deterministic,result FROM forge_evidence ORDER BY verified_at DESC');
    return rows.map((row) => Evidence.parse({ id: row.id, workspaceId: row.workspace_id, requirementId: row.requirement_id, kind: row.kind, source: row.source, sha256: row.sha256, verifiedAt: timestamp(row.verified_at), deterministic: row.deterministic, result: row.result }));
  }
  async gateMatrix(actor: ForgeActor, raw: unknown) {
    const request = GateMatrixRequest.parse(raw);
    const ids = [...new Set(request.requirements.flatMap((requirement) => requirement.evidenceIds))];
    const evidenceRows = ids.length ? await this.store.query<Record<string, unknown> & { id: string; workspace_id: string; requirement_id: string; kind: string; source: string; sha256: string; verified_at: string; deterministic: boolean; result: string }>(this.scope(actor), 'SELECT id,workspace_id,requirement_id,kind,source,sha256,verified_at,deterministic,result FROM forge_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])', [actor.tenantId, actor.workspaceId, ids]) : { rows: [] };
    const canonicalEvidence = evidenceRows.rows.map((row) => Evidence.parse({ id: row.id, workspaceId: row.workspace_id, requirementId: row.requirement_id, kind: row.kind, source: row.source, sha256: row.sha256, verifiedAt: timestamp(row.verified_at), deterministic: row.deterministic, result: row.result }));
    return deriveGateMatrix(request.requirements, canonicalEvidence);
  }
  async createFindingRecord(actor: ForgeActor, raw: unknown) {
    const finding = createFinding({ ...CreateFindingRequest.parse(raw), workspaceId: actor.workspaceId });
    const evidence = await this.store.query(this.scope(actor), 'SELECT id FROM forge_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])', [actor.tenantId, actor.workspaceId, finding.evidenceIds]);
    if (evidence.rows.length !== new Set(finding.evidenceIds).size) throw new Error('FORGE_FINDING_EVIDENCE_NOT_FOUND');
    await this.store.query(this.scope(actor), 'INSERT INTO forge_findings(id,tenant_id,workspace_id,role,state,severity,title,evidence_ids,affected_requirements,confidence,reproduction,remediation,revalidation,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)', [finding.id, actor.tenantId, actor.workspaceId, finding.role, finding.state, finding.severity, finding.title, json(finding.evidenceIds), json(finding.affectedRequirements), finding.confidence, finding.reproduction, finding.remediation, finding.revalidation, actor.id]);
    return finding;
  }
  async findings(actor: ForgeActor) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; workspace_id: string; role: string; initial_state: string; current_state: string | null; severity: string; title: string; evidence_ids: unknown; affected_requirements: unknown; confidence: number; reproduction: string; remediation: string; revalidation: string; created_at: string }>(this.scope(actor), 'SELECT f.id,f.workspace_id,f.role,f.state AS initial_state,e.state AS current_state,f.severity,f.title,f.evidence_ids,f.affected_requirements,f.confidence,f.reproduction,f.remediation,f.revalidation,f.created_at FROM forge_findings f LEFT JOIN LATERAL (SELECT state FROM forge_finding_events WHERE tenant_id=f.tenant_id AND workspace_id=f.workspace_id AND finding_id=f.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true ORDER BY f.created_at DESC');
    return rows.map((row) => Finding.parse({ id: row.id, workspaceId: row.workspace_id, role: row.role, state: row.current_state ?? row.initial_state, severity: row.severity, title: row.title, evidenceIds: row.evidence_ids, affectedRequirements: row.affected_requirements, confidence: Number(row.confidence), reproduction: row.reproduction, remediation: row.remediation, revalidation: row.revalidation, createdAt: timestamp(row.created_at) }));
  }
  async transitionFindingRecord(actor: ForgeActor, raw: unknown) {
    const request = FindingStateUpdate.parse(raw);
    const current = (await this.findings(actor)).find((item) => item.id === request.findingId);
    if (!current) throw new Error('FORGE_FINDING_NOT_FOUND');
    const nextState = transitionFinding(current.state, request.state);
    await this.store.query(this.scope(actor), 'INSERT INTO forge_finding_events(id,tenant_id,workspace_id,finding_id,state,detail,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [uuidv7(), actor.tenantId, actor.workspaceId, request.findingId, nextState, request.detail, actor.id]);
    return Finding.parse({ ...current, state: nextState });
  }
  async recordDiscovery(actor: ForgeActor, raw: unknown) {
    const request = DiscoveryRequest.parse(raw);
    const ticketRow = await this.store.query<Record<string, unknown> & { project_id: string }>(this.scope(actor), "SELECT project_id FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND kind IN ('ticket','subtask')", [actor.tenantId, actor.workspaceId, request.ticketId]);
    const projectId = ticketRow.rows[0]?.project_id; if (!projectId) throw new Error('FORGE_DISCOVERY_TICKET_NOT_FOUND');
    const projectNodes = await this.nodes(actor, projectId);
    const ticket = projectNodes.find((node) => node.id === request.ticketId); if (!ticket) throw new Error('FORGE_DISCOVERY_TICKET_NOT_FOUND');
    const knownEvidence = await this.store.query(this.scope(actor), 'SELECT id FROM forge_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])', [actor.tenantId, actor.workspaceId, request.evidenceIds]);
    if (knownEvidence.rows.length !== new Set(request.evidenceIds).size) throw new Error('FORGE_DISCOVERY_EVIDENCE_NOT_FOUND');
    const discovery = classifyDiscovery(ticket, request.summary, request.evidenceIds, request.affectedTicketIds);
    const impacted = new Set(discovery.affectedTicketIds.filter((id) => projectNodes.some((node) => node.id === id && (node.kind === 'ticket' || node.kind === 'subtask'))));
    if (discovery.escalated) impacted.add(ticket.id);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const node of projectNodes) if ((node.kind === 'ticket' || node.kind === 'subtask') && !impacted.has(node.id) && node.dependencies.some((dependency) => impacted.has(dependency))) { impacted.add(node.id); expanded = true; }
    }
    const blockedTicketIds: string[] = [];
    for (const node of projectNodes) {
      if (!impacted.has(node.id) || !['ready', 'queued', 'running', 'review'].includes(node.state)) continue;
      transitionTicket(node.state, 'blocked');
      await this.store.query(this.scope(actor), "UPDATE forge_nodes SET state='blocked',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [actor.tenantId, actor.workspaceId, node.id]);
      blockedTicketIds.push(node.id);
    }
    await this.store.query(this.scope(actor), "INSERT INTO forge_escalations(id,tenant_id,workspace_id,ticket_id,classification,summary,evidence_ids,affected_ticket_ids,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'open',$9)", [uuidv7(), actor.tenantId, actor.workspaceId, ticket.id, discovery.classification, discovery.summary, json(discovery.evidenceIds), json(blockedTicketIds), actor.id]);
    return { discovery, blockedTicketIds };
  }
  async recordGateEvaluation(actor: ForgeActor, evaluation: { gates: Array<{ id: string; requirementId: string; kind: 'deterministic' | 'human' | 'ai-judgment'; status: 'pass' | 'fail' | 'pending' | 'blocked'; hard: boolean; evidenceIds: string[] }> }) {
    for (const gate of evaluation.gates) await this.store.query(this.scope(actor), 'INSERT INTO forge_gates(id,tenant_id,workspace_id,requirement_id,kind,status,hard,evidence_ids,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)', [`${uuidv7()}:${gate.id}`, actor.tenantId, actor.workspaceId, gate.requirementId, gate.kind, gate.status, gate.hard, json(gate.evidenceIds), actor.id]);
    return evaluation;
  }
  async recordPromotion(actor: ForgeActor, promotion: { id: string; commitSha: string; from: string; to: string; state: string; evidenceIds: string[]; missingGateIds: string[]; approvalId: string | null; rollbackOf: string | null; workspaceId: string; createdAt: string }) {
    if (promotion.workspaceId !== actor.workspaceId) throw new Error('FORGE_PROMOTION_WORKSPACE_MISMATCH');
    await this.store.query(this.scope(actor), 'INSERT INTO forge_promotions(id,tenant_id,workspace_id,commit_sha,from_environment,to_environment,state,evidence_ids,missing_gate_ids,approval_id,rollback_of,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)', [promotion.id, actor.tenantId, actor.workspaceId, promotion.commitSha, promotion.from, promotion.to, promotion.state, json(promotion.evidenceIds), json(promotion.missingGateIds), promotion.approvalId, promotion.rollbackOf, actor.id]);
    return promotion;
  }
  private async nodesForProject(actor: ForgeActor, projectId: string) {
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,evidence_ids,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY created_at', [actor.tenantId, actor.workspaceId, projectId]);
    return rows.map((row) => HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, evidenceIds: row.evidence_ids, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
  }
  async decideApproval(actor: ForgeActor, raw: { approvalId: string; decision: 'approved' | 'rejected'; reason: string }) {
    const existing = await this.store.query<Record<string, unknown> & { id: string; epic_id: string; workspace_id: string; scope_hash: string; expires_at: string; created_at: string; decision: string | null; decided_by: string | null }>(this.scope(actor), 'SELECT a.id,a.epic_id,a.workspace_id,a.scope_hash,a.expires_at,a.created_at,d.decision,d.decided_by FROM forge_approvals a LEFT JOIN forge_approval_decisions d ON d.approval_id=a.id AND d.tenant_id=a.tenant_id AND d.workspace_id=a.workspace_id WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.id=$3', [actor.tenantId, actor.workspaceId, raw.approvalId]);
    const current = existing.rows[0]; if (!current) throw new Error('FORGE_APPROVAL_NOT_FOUND');
    if (current.decision) throw new Error('FORGE_APPROVAL_ALREADY_DECIDED');
    if (Date.parse(timestamp(current.expires_at)) <= Date.now()) throw new Error('FORGE_APPROVAL_EXPIRED');
    const epic = await this.store.query<Record<string, unknown> & { id: string; project_id: string; title: string; state: string; requirements: unknown; acceptance_criteria: unknown }>(this.scope(actor), 'SELECT id,project_id,title,state,requirement_refs AS requirements,acceptance_criteria FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND kind=\'epic\'', [actor.tenantId, actor.workspaceId, current.epic_id]);
    const epicRow = epic.rows[0]; if (!epicRow) throw new Error('FORGE_APPROVAL_EPIC_NOT_FOUND');
    const currentHash = createHash('sha256').update(JSON.stringify({ workspaceId: actor.workspaceId, epicId: epicRow.id, projectId: epicRow.project_id, title: epicRow.title, state: epicRow.state, requirements: epicRow.requirements, acceptanceCriteria: epicRow.acceptance_criteria })).digest('hex');
    if (currentHash !== current.scope_hash) throw new Error('FORGE_APPROVAL_SCOPE_CHANGED');
    const nextState = raw.decision === 'approved' ? 'approved' : 'draft';
    transitionEpic(epicRow.state, nextState);
    await this.store.query(this.scope(actor), 'INSERT INTO forge_approval_decisions(id,tenant_id,workspace_id,approval_id,decision,reason,decided_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [uuidv7(), actor.tenantId, actor.workspaceId, raw.approvalId, raw.decision, raw.reason, actor.id]);
    await this.store.query(this.scope(actor), 'UPDATE forge_nodes SET state=$4,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, current.epic_id, nextState]);
    return ApprovalRecord.parse({ id: current.id, epicId: current.epic_id, workspaceId: current.workspace_id, scopeHash: current.scope_hash, status: raw.decision, approvedBy: raw.decision === 'approved' ? actor.id : null, createdAt: timestamp(current.created_at), expiresAt: timestamp(current.expires_at) });
  }
}
