import { describe, expect, it } from 'vitest';
import { exactVariance, nextPhase } from '../server';
import manifest from '../manifest';
import { studioCapabilities } from '../contracts';

describe('Studio domain invariants', () => {
  it('uses integer strings for variance and estimated final cost', () => {
    expect(exactVariance('10000000000000000001','4500000000000000000','500000000000000000')).toEqual({
      variance:'5500000000000000001', estimate:'5000000000000000000',
    });
  });
  it('only allows forward adjacent production phases', () => {
    expect(nextPhase('development','pre-production')).toBe(true);
    expect(nextPhase('development','production')).toBe(false);
    expect(nextPhase('release','release')).toBe(false);
  });
  it('declares Studio tables and guarded clearance transitions', () => {
    expect(manifest.tables.map((table)=>table.name)).toContain('studio_rights');
    expect(manifest.tables.find((table)=>table.name==='studio_deliverables')?.guardedColumns).toContain('status');
    expect(studioCapabilities.clearDeliverable.approvalPolicy).toBe('studio.deliverable.approve');
    expect(studioCapabilities.budgetActuals.output.safeParse([{id:'00000000-0000-0000-0000-000000000001',production_id:'00000000-0000-0000-0000-000000000001',account_code:'PROD',asset:'USD',planned_units:'01',committed_units:'0',actual_units:'0',variance_units:'1',estimated_final_units:'0'}]).success).toBe(false);
  });
});
