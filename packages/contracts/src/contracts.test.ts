import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCapability,
  defineModule,
  isHonestStatus,
  permissionCatalog,
  type ConnectorStatus,
} from './index';

describe('defineModule', () => {
  it('parses defaults and enforces permission prefixes and unique nav paths', () => {
    const m = defineModule({
      id: 'ops',
      version: '1.0.0',
      pillar: 'COMMAND',
      title: 'Projects',
      description: 'x',
      icon: 'list-checks',
      permissions: permissionCatalog('ops', { task: ['read', 'write'] }),
      nav: [{ path: '', title: 'Board' }],
    });
    expect(m.permissions).toEqual(['ops:task:read', 'ops:task:write']);
    expect(m.nav[0]?.keywords).toEqual([]);
    const guarded = defineModule({
      id: 'ops',
      version: '1.0.0',
      pillar: 'COMMAND',
      title: 'Projects',
      description: 'x',
      icon: 'list-checks',
      permissions: ['ops:task:read'],
      roleGrants: { viewer: ['ops:task:read'] },
      tables: [{ name: 'ops_tasks', class: 'lww', authority: 'synced', guardedColumns: ['status'] }],
    });
    expect(guarded.tables[0]?.guardedColumns).toEqual(['status']);
    expect(() =>
      defineModule({
        id: 'ops',
        version: '1.0.0',
        pillar: 'COMMAND',
        title: 'Projects',
        description: 'x',
        icon: 'list-checks',
        roleGrants: { viewer: ['ops:task:read'] },
      }),
    ).toThrow(/undeclared/);
    expect(() =>
      defineModule({
        id: 'ops',
        version: '1.0.0',
        pillar: 'COMMAND',
        title: 't',
        description: 'd',
        icon: 'x',
        permissions: ['money:x:read'],
      }),
    ).toThrow(/prefixed/);
    expect(() =>
      defineModule({
        id: 'ops',
        version: '1.0.0',
        pillar: 'COMMAND',
        title: 't',
        description: 'd',
        icon: 'x',
        nav: [
          { path: 'a', title: 'A' },
          { path: 'a', title: 'B' },
        ],
      }),
    ).toThrow(/duplicate/);
  });
});

describe('defineCapability', () => {
  it('derives module, risk, idempotency and agent-callability from kind', () => {
    const read = defineCapability({
      id: 'ops.task.list',
      title: 't',
      description: 'd',
      kind: 'read',
      permission: 'ops:task:read',
      input: z.object({}),
      output: z.array(z.string()),
    });
    expect(read).toMatchObject({ module: 'ops', risk: 'low', idempotent: false, agentCallable: true });
    const write = defineCapability({
      id: 'ops.task.create',
      title: 't',
      description: 'd',
      kind: 'consequential',
      permission: 'ops:task:write',
      input: z.object({}),
      output: z.object({}),
    });
    expect(write).toMatchObject({ risk: 'high', idempotent: true, agentCallable: false });
  });
  it('rejects malformed ids and cross-module permissions', () => {
    const base = {
      title: 't',
      description: 'd',
      kind: 'read' as const,
      input: z.object({}),
      output: z.object({}),
    };
    expect(() => defineCapability({ ...base, id: 'Ops.task', permission: 'ops:task:read' })).toThrow();
    expect(() => defineCapability({ ...base, id: 'ops.task.list', permission: 'money:task:read' })).toThrow(
      /permission/,
    );
  });
});

describe('honest connector status', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const s = (over: Partial<ConnectorStatus>): ConnectorStatus => ({
    id: 'slack',
    name: 'Slack',
    family: 'comms',
    state: 'CONNECTED',
    detail: '',
    checkedAt: '2026-09-30T09:55:00Z',
    availability: 'available',
    custody: 'local-keychain',
    ...over,
  });
  it('requires a fresh probe for CONNECTED', () => {
    expect(isHonestStatus(s({}), now)).toBe(true);
    expect(isHonestStatus(s({ checkedAt: null }), now)).toBe(false);
    expect(isHonestStatus(s({ checkedAt: '2026-09-30T08:00:00Z' }), now)).toBe(false);
  });
  it('never lets an unavailable connector claim a live state', () => {
    expect(isHonestStatus(s({ availability: 'not-yet-available' }), now)).toBe(false);
    expect(isHonestStatus(s({ availability: 'not-yet-available', state: 'NOT_CONFIGURED' }), now)).toBe(true);
  });
});
