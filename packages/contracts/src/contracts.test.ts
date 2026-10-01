import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCapability,
  defineModule,
  isHonestStatus,
  permissionCatalog,
  TableDecl,
  ColumnSpec,
  compareDecimal,
  validateColumnValue,
  type ConnectorStatus,
} from './index';

describe('TableDecl write surface', () => {
  const base = {
    name: 'audit_events',
    class: 'append',
    authority: 'append',
    receivedAtField: 'received_at',
    columns: {
      action: { type: 'text', requiredOnInsert: true },
      actor_id: { type: 'uuid', requiredOnInsert: true },
      status: { type: 'text' },
      received_at: { type: 'timestamptz' },
    },
  } as const;
  it('accepts allowed fields with a separate actor stamp', () => {
    const table = TableDecl.parse({ ...base, actorField: 'actor_id', allowedFields: ['action'] });
    expect(table.allowedFields).toEqual(['action']);
  });
  it('rejects server-stamped, actor and guarded fields as device-writable', () => {
    expect(() => TableDecl.parse({ ...base, allowedFields: ['created_by'] })).toThrow(/server-stamped/);
    expect(() => TableDecl.parse({ ...base, actorField: 'actor_id', allowedFields: ['actor_id'] })).toThrow(
      /server-stamped/,
    );
    expect(() => TableDecl.parse({ ...base, guardedColumns: ['status'], allowedFields: ['status'] })).toThrow(
      /guarded/,
    );
  });
  it('rejects a write surface on server or local tables', () => {
    expect(() =>
      TableDecl.parse({ name: 'memberships', class: 'lww', authority: 'server', allowedFields: ['role'] }),
    ).toThrow(/only to synced or append/);
  });
  it('preserves explicit trusted writer capability declarations', () => {
    const table = TableDecl.parse({
      name: 'ledger_balances',
      class: 'local',
      authority: 'local',
      serverWriteCapabilities: ['money_ledger'],
    });
    expect(table.serverWriteCapabilities).toEqual(['money_ledger']);
    expect(() => TableDecl.parse({
      name: 'ledger_balances',
      class: 'local',
      authority: 'local',
      serverWriteCapabilities: ['Money Ledger'],
    })).toThrow();
  });
});

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
      tables: [
        {
          name: 'ops_tasks',
          class: 'lww',
          authority: 'synced',
          guardedColumns: ['status'],
          columns: {},
        },
      ],
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

describe('TableDecl sync specs (CLD-R-007, CLD-R-013)', () => {
  it('requires column specs, a receipt column on append tables and typed stamp columns', () => {
    expect(() =>
      TableDecl.parse({ name: 'ops_tasks', class: 'lww', authority: 'synced', allowedFields: ['title'] }),
    ).toThrow(/declare columns/);
    expect(() =>
      TableDecl.parse({ name: 'audit_events', class: 'append', authority: 'append', columns: {} }),
    ).toThrow(/receipt column/);
    expect(() =>
      TableDecl.parse({
        name: 'ops_tasks',
        class: 'lww',
        authority: 'synced',
        allowedFields: ['title'],
        columns: {},
      }),
    ).toThrow(/title needs a column spec/);
    expect(() =>
      TableDecl.parse({
        name: 'ops_tasks',
        class: 'lww',
        authority: 'synced',
        actorField: 'created_by',
        columns: { created_by: { type: 'text' } },
      }),
    ).toThrow(/actor column is a uuid/);
  });
});

describe('validateColumnValue', () => {
  it('enforces type, nullability, length, enum, ranges, scale and size', () => {
    expect(validateColumnValue(ColumnSpec.parse({ type: 'text', minLength: 1, maxLength: 3 }), 'abcd')).toBe(
      'LENGTH',
    );
    expect(validateColumnValue(ColumnSpec.parse({ type: 'text', enum: ['a'] }), 'b')).toBe('ENUM');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'text' }), { not: 'a string' })).toBe('TYPE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'uuid' }), 'not-a-uuid')).toBe('TYPE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'uuid' }), null)).toBe('NULL');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'uuid', nullable: true }), null)).toBeNull();
    expect(validateColumnValue(ColumnSpec.parse({ type: 'integer' }), '2147483648')).toBe('RANGE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'integer' }), 7)).toBeNull();
    const units = ColumnSpec.parse({ type: 'numeric', scale: 0, min: '0' });
    expect(validateColumnValue(units, '123456789012345678901234567890123456')).toBeNull();
    expect(validateColumnValue(units, '1.5')).toBe('SCALE');
    expect(validateColumnValue(units, '-1')).toBe('RANGE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'numeric' }), 1.5)).toBe('TYPE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'timestamptz' }), '2026-09-30')).toBe('TYPE');
    expect(validateColumnValue(ColumnSpec.parse({ type: 'timestamptz' }), '2026-09-30T12:00:00Z')).toBeNull();
    expect(validateColumnValue(ColumnSpec.parse({ type: 'jsonb', maxBytes: 8 }), { a: 'ééé' })).toBe('SIZE');
  });

  it('compares decimals exactly', () => {
    expect(compareDecimal('-0.5', '0')).toBe(-1);
    expect(compareDecimal('10.10', '10.1')).toBe(0);
    expect(compareDecimal('99999999999999999999.01', '99999999999999999999')).toBe(1);
  });
});
