import { expect, test } from 'vitest';
import { allocateFifoTaxLots, type FifoLotBalance } from '../server/tax-lots';

test('FIFO integer basis is conserved over repeated partial and final disposals', () => {
  let lots: FifoLotBalance[] = [
    { id:'first',remainingUnits:'3',remainingBasisUnits:'10' },
    { id:'second',remainingUnits:'2',remainingBasisUnits:'7' },
  ];
  let basisDisposed = 0n;
  for (const quantity of ['1','1','1','2']) {
    const allocations = allocateFifoTaxLots(lots,quantity,'2',0);
    basisDisposed += allocations.reduce((sum,row)=>sum+BigInt(row.basisUnits),0n);
    const after = new Map(allocations.map((row)=>[row.lotId,row]));
    lots = lots.map((lot)=>{
      const allocation=after.get(lot.id);
      return allocation ? {id:lot.id,remainingUnits:allocation.remainingUnits,remainingBasisUnits:allocation.remainingBasisUnits} : lot;
    });
  }
  expect(basisDisposed).toBe(17n);
  expect(lots).toEqual([{id:'first',remainingUnits:'0',remainingBasisUnits:'0'},{id:'second',remainingUnits:'0',remainingBasisUnits:'0'}]);
  expect(()=>allocateFifoTaxLots(lots,'1','2',0)).toThrow(/do not reconcile/);
});
