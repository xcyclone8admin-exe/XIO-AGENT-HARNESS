import { describe, expect, it } from 'vitest';
import manifest from './manifest';
import { swarmCapabilities } from './contracts';

describe('swarm contract freeze', () => {
  it('uses append journals and leaves Night Shift local until a cloud lease authority exists', () => {
    expect(manifest.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'swarm_runs', class: 'append', authority: 'append' }),
      expect.objectContaining({ name: 'swarm_run_journal', class: 'append', authority: 'append' }),
      expect.objectContaining({ name: 'swarm_night_shift', class: 'local', authority: 'local' }),
    ]));
  });

  it('exposes profile and Night Shift actions through capability descriptors', () => {
    expect(swarmCapabilities.createProfile.id).toBe('swarm.profiles.create');
    expect(swarmCapabilities.configureNightShift.approvalPolicy).toBe('swarm.night-shift.configure');
  });
});
