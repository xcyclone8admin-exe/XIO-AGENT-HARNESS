import { describe, expect, it } from 'vitest';
import { AdapterConfig, ContextCandidate, type ContextElementType, REVIEW_ROLES, SPEC_TEMPLATES } from '../contracts';
import { compileContext, compileSpecCorpus } from '../server/compiler';
import { authorizeChaosTarget, classifyDiscovery, createEvidence, evaluateGates, planSchedule, requestPromotion, rollbackPromotion } from '../server/engine';
import { renderAllGoldenBriefs } from '../server/specs';
import { transitionEpic, transitionFinding, transitionPromotion, transitionTicket } from '../server/state-machine';

const tenantId = '019a0000-0000-7000-8000-000000000001';
const workspaceId = '019a0000-0000-7000-8000-000000000011';
const userId = '019a0000-0000-7000-8000-000000000021';
const projectId = '019a0000-0000-7000-8000-000000000031';
const epicId = '019a0000-0000-7000-8000-000000000041';
const ticketId = '019a0000-0000-7000-8000-000000000051';
const evidenceId = '019a0000-0000-7000-8000-000000000061';
const approvalId = '019a0000-0000-7000-8000-000000000071';
const time = new Date(Date.now() - 1000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();
const ticket = {
  id: ticketId, tenantId, workspaceId, projectId, parentId: epicId, kind: 'ticket', title: 'Test Forge', description: '',
  state: 'ready', priority: 'normal', dependencies: [], requirements: [{ id: 'XIO-REQ-FRG-008', statement: 'evidence' }],
  acceptanceCriteria: ['deterministic'], ownerId: null, createdBy: userId, createdAt: time, updatedAt: time,
};
const approval = { id: approvalId, epicId, workspaceId, scopeHash: 'a'.repeat(64), status: 'approved', approvedBy: userId, createdAt: time, expiresAt: future };
const goodGate = { id: 'unit-tests', requirementId: 'XIO-REQ-FRG-008', kind: 'deterministic', evidenceIds: [evidenceId], status: 'pass', hard: true };
const evidence = { id: evidenceId, workspaceId, requirementId: 'XIO-REQ-FRG-008', kind: 'test', source: 'vitest', sha256: 'b'.repeat(64), verifiedAt: time, deterministic: true, result: 'pass' };

describe('FORGE contract and hierarchy states', () => {
  it('rejects illegal transitions and allows declared state progressions', () => {
    expect(transitionEpic('draft', 'proposed')).toBe('proposed');
    expect(transitionTicket('running', 'review')).toBe('review');
    expect(transitionFinding('fixed', 'verified')).toBe('verified');
    expect(transitionPromotion('approved', 'promoted')).toBe('promoted');
    expect(() => transitionEpic('draft', 'complete')).toThrow('ILLEGAL_TRANSITION');
    expect(() => transitionTicket('ready', 'done')).toThrow('ILLEGAL_TRANSITION');
    expect(() => transitionFinding('open', 'verified')).toThrow('ILLEGAL_TRANSITION');
    expect(() => transitionPromotion('proposed', 'promoted')).toThrow('ILLEGAL_TRANSITION');
  });

  it('renders twelve stable golden briefs and indexes compiler output', () => {
    const input = { title: 'Context Compiler', objective: 'Build bounded context', requirementIds: ['XIO-REQ-FRG-003', 'XIO-REQ-FRG-001'] };
    const golden = renderAllGoldenBriefs(input);
    expect(Object.keys(golden)).toHaveLength(12);
    expect(Object.keys(golden)).toEqual([...SPEC_TEMPLATES]);
    expect(golden['test-plan']?.frontmatter).toContain('id: spec_test-plan-context-compiler');
    expect(renderAllGoldenBriefs(input)['test-plan']?.sha256).toBe(golden['test-plan']?.sha256);
    const corpus = compileSpecCorpus({ title: input.title, requirements: input.requirementIds.map((id) => ({ id, statement: input.objective })) });
    expect(corpus.documents).toHaveLength(12);
    expect(corpus.byId.get(golden['test-plan']?.id ?? '')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes every context element with provenance and enforces the hard budget', () => {
    const types: ContextElementType[] = ['objective', 'requirement', 'architecture', 'decision', 'dependency', 'source', 'constraint', 'acceptance', 'prior-evidence'];
    const candidates = types.map((type, index) => ContextCandidate.parse({
      id: `context-${type}`, type, text: `Information for ${type}`, source: `project/${type}`, authority: index < 2 ? 'contract' : 'architecture',
      status: 'approved', dependencyIds: [], relevance: 1 - index * 0.01, estimatedTokens: ['objective', 'requirement', 'acceptance'].includes(type) ? 4 : 1,
    }));
    const manifest = compileContext(ticketId, candidates, 18);
    expect(manifest.items.map((item) => item.type).sort()).toEqual([...types].sort());
    expect(manifest.usedTokens).toBeLessThanOrEqual(manifest.budgetTokens);
    expect(manifest.items.every((item) => item.source.length > 0 && item.authority)).toBe(true);
    expect(() => compileContext(ticketId, candidates, 11)).toThrow('MANDATORY_CONTEXT_OVER_BUDGET');
  });
});

describe('approved bounded scheduler (planning only)', () => {
  const config = { maxConcurrency: 1, maxBudgetUsd: 4, resourceLocks: [], substrateVerified: false, externalAdaptersEnabled: false };
  it('requires a live matching approval and obeys dependencies, concurrency and budget', () => {
    const planned = planSchedule({ epicId, approval, config, tickets: [ticket], spentUsd: 0, killSwitchEngaged: false });
    expect(planned.runnableTicketIds).toEqual([ticketId]);
    expect(planned.externalExecution).toBe(false);
    expect(planSchedule({ epicId, approval: { ...approval, status: 'pending' }, config, tickets: [ticket], spentUsd: 0, killSwitchEngaged: false }).reason).toBe('VALID_EPIC_APPROVAL_REQUIRED');
    expect(planSchedule({ epicId, approval, config, tickets: [ticket], spentUsd: 4, killSwitchEngaged: false }).reason).toBe('BUDGET_EXHAUSTED');
    expect(planSchedule({ epicId, approval, config, tickets: [ticket], spentUsd: 0, killSwitchEngaged: true }).state).toBe('stopped');
    expect(() => planSchedule({ epicId, approval, config: { ...config, substrateVerified: true }, tickets: [ticket], spentUsd: 0, killSwitchEngaged: false })).toThrow();
  });
});

describe('review, gates, promotion and hard execution boundary', () => {
  it('material discoveries escalate and all nine structured reviewer roles are present', () => {
    const material = classifyDiscovery(ticket, 'Architecture contract changed', [], [ticketId]);
    expect(material.classification).toBe('critical');
    expect(material.affectedTicketIds).toContain(ticketId);
    expect(REVIEW_ROLES).toHaveLength(9);
  });

  it('requires evidence and refuses unauthorized chaos targets', () => {
    expect(() => evaluateGates([{ ...goodGate, evidenceIds: [] }], [])).toThrow('DETERMINISTIC_GATE_WITHOUT_EVIDENCE');
    expect(evaluateGates([{ ...goodGate, status: 'fail' }], []).overall).toBe('fail');
    expect(() => authorizeChaosTarget({ target: 'production', authorizedTargets: ['production'] })).toThrow('UNSAFE_CHAOS_TARGET');
    expect(authorizeChaosTarget({ target: 'sandbox', authorizedTargets: ['sandbox'] })).toEqual({ target: 'sandbox', executed: false, reason: 'PROCESS_EXECUTION_DISABLED' });
    expect(() => AdapterConfig.parse({ id: 'factory', enabled: true, endpoint: 'local', lastStatus: 'disabled' })).toThrow();
  });

  it('refuses missing gates and production approval and requires rollback evidence', () => {
    const promotion = { id: '019a0000-0000-7000-8000-000000000081', workspaceId, commitSha: 'c'.repeat(40), from: 'develop', to: 'staging', state: 'proposed', evidenceIds: [evidenceId], missingGateIds: [], approvalId: null, rollbackOf: null, createdAt: time };
    expect(() => requestPromotion({ promotion, gates: [{ ...goodGate, status: 'pending' }], productionApproval: null })).toThrow('PROMOTION_GATES_MISSING');
    expect(() => requestPromotion({ promotion: { ...promotion, to: 'main' }, gates: [goodGate], productionApproval: null })).toThrow('PRODUCTION_APPROVAL_REQUIRED');
    const proposed = requestPromotion({ promotion, gates: [goodGate], productionApproval: null });
    expect(proposed.state).toBe('proposed');
    expect(() => rollbackPromotion({ ...promotion, state: 'proposed' }, evidence)).toThrow('ROLLBACK_REQUIRES_PROMOTED_RECORD');
    expect(rollbackPromotion({ ...promotion, state: 'promoted' }, evidence).state).toBe('rolled-back');
    expect(createEvidence({ workspaceId, requirementId: 'XIO-REQ-FRG-008', kind: 'test', source: 'vitest', deterministic: true, result: 'pass', payload: { report: 'verified' } }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
