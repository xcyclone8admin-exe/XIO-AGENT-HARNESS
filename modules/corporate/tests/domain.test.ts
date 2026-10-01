import { describe,expect,it } from 'vitest';
import manifest from '../manifest';
import { corporateCapabilities } from '../contracts';
import { dilution,ownershipTotal,progressBps } from '../server';

describe('Corporate governance and finance invariants',()=>{
 it('caps ownership at one hundred percent using integer basis points',()=>{
  expect(ownershipTotal([6000,4000])).toBe(10000);
  expect(ownershipTotal([6000,4001])).toBeGreaterThan(10000);
 });
 it('calculates clamped OKR progress without floating point',()=>{
  expect(progressBps('0','3','1')).toBe(3333);
  expect(progressBps('10','0','5')).toBe(5000);
  expect(progressBps('0','10','20')).toBe(10000);
 });
 it('computes dilution deterministically for large share counts',()=>{
  expect(dilution([{holder_ref:'founder',units:'9007199254740993'},{holder_ref:'team',units:'1000000'}],'1000000')).toEqual([
   {holder_ref:'founder',units:'9007199254740993',ownership_bps:9999},
   {holder_ref:'team',units:'1000000',ownership_bps:0},
   {holder_ref:'proposed-issuance',units:'1000000',ownership_bps:0},
  ]);
 });
 it('declares a guarded immutable governance and auditor-only audit surface',()=>{
  expect(manifest.tables.map(t=>t.name)).toContain('corporate_resolutions');
  expect(manifest.permissions).toContain('corporate:audit:read');
  expect(manifest.roleGrants.auditor).toContain('corporate:audit:read');
  expect(corporateCapabilities.approveResolution.approvalPolicy).toBe('corporate.board.adopt');
  expect(corporateCapabilities.audit.kind).toBe('read');
 });
});
