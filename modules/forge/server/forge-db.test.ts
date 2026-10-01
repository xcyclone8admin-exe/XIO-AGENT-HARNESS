import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@xyra/core';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { ForgeRepository } from './repository';
import { registerForge, type ForgeCall } from './index';
import { compileSpecCorpus } from './compiler';
import type { AnyCapability } from '@xyra/contracts';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actor = '019a0000-0000-7000-8000-000000000021';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };
let db: Db;
let scoped: LocalScopedStore;
let forge: ForgeRepository;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('forge', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  scoped = new LocalScopedStore(db);
  forge = new ForgeRepository(scoped);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('Forge schema and workspace isolation', () => {
  it('creates every declared Forge table and the RLS-protected project rows', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
    await scoped.query(scopeA, "INSERT INTO forge_projects(id,tenant_id,workspace_id,name,created_by) VALUES ('019a0000-0000-7000-8000-000000000031',$1,$2,'A Project',$3)", [tenantA, workspaceA, actor]);
    expect((await scoped.query(scopeB, 'SELECT id FROM forge_projects')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT id FROM forge_projects')).rows).toHaveLength(1);
  });

  it('anchors related rows to a matching workspace and keeps evidence immutable', async () => {
    const projectId = '019a0000-0000-7000-8000-000000000031';
    const ticketId = '019a0000-0000-7000-8000-000000000051';
    await scoped.query(scopeA, "INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,kind,title,state,created_by) VALUES ($1,$2,$3,$4,'ticket','A Ticket','ready',$5)", [ticketId, tenantA, workspaceA, projectId, actor]);
    await expect(scoped.query(scopeA, "INSERT INTO forge_evidence(id,tenant_id,workspace_id,requirement_id,kind,source,sha256,deterministic,result,verified_at,created_by) VALUES ('019a0000-0000-7000-8000-000000000061',$1,$2,'REQ','test','vitest',$3,true,'pass',now(),$4)", [tenantA, workspaceA, 'a'.repeat(64), actor])).resolves.toBeDefined();
    await expect(scoped.query(scopeA, "UPDATE forge_evidence SET result='fail' WHERE requirement_id='REQ'")).rejects.toThrow();
    await expect(scoped.query(scopeA, "DELETE FROM forge_evidence WHERE requirement_id='REQ'")).rejects.toThrow();
    await expect(scoped.query(scopeB, "INSERT INTO forge_nodes(id,tenant_id,workspace_id,project_id,kind,title,state,created_by) VALUES ('019a0000-0000-7000-8000-000000000071',$1,$2,$3,'ticket','Cross scope','ready',$4)", [tenantA, workspaceB, projectId, actor])).rejects.toThrow();
  });

  it('persists hierarchy, approval decisions and source provenance only inside the caller workspace', async () => {
    const actorA = { id: actor, tenantId: tenantA, workspaceId: workspaceA };
    const project = await forge.createProject(actorA, { name: 'Forge persistence', description: 'test', requirements: [] });
    const epic = await forge.createNode(actorA, project.id, { parentId: null, kind: 'epic', title: 'Bounded epic', description: '', state: 'draft', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    expect((await forge.nodes(actorA, project.id)).map((node) => node.id)).toContain(epic.id);
    expect((await forge.updateNode(actorA, { nodeId: epic.id, title: 'Updated epic' })).title).toBe('Updated epic');
    const detailedEpic = await forge.updateNode(actorA, { nodeId: epic.id, description: 'Scope and outcome', requirements: [{ id: 'FRG-CRUD', statement: 'Edit planning details' }], acceptanceCriteria: ['Reviewable result'], dependencies: [] });
    expect(detailedEpic).toMatchObject({ description: 'Scope and outcome', requirements: [{ id: 'FRG-CRUD', statement: 'Edit planning details' }], acceptanceCriteria: ['Reviewable result'], dependencies: [] });
    await expect(forge.requestApproval(actorA, { epicId: epic.id })).rejects.toThrow('FORGE_EPIC_MUST_BE_PROPOSED');
    await forge.updateNode(actorA, { nodeId: epic.id, state: 'proposed' });
    const request = await forge.requestApproval(actorA, { epicId: epic.id });
    expect(request.status).toBe('pending');
    const approvedRequest = await forge.decideApproval(actorA, { approvalId: request.id, decision: 'approved', reason: 'Scope reviewed' });
    expect(approvedRequest.status).toBe('approved');
    expect((await forge.approvals(actorA)).find((item) => item.id === request.id)?.status).toBe('approved');
    expect((await forge.approvedPlanData(actorA, request.id)).tickets.map((node) => node.id)).toContain(epic.id);
    await expect(forge.approvedPlanData(actorA, '019a0000-0000-7000-8000-000000000099')).rejects.toThrow('FORGE_APPROVED_DURABLE_APPROVAL_REQUIRED');
    const source = await forge.createSource(actorA, { label: 'Requirements', locator: 'project/requirements.md', sha256: 'b'.repeat(64) });
    expect(source).toMatchObject({ authority: 'user', status: 'draft' });
    expect((await forge.sources(actorA)).map((item) => item.id)).toContain(source.id);
    const ingested = await forge.ingestSource(actorA, { label: 'Local pasted source', locator: 'notes/local.md', content: 'approved local source contents' });
    expect(ingested.sha256).toMatch(/^[0-9a-f]{64}$/);
    const storedSource = await scoped.query<Record<string, unknown> & { content: string }>(scopeA, 'SELECT content FROM forge_sources WHERE id=$1', [ingested.id]);
    expect(storedSource.rows[0]?.content).toBe('approved local source contents');
    const corpus = compileSpecCorpus({ title: 'Release plan', requirements: [{ id: 'REQ-1', statement: 'Preserve approved intent' }] });
    const firstSpecs = await forge.saveSpecs(actorA, project.id, corpus.documents);
    const secondSpecs = await forge.saveSpecs(actorA, project.id, corpus.documents);
    expect(firstSpecs).toHaveLength(12);
    expect(secondSpecs.every((spec) => spec.version === 2)).toBe(true);
    await expect(forge.transitionSpec(actorA, { projectId: project.id, specId: firstSpecs[0]!.id, version: 1, approvalId: '019a0000-0000-7000-8000-000000000099', action: 'approve', detail: 'No approved project approval' })).rejects.toThrow('FORGE_SPEC_APPROVED_PROJECT_SCOPE_REQUIRED');
    await forge.transitionSpec(actorA, { projectId: project.id, specId: firstSpecs[0]!.id, version: 2, approvalId: approvedRequest.id, action: 'approve', detail: 'Reviewed against approved epic scope' });
    await forge.transitionSpec(actorA, { projectId: project.id, specId: firstSpecs[0]!.id, version: 1, approvalId: approvedRequest.id, action: 'approve', detail: 'Approved predecessor for lifecycle test' });
    await forge.transitionSpec(actorA, { projectId: project.id, specId: firstSpecs[0]!.id, version: 1, approvalId: approvedRequest.id, action: 'supersede', supersededBySpecId: firstSpecs[0]!.id, supersededByVersion: 2, detail: 'Replaced by approved version 2' });
    const lifecycleSpecs = await forge.specs(actorA, project.id);
    expect(lifecycleSpecs.find((spec) => spec.id === firstSpecs[0]!.id && spec.version === 1)?.status).toBe('superseded');
    expect(lifecycleSpecs.find((spec) => spec.id === firstSpecs[0]!.id && spec.version === 2)?.status).toBe('approved');
    await expect(scoped.query(scopeA, "UPDATE forge_spec_events SET detail='rewrite' WHERE spec_id=$1", [firstSpecs[0]!.id])).rejects.toThrow();
    expect((await forge.specs(actorA, project.id)).filter((spec) => spec.template === 'release-plan')).toHaveLength(2);
    expect(await forge.projects({ id: actor, tenantId: tenantB, workspaceId: workspaceB })).toEqual([]);
    await expect(scoped.query(scopeA, "UPDATE forge_sources SET status='rejected' WHERE id=$1", [source.id])).rejects.toThrow();
    const task = await forge.createNode(actorA, project.id, { parentId: epic.id, kind: 'ticket', title: 'First work', description: '', state: 'ready', priority: 'normal', dependencies: [], requirements: [{ id: 'XIO-REQ-FRG-008', statement: 'evidence gate' }], acceptanceCriteria: ['pass'], ownerId: null });
    const dependent = await forge.createNode(actorA, project.id, { parentId: epic.id, kind: 'ticket', title: 'Dependent work', description: '', state: 'ready', priority: 'normal', dependencies: [task.id], requirements: [], acceptanceCriteria: ['wait'], ownerId: null });
    const planNode = await forge.createNode(actorA, project.id, { parentId: epic.id, kind: 'plan', title: 'Plan', description: '', state: 'draft', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    const waveNode = await forge.createNode(actorA, project.id, { parentId: planNode.id, kind: 'wave', title: 'Wave', description: '', state: 'draft', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    expect((await forge.updateNode(actorA, { nodeId: task.id, parentId: waveNode.id })).parentId).toBe(waveNode.id);
    await expect(forge.updateNode(actorA, { nodeId: task.id, parentId: dependent.id })).rejects.toThrow('FORGE_NODE_PARENT_KIND_INVALID');
    const evidenceRecord = await forge.createEvidence(actorA, { requirementId: 'XIO-REQ-FRG-008', kind: 'test', source: 'vitest fixture', deterministic: true, result: 'pass', payload: { test: 'green' }, ticketId: task.id });
    expect((await forge.nodes(actorA, project.id)).find((node) => node.id === task.id)?.evidenceIds).toContain(evidenceRecord.id);
    const context = await forge.compileTicketContext(actorA, { ticketId: task.id, budgetTokens: 8000, sourceIds: [ingested.id] });
    expect(context.items.map((item) => item.type)).toEqual(expect.arrayContaining(['objective','requirement','architecture','decision','dependency','source','constraint','acceptance','prior-evidence']));
    expect(context.items.find((item) => item.type === 'source')?.text).toContain('approved local source contents');
    expect(context.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const riskRequest = await forge.requestRiskAcceptance(actorA, { gateId: 'req:XIO-REQ-FRG-008', requirementId: 'XIO-REQ-FRG-008', reason: 'Temporary accepted residual risk', impact: 'Limited rollback window', mitigation: 'Review after follow-up tests', reviewAt: new Date(Date.now() + 86_400_000).toISOString() });
    await expect(forge.decideRiskAcceptance(actorA, { acceptanceId: riskRequest.id, decision: 'approved', reason: 'Self approval' })).rejects.toThrow('FORGE_RISK_ACCEPTANCE_REQUIRES_INDEPENDENT_APPROVER');
    const secondActor = { id: '019a0000-0000-7000-8000-000000000023', tenantId: tenantA, workspaceId: workspaceA };
    expect((await forge.decideRiskAcceptance(secondActor, { acceptanceId: riskRequest.id, decision: 'approved', reason: 'Reviewed mitigation and follow-up' }))?.status).toBe('approved');
    await expect(forge.decideRiskAcceptance(secondActor, { acceptanceId: riskRequest.id, decision: 'rejected', reason: 'Conflicting second decision' })).rejects.toThrow('FORGE_RISK_ACCEPTANCE_ALREADY_DECIDED');
    expect((await forge.gateMatrix(actorA, { requirements: [{ requirementId: 'XIO-REQ-FRG-008', risk: 'critical', evidenceIds: [evidenceRecord.id] }] })).overall).toBe('pass');
    const proposal = await forge.requestPromotionRecord(actorA, { commitSha: 'c'.repeat(40), from: 'develop', to: 'staging', evidenceIds: [evidenceRecord.id], requirements: [{ requirementId: 'XIO-REQ-FRG-008', risk: 'critical', evidenceIds: [evidenceRecord.id] }] });
    expect(proposal).toMatchObject({ state: 'proposed', evidenceIds: [evidenceRecord.id], missingGateIds: [] });
    expect((await forge.promotions(actorA)).map((item) => item.id)).toContain(proposal.id);
    await expect(forge.requestPromotionRecord(actorA, { commitSha: 'd'.repeat(40), from: 'develop', to: 'staging', evidenceIds: ['019a0000-0000-7000-8000-000000000099'], requirements: [] })).rejects.toThrow('FORGE_PROMOTION_EVIDENCE_NOT_FOUND');
    const mainProposal = await forge.requestPromotionRecord(actorA, { commitSha: 'e'.repeat(40), from: 'staging', to: 'main', evidenceIds: [evidenceRecord.id], requirements: [{ requirementId: 'XIO-REQ-FRG-008', risk: 'low', evidenceIds: [evidenceRecord.id] }], approvalId: '019a0000-0000-7000-8000-000000000099' });
    expect(mainProposal.approvalId).toBeNull();
    const mainRequest = await forge.requestPromotionApproval(actorA, { promotionId: mainProposal.id });
    if (!mainRequest) throw new Error('main promotion approval request missing');
    await expect(forge.decidePromotionApproval(actorA, { requestId: mainRequest.id, decision: 'approved', reason: 'Self approve attempt' })).rejects.toThrow('FORGE_PROMOTION_APPROVAL_REQUIRES_INDEPENDENT_APPROVER');
    await expect(forge.requestPromotionApproval(actorA, { promotionId: mainProposal.id })).rejects.toThrow('FORGE_PROMOTION_APPROVAL_ALREADY_REQUESTED');
    const approvedMainRequest = await forge.decidePromotionApproval(secondActor, { requestId: mainRequest.id, decision: 'approved', reason: 'Reviewed exact commit evidence and scope' });
    expect(approvedMainRequest).toMatchObject({ status: 'approved', commitSha: 'e'.repeat(40), to: 'main' });
    const finding = await forge.createFindingRecord(actorA, { role: 'security', state: 'open', severity: 'medium', title: 'Review finding', evidenceIds: [evidenceRecord.id], affectedRequirements: ['XIO-REQ-FRG-007'], confidence: 0.8, reproduction: 'Repro in fixture', remediation: 'Address issue', revalidation: 'Rerun suite' });
    expect((await forge.transitionFindingRecord(actorA, { findingId: finding.id, state: 'triaged', detail: 'Assigned' })).state).toBe('triaged');
    const council = await forge.startCouncil(actorA, { projectId: project.id, targetId: epic.id, targetKind: 'epic' });
    expect(council?.assignments).toHaveLength(9);
    expect(council?.status).toBe('open');
    const firstRole = council?.assignments[0]?.role;
    if (!council || !firstRole) throw new Error('test council assignment missing');
    await expect(forge.submitCouncilDecision(actorA, { councilId: council.id, role: firstRole, decision: 'findings', findingId: finding.id, evidenceIds: [evidenceRecord.id] })).rejects.toThrow('FORGE_COUNCIL_REVIEWER_ASSIGNMENT_REQUIRED');
    await forge.assignCouncilReviewer(actorA, { councilId: council.id, role: firstRole, reviewerId: secondActor.id });
    await expect(forge.assignCouncilReviewer(actorA, { councilId: council.id, role: council.assignments[1]!.role, reviewerId: secondActor.id })).rejects.toThrow('FORGE_COUNCIL_REVIEWER_MUST_BE_DISTINCT_PER_ROLE');
    await expect(forge.submitCouncilDecision(actorA, { councilId: council.id, role: firstRole, decision: 'findings', findingId: finding.id, evidenceIds: [evidenceRecord.id] })).rejects.toThrow('FORGE_COUNCIL_REVIEWER_IDENTITY_MISMATCH');
    const partialCouncil = await forge.submitCouncilDecision(secondActor, { councilId: council.id, role: firstRole, decision: 'findings', findingId: finding.id, evidenceIds: [evidenceRecord.id] });
    expect(partialCouncil.status).toBe('in-review');
    expect(partialCouncil.assignments.find((item) => item.role === firstRole)).toMatchObject({ status: 'submitted', reviewerId: secondActor.id, evidenceSource: 'user-submitted', submittedBy: secondActor.id });
    let reviewerSequence = 24;
    for (const assignment of partialCouncil.assignments.filter((item) => item.status === 'pending')) {
      const reviewerId = `019a0000-0000-7000-8000-${String(reviewerSequence++).padStart(12, '0')}`;
      await forge.assignCouncilReviewer(actorA, { councilId: council.id, role: assignment.role, reviewerId });
      await forge.submitCouncilDecision({ id: reviewerId, tenantId: tenantA, workspaceId: workspaceA }, { councilId: council.id, role: assignment.role, decision: 'no-findings', findingId: null, evidenceIds: [] });
    }
    expect((await forge.councils(actorA)).find((item) => item.id === council.id)?.status).toBe('complete');
    expect(await forge.councils({ id: actor, tenantId: tenantB, workspaceId: workspaceB })).toEqual([]);
    const plannerInput = { epicId: epic.id, approval: approvedRequest, config: { maxConcurrency: 1, maxBudgetUsd: 10, resourceLocks: ['workspace:forge-test-lock'], substrateVerified: false, externalAdaptersEnabled: false }, tickets: await forge.nodes(actorA, project.id), spentUsd: 0, killSwitchEngaged: false };
    const handlers = new Map<string, (input: unknown, call: ForgeCall) => Promise<unknown>>();
    registerForge({ register: (_manifest, descriptor: AnyCapability, handler) => { handlers.set(descriptor.id, handler); } }, manifest, forge);
    const capabilityCall: ForgeCall = { principal: { id: actor, tenantId: tenantA }, workspaceId: workspaceA };
    const plan = await handlers.get('forge.schedule.plan')?.({ epicId: epic.id, approvalId: approvedRequest.id, config: plannerInput.config, spentUsd: 0 }, capabilityCall) as { id: string; state: string; runnableTicketIds: string[]; blockedTicketIds: string[] };
    expect(plan.runnableTicketIds).toContain(task.id);
    expect(plan.blockedTicketIds).toEqual([dependent.id]);
    const schedule = (await forge.schedules(actorA)).find((item) => item.id === plan.id);
    expect(schedule).toBeDefined();
    if (!schedule) throw new Error('test schedule missing');
    expect(schedule.state).toBe('queued');
    expect((await scoped.query(scopeA, "SELECT resource_key FROM forge_resource_lock_leases WHERE status='active'")).rows).toEqual([{ resource_key: 'workspace:forge-test-lock' }]);
    const raced = await forge.persistSchedule(actorA, { epicId: epic.id, approval: approvedRequest, config: plannerInput.config, spentUsd: 0 }, { runId: uuidv7(), state: 'queued', runnableTicketIds: [dependent.id], blockedTicketIds: [], reason: null });
    expect(raced).toMatchObject({ state: 'blocked', runnableTicketIds: [], blockedTicketIds: [dependent.id], reason: 'RESOURCE_LOCK_CONFLICT' });
    const duplicatePlan = await handlers.get('forge.schedule.plan')?.({ epicId: epic.id, approvalId: approvedRequest.id, config: plannerInput.config, spentUsd: 0 }, capabilityCall) as { state: string; runnableTicketIds: string[]; reason: string | null };
    expect(duplicatePlan).toMatchObject({ state: 'blocked', runnableTicketIds: [], reason: 'RESOURCE_LOCK_CONFLICT' });
    expect((await forge.cancelSchedule(actorA, schedule.id, 'User canceled')).state).toBe('canceled');
    expect((await scoped.query(scopeA, "SELECT id FROM forge_resource_lock_leases WHERE status='active'")).rows).toEqual([]);
    expect((await forge.runs(actorA)).some((event) => event.ticketId === task.id && event.state === 'canceled' && event.externalExecution === false)).toBe(true);
    const escalation = await forge.recordDiscovery(actorA, { ticketId: task.id, summary: 'Contract change affects this work', evidenceIds: [evidenceRecord.id], affectedTicketIds: [] });
    expect(escalation.discovery.classification).toBe('material');
    expect(escalation.blockedTicketIds).toEqual(expect.arrayContaining([task.id, dependent.id]));
    expect((await forge.nodes(actorA, project.id)).filter((node) => [task.id, dependent.id].includes(node.id)).every((node) => node.state === 'blocked')).toBe(true);
    expect((await forge.escalations(actorA)).find((item) => item.id === escalation.discovery.id)?.status).toBe('open');
    expect((await forge.resolveEscalation(actorA, { escalationId: escalation.discovery.id, status: 'resolved', detail: 'Owner reviewed impact' }))?.status).toBe('resolved');
    await expect(forge.resolveEscalation(actorA, { escalationId: escalation.discovery.id, status: 'resolved', detail: 'Duplicate resolution' })).rejects.toThrow('FORGE_ESCALATION_ALREADY_RESOLVED');
    const archiveProject = await forge.createProject(actorA, { name: 'Archive lifecycle', requirements: [] });
    const archiveEpic = await forge.createNode(actorA, archiveProject.id, { parentId: null, kind: 'epic', title: 'Archived parent', description: '', state: 'draft', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    const archiveTicket = await forge.createNode(actorA, archiveProject.id, { parentId: archiveEpic.id, kind: 'ticket', title: 'Archived child', description: '', state: 'ready', priority: 'normal', dependencies: [], requirements: [], acceptanceCriteria: [], ownerId: null });
    await expect(forge.archiveNode(actorA, { nodeId: archiveEpic.id, reason: 'Parent still has active child' })).rejects.toThrow('FORGE_NODE_HAS_ACTIVE_DESCENDANTS');
    const archivedTicket = await forge.archiveNode(actorA, { nodeId: archiveTicket.id, reason: 'No longer required' });
    expect(archivedTicket.archivedAt).toBeTruthy();
    await expect(forge.updateNode(actorA, { nodeId: archiveTicket.id, title: 'Should remain archived' })).rejects.toThrow('FORGE_NODE_ARCHIVED');
    const archivedEpic = await forge.archiveNode(actorA, { nodeId: archiveEpic.id, reason: 'All descendants archived' });
    expect((await forge.nodes(actorA, archiveProject.id)).filter((node) => node.archivedAt)).toHaveLength(2);
    expect(archivedEpic.archivedAt).toBeTruthy();
  });

  it('derives tenant and workspace from trusted capability call context', async () => {
    const handlers = new Map<string, (input: unknown, call: ForgeCall) => Promise<unknown>>();
    registerForge({ register: (_manifest, descriptor: AnyCapability, handler) => { handlers.set(descriptor.id, handler); } }, manifest, forge);
    const callA: ForgeCall = { principal: { id: actor, tenantId: tenantA }, workspaceId: workspaceA };
    await expect(Promise.resolve().then(() => handlers.get('forge.projects.list')?.({} as unknown, undefined as unknown as ForgeCall))).rejects.toThrow('FORGE_TRUSTED_CALL_CONTEXT_REQUIRED');
    const created = await handlers.get('forge.projects.create')?.({ name: 'Capability scoped', description: '', requirements: [] }, callA) as { workspaceId: string };
    expect(created.workspaceId).toBe(workspaceA);
    const callB: ForgeCall = { principal: { id: '019a0000-0000-7000-8000-000000000022', tenantId: tenantB }, workspaceId: workspaceB };
    const visible = await handlers.get('forge.projects.list')?.({}, callB);
    expect(visible).toEqual([]);
  });
});
