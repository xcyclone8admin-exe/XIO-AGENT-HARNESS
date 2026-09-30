import { defineModule } from '@xyra/contracts';

export default defineModule({
  id: 'core',
  version: '1.0.0',
  pillar: 'PLATFORM',
  title: 'Workspace',
  description: 'Identity, approvals, audit and settings',
  icon: 'settings',
  order: 10,
  requirements: ['REQ-CORP-001', 'REQ-SEC-004'],
  permissions: [
    'core:workspace:read',
    'core:workspace:write',
    'core:approval:read',
    'core:approval:decide',
    'core:audit:read',
  ],
  roleGrants: {
    manager: ['core:workspace:read', 'core:approval:read'],
    member: ['core:workspace:read'],
    viewer: ['core:workspace:read'],
    auditor: ['core:workspace:read', 'core:audit:read'],
  },
  nav: [
    { path: '', title: 'Workspace', keywords: ['organization', 'members'] },
    {
      path: 'approvals',
      title: 'Approvals',
      keywords: ['decisions', 'requests'],
      permission: 'core:approval:read',
    },
    { path: 'audit', title: 'Audit', keywords: ['activity', 'history'], permission: 'core:audit:read' },
    { path: 'settings', title: 'Settings', keywords: ['preferences'] },
  ],
  tables: [
    { name: 'tenants', class: 'lww', authority: 'server' },
    { name: 'workspaces', class: 'lww', authority: 'server' },
    { name: 'users', class: 'lww', authority: 'server' },
    { name: 'memberships', class: 'lww', authority: 'server' },
    { name: 'approval_requests', class: 'append', authority: 'append' },
    { name: 'approval_decisions', class: 'append', authority: 'server' },
    { name: 'audit_events', class: 'append', authority: 'append' },
    { name: 'domain_events', class: 'append', authority: 'append' },
  ],
});
