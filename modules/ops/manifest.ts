import { defineModule } from '@xyra/contracts';

export default defineModule({
  id: 'ops',
  version: '1.0.0',
  pillar: 'COMMAND',
  title: 'Operations',
  description: 'Projects and tasks in one operating view',
  icon: 'list-checks',
  order: 10,
  requirements: ['REQ-004', 'XIO-REQ-CMD-001'],
  permissions: ['ops:project:read', 'ops:project:write', 'ops:task:read', 'ops:task:write'],
  roleGrants: {
    manager: ['ops:project:read', 'ops:project:write', 'ops:task:read', 'ops:task:write'],
    member: ['ops:project:read', 'ops:task:read', 'ops:task:write'],
    viewer: ['ops:project:read', 'ops:task:read'],
    auditor: ['ops:project:read', 'ops:task:read'],
  },
  nav: [
    { path: '', title: 'Projects', keywords: ['work', 'portfolio'] },
    { path: 'tasks', title: 'Tasks', keywords: ['assignments', 'board'] },
  ],
  dependsOn: ['core'],
  tables: [
    { name: 'ops_projects', class: 'lww', authority: 'synced', guardedColumns: ['status'] },
    { name: 'ops_tasks', class: 'lww', authority: 'synced', guardedColumns: ['status'] },
  ],
});
