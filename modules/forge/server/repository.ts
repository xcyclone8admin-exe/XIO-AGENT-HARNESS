import { uuidv7 } from '@xyra/core';
import { createHash } from 'node:crypto';
import type { LocalScopedStore, Scope } from '@xyra/db';
import { ApprovalRecord, EpicState, ForgeNodeCreate, ForgeNodeUpdate, ForgeProjectCreate, ForgeProjectUpdate, HierarchyNode, SourceRecordCreate, TicketState } from '../contracts';
import { transitionEpic } from './state-machine';

export interface ForgeActor { readonly id: string; readonly tenantId: string; readonly workspaceId: string }
type ProjectRow = Record<string, unknown> & { id: string; workspace_id: string; name: string; description: string; status: string; requirements: unknown; created_at: string; updated_at: string };
type NodeRow = Record<string, unknown> & { id: string; tenant_id: string; workspace_id: string; project_id: string; parent_id: string | null; kind: string; title: string; description: string; state: string; priority: string; dependencies: unknown; requirement_refs: unknown; acceptance_criteria: unknown; owner_id: string | null; created_by: string; created_at: string; updated_at: string };
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
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY created_at', [actor.tenantId, actor.workspaceId, projectId]);
    return rows.map((row) => HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
  }
  async createNode(actor: ForgeActor, projectId: string, raw: unknown) {
    const node = ForgeNodeCreate.parse(raw); const id = uuidv7();
    if (node.kind === 'epic' || node.kind === 'spec' || node.kind === 'plan' || node.kind === 'wave') EpicState.parse(node.state);
    else TicketState.parse(node.state);
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15) RETURNING id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by,created_at,updated_at', [id, actor.tenantId, actor.workspaceId, projectId, node.parentId, node.kind, node.title, node.description, node.state, node.priority, json(node.dependencies), json(node.requirements), json(node.acceptanceCriteria), node.ownerId, actor.id]);
    const row = rows[0]; if (!row) throw new Error('FORGE_NODE_CREATE_FAILED');
    return HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }
  async updateNode(actor: ForgeActor, raw: unknown) {
    const { nodeId, ...input } = ForgeNodeUpdate.parse(raw);
    const current = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3', [actor.tenantId, actor.workspaceId, nodeId]);
    const old = current.rows[0]; if (!old) throw new Error('FORGE_NODE_NOT_FOUND');
    if (input.state && input.state !== old.state) {
      if (old.kind === 'epic' || old.kind === 'spec' || old.kind === 'plan' || old.kind === 'wave') transitionEpic(old.state, input.state);
      else if (old.kind === 'ticket' || old.kind === 'subtask') {
        const { transitionTicket } = await import('./state-machine'); transitionTicket(old.state, input.state);
      } else throw new Error('FORGE_NODE_STATE_TRANSITION_UNSUPPORTED');
    }
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'UPDATE forge_nodes SET title=COALESCE($4,title),description=COALESCE($5,description),state=COALESCE($6,state),priority=COALESCE($7,priority),dependencies=COALESCE($8::jsonb,dependencies),requirement_refs=COALESCE($9::jsonb,requirement_refs),acceptance_criteria=COALESCE($10::jsonb,acceptance_criteria),owner_id=CASE WHEN $12 THEN $11 ELSE owner_id END,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by,created_at,updated_at', [actor.tenantId, actor.workspaceId, nodeId, input.title ?? null, input.description ?? null, input.state ?? null, input.priority ?? null, input.dependencies === undefined ? null : json(input.dependencies), input.requirements === undefined ? null : json(input.requirements), input.acceptanceCriteria === undefined ? null : json(input.acceptanceCriteria), input.ownerId ?? null, input.ownerId !== undefined]);
    const row = rows[0]; if (!row) throw new Error('FORGE_NODE_NOT_FOUND');
    return HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
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
  private async nodesForProject(actor: ForgeActor, projectId: string) {
    const { rows } = await this.store.query<NodeRow>(this.scope(actor), 'SELECT id,tenant_id,workspace_id,project_id,parent_id,kind,title,description,state,priority,dependencies,requirement_refs,acceptance_criteria,owner_id,created_by,created_at,updated_at FROM forge_nodes WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY created_at', [actor.tenantId, actor.workspaceId, projectId]);
    return rows.map((row) => HierarchyNode.parse({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, projectId: row.project_id, parentId: row.parent_id, kind: row.kind, title: row.title, description: row.description, state: row.state, priority: row.priority, dependencies: row.dependencies, requirements: row.requirement_refs, acceptanceCriteria: row.acceptance_criteria, ownerId: row.owner_id, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
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
