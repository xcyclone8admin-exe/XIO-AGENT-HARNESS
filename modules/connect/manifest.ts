import { defineModule } from '@xyra/contracts';

export default defineModule({
  id: 'connect',
  version: '1.0.0',
  pillar: 'CONNECT',
  title: 'Connect',
  description: 'Honest connector catalog, credential grants and the MCP authorization boundary',
  icon: 'plug',
  order: 60,
  requirements: ['XIO-REQ-CON-001', 'REQ-AIS-002', 'REQ-AIS-005', 'REQ-DATA-001'],
  permissions: [
    'connect:catalog:read',
    'connect:connector:grant',
    'connect:connector:revoke',
    'connect:mcp:configure',
  ],
  roleGrants: {
    owner: ['connect:catalog:read', 'connect:connector:grant', 'connect:connector:revoke', 'connect:mcp:configure'],
    admin: ['connect:catalog:read', 'connect:connector:grant', 'connect:connector:revoke', 'connect:mcp:configure'],
    manager: ['connect:catalog:read', 'connect:connector:grant', 'connect:connector:revoke'],
    member: ['connect:catalog:read'],
    viewer: ['connect:catalog:read'],
    auditor: ['connect:catalog:read'],
  },
  dependsOn: ['core'],
  nav: [
    { path: '', title: 'Catalog', keywords: ['connect', 'connectors', 'integrations'] },
    { path: 'grants', title: 'Grants', keywords: ['credentials', 'permissions', 'revoke'] },
  ],
  events: {
    emits: ['connect.connector.granted', 'connect.connector.revoked'],
    consumes: [],
  },
  tables: [
    { name: 'connect_connectors', class: 'local', authority: 'local' },
    {
      name: 'connect_grants',
      class: 'append',
      authority: 'append',
      actorField: 'created_by',
      receivedAtField: 'created_at',
      writePermission: 'connect:connector:grant',
      readPermission: 'connect:catalog:read',
      allowedFields: ['connector_id', 'action', 'allowed_tools', 'reason'],
      columns: {
        connector_id: { type: 'text', requiredOnInsert: true },
        action: { type: 'text', requiredOnInsert: true },
        allowed_tools: { type: 'jsonb' },
        reason: { type: 'text' },
        created_by: { type: 'uuid', requiredOnInsert: true },
        created_at: { type: 'timestamptz' },
      },
    },
  ],
  dataClassification: 'confidential',
});
