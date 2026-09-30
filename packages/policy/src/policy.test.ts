import { describe, expect, it } from 'vitest';
import { defineModule, Principal } from '@xyra/contracts';
import { decidePolicy } from './index';

const TENANT = '019a0000-0000-7000-8000-000000000001';
const WORKSPACE = '019a0000-0000-7000-8000-000000000011';
const USER = '019a0000-0000-7000-8000-000000000021';
const manifest = defineModule({
  id: 'ops',
  version: '1.0.0',
  pillar: 'COMMAND',
  title: 'Operations',
  description: 'x',
  icon: 'list',
  permissions: ['ops:task:read', 'ops:task:write', 'ops:task:publish'],
  roleGrants: { member: ['ops:task:read', 'ops:task:write'] },
});
const principal = Principal.parse({
  kind: 'user',
  id: USER,
  tenantId: TENANT,
  workspaces: [{ id: WORKSPACE, role: 'member', kind: 'standard' }],
});
const base = {
  principal,
  workspaceId: WORKSPACE,
  manifest,
  permission: 'ops:task:read',
  kind: 'read' as const,
  risk: 'low' as const,
};

describe('deny-first policy', () => {
  it('requires membership and a declared role grant', () => {
    expect(decidePolicy(base)).toEqual({ status: 'allow' });
    expect(decidePolicy({ ...base, workspaceId: TENANT })).toMatchObject({
      status: 'deny',
      reason: 'WORKSPACE_NOT_GRANTED',
    });
    expect(decidePolicy({ ...base, permission: 'ops:task:publish' })).toMatchObject({
      status: 'deny',
      reason: 'PERMISSION_DENIED',
    });
  });
  it('requires a verified approval for consequential actions', () => {
    const owner = Principal.parse({
      ...principal,
      workspaces: [{ id: WORKSPACE, role: 'owner', kind: 'standard' }],
    });
    const request = {
      ...base,
      principal: owner,
      permission: 'ops:task:publish',
      kind: 'consequential' as const,
      risk: 'high' as const,
    };
    expect(decidePolicy(request)).toMatchObject({ status: 'approval_required' });
    expect(decidePolicy({ ...request, approvalVerified: true })).toEqual({ status: 'allow' });
    expect(decidePolicy({ ...request, killSwitchEngaged: true })).toMatchObject({
      status: 'deny',
      reason: 'KILL_SWITCH_ENGAGED',
    });
  });
  it('intersects agent grants with delegator grants and autonomy', () => {
    const agent = Principal.parse({
      ...principal,
      kind: 'agent',
      delegatedBy: USER,
      grants: ['ops:task:write'],
      autonomy: 1,
    });
    const request = {
      ...base,
      principal: agent,
      permission: 'ops:task:write',
      kind: 'write' as const,
      risk: 'medium' as const,
      delegatorPermissions: new Set(['ops:task:write']),
    };
    expect(decidePolicy(request)).toMatchObject({ status: 'deny', reason: 'AUTONOMY_CEILING' });
    expect(decidePolicy({ ...request, principal: { ...agent, autonomy: 2 } })).toEqual({ status: 'allow' });
    expect(decidePolicy({ ...request, delegatorPermissions: new Set() })).toMatchObject({
      status: 'deny',
      reason: 'DELEGATION_SCOPE',
    });
  });
  it('blocks consequential sample actions and keeps sample-only helpers scoped', () => {
    const sample = Principal.parse({
      ...principal,
      workspaces: [{ id: WORKSPACE, role: 'owner', kind: 'sample' }],
    });
    expect(decidePolicy({ ...base, principal: sample, kind: 'consequential' })).toMatchObject({
      status: 'deny',
      reason: 'SAMPLE_OUTBOUND_DISABLED',
    });
    expect(decidePolicy({ ...base, sampleOnly: true })).toMatchObject({
      status: 'deny',
      reason: 'SAMPLE_ONLY',
    });
  });
});
