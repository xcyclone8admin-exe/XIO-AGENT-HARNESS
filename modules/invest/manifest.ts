import { defineModule } from '@xyra/contracts';

export default defineModule({
  id: 'invest',
  version: '1.0.0',
  pillar: 'INTEL',
  title: 'Invest',
  description: 'Portfolio and investment operations on the shared ledger',
  icon: 'chart-no-axes-combined',
  requirements: ['REQ-INV-001'],
  permissions: [],
  dependsOn: ['money'],
  tables: [],
});
