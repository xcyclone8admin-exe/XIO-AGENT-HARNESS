import { defineModule } from '@xyra/contracts';

/**
 * Frozen v1 table ownership. Append records are immutable journals; schedule configuration is
 * local until WP-CLOUD provides a multi-device lease authority.
 */
export default defineModule({
  id: 'swarm',
  version: '1.0.0',
  pillar: 'SWARM',
  title: 'Swarm',
  description: 'Bounded agent profiles, runs, model routing, evaluations and Night Shift',
  icon: 'bot',
  order: 20,
  requirements: [
    'XIO-REQ-SWM-001',
    'XIO-REQ-SWM-002',
    'XIO-REQ-SWM-003',
    'XIO-REQ-SWM-004',
    'XIO-REQ-SWM-005',
    'XIO-REQ-SWM-006',
    'XIO-REQ-SWM-007',
    'XIO-REQ-SWM-008',
    'REQ-AIS-001',
    'REQ-AIS-002',
    'REQ-AIS-003',
    'REQ-AIS-005',
    'REQ-AIS-006',
    'REQ-AIS-007',
    'REQ-AIS-008',
  ],
  permissions: [
    'swarm:profile:read',
    'swarm:profile:write',
    'swarm:run:read',
    'swarm:run:write',
    'swarm:run:cancel',
    'swarm:night-shift:configure',
  ],
  roleGrants: {
    owner: [
      'swarm:profile:read',
      'swarm:profile:write',
      'swarm:run:read',
      'swarm:run:write',
      'swarm:run:cancel',
      'swarm:night-shift:configure',
    ],
    admin: ['swarm:profile:read', 'swarm:profile:write', 'swarm:run:read', 'swarm:run:write', 'swarm:run:cancel'],
    manager: ['swarm:profile:read', 'swarm:run:read', 'swarm:run:write', 'swarm:run:cancel'],
    member: ['swarm:profile:read', 'swarm:run:read'],
    viewer: ['swarm:profile:read', 'swarm:run:read'],
    auditor: ['swarm:profile:read', 'swarm:run:read'],
  },
  nav: [
    { path: '', title: 'Operations floor', keywords: ['agents', 'runs', 'crew'] },
    { path: 'profiles', title: 'Agent profiles', keywords: ['roles', 'charters'] },
    { path: 'night-shift', title: 'Night Shift', keywords: ['autonomy', 'schedule', 'leash'] },
  ],
  events: {
    emits: ['swarm.run.started', 'swarm.run.terminated', 'swarm.run.tool-denied', 'swarm.night-shift.changed'],
    consumes: ['core.kill-switch.changed'],
  },
  tables: [
    { name: 'swarm_agent_profiles', class: 'lww', authority: 'synced', guardedColumns: ['capability_grants', 'autonomy_level'] },
    { name: 'swarm_model_evals', class: 'append', authority: 'append' },
    { name: 'swarm_runs', class: 'append', authority: 'append', children: ['swarm_run_journal'] },
    { name: 'swarm_run_journal', class: 'append', authority: 'append' },
    { name: 'swarm_prompt_versions', class: 'append', authority: 'append' },
    { name: 'swarm_night_shift', class: 'local', authority: 'local' },
  ],
  dataClassification: 'confidential',
});
