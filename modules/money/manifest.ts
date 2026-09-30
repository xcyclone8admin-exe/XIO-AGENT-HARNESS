import { defineModule } from '@xyra/contracts';
import { LEDGER_PERMISSIONS, LEDGER_TABLES } from '@xyra/ledger/contracts';

export default defineModule({
  id: 'money',
  version: '1.0.0',
  pillar: 'MONEY',
  title: 'Money',
  description: 'Workspace finance on the shared double-entry ledger',
  icon: 'wallet',
  requirements: ['XIO-REQ-MNY-001', 'REQ-INV-001'],
  permissions: [...LEDGER_PERMISSIONS],
  roleGrants: {
    owner: [...LEDGER_PERMISSIONS],
    admin: [...LEDGER_PERMISSIONS],
    manager: [...LEDGER_PERMISSIONS],
    member: ['money:ledger:read', 'money:ledger:post', 'money:ledger:reconcile'],
    viewer: ['money:ledger:read'],
    auditor: ['money:ledger:read'],
  },
  dependsOn: [],
  tables: [...LEDGER_TABLES],
});
