import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

const Empty = z.object({});
export const coreCapabilities = {
  workspace: defineCapability({
    id: 'core.workspace.get', title: 'Workspace details', description: 'Read the current workspace',
    kind: 'read', permission: 'core:workspace:read', input: Empty,
    output: z.object({ id: z.uuid(), name: z.string(), kind: z.enum(['standard','sample']), sync_enabled: z.boolean() }).nullable(),
  }),
  members: defineCapability({
    id: 'core.members.list', title: 'Workspace members', description: 'List active members',
    kind: 'read', permission: 'core:workspace:read', input: Empty,
    output: z.array(z.object({ id: z.uuid(), displayName: z.string(), role: z.string() })),
  }),
  approvals: defineCapability({
    id: 'core.approvals.list', title: 'Approval queue', description: 'List recent approval requests',
    kind: 'read', permission: 'core:approval:read', input: Empty,
    output: z.array(z.record(z.string(), z.unknown())),
  }),
  audit: defineCapability({
    id: 'core.audit.list', title: 'Audit log', description: 'List recent audited actions',
    kind: 'read', permission: 'core:audit:read', input: Empty,
    output: z.array(z.record(z.string(), z.unknown())),
  }),
  theme: defineCapability({
    id: 'core.settings.get', title: 'Workspace settings', description: 'Read appearance settings',
    kind: 'read', permission: 'core:settings:read', input: Empty,
    output: z.object({ theme: z.enum(['system','light','dark']) }),
  }),
  setTheme: defineCapability({
    id: 'core.settings.set', title: 'Set workspace theme', description: 'Update appearance settings',
    kind: 'write', permission: 'core:settings:write', input: z.object({ theme: z.enum(['system','light','dark']) }),
    output: z.object({ theme: z.enum(['system','light','dark']) }),
  }),
} as const;
