import { expect, test } from 'vitest';
import { calculateTimeWeightedStatement, type PerformanceMark } from '../server/performance';

const mark=(id:string,capturedAt:string,navUnits:string,benchmarkIndexUnits:string,externalFlowUnits:string,cumulativeFeeUnits='0'):PerformanceMark=>({id,capturedAt,navUnits,benchmarkIndexUnits,externalFlowUnits,cumulativeFeeUnits});

test('chains flow-adjusted portfolio return separately from benchmark and includes fees',()=>{
  const marks=[mark('a','2026-01-01T00:00:00.000Z','100000','10000','0','100'),
    mark('b','2026-01-02T00:00:00.000Z','160000','11000','50000','150')];
  const statement=calculateTimeWeightedStatement(marks);
  expect(statement).toMatchObject({calculationVersion:'invest-twr-fixed-v1',startNavUnits:'100000',endNavUnits:'160000',netExternalFlowUnits:'50000',feesUnits:'50',twrBps:'1000',benchmarkReturnBps:'1000',relativeReturnBps:'0',markCount:2});
  expect(calculateTimeWeightedStatement(marks)).toEqual(statement);
});

test('multiple cash-flow subperiods chain deterministically',()=>{
  const marks=[mark('a','2026-01-01T00:00:00.000Z','100000','10000','0'),mark('b','2026-01-02T00:00:00.000Z','110000','10500','0'),
    mark('c','2026-01-03T00:00:00.000Z','210000','11000','100000')];
  expect(calculateTimeWeightedStatement(marks)).toMatchObject({twrBps:'1000',benchmarkReturnBps:'1000',netExternalFlowUnits:'100000'});
});

test('rejects invalid chronology, zero starting NAV and flow beyond ending NAV',()=>{
  expect(()=>calculateTimeWeightedStatement([mark('a','2026-01-02T00:00:00.000Z','1','1','0'),mark('b','2026-01-01T00:00:00.000Z','1','1','0')])).toThrow(/chronological/);
  expect(()=>calculateTimeWeightedStatement([mark('a','2026-01-01T00:00:00.000Z','0','1','0'),mark('b','2026-01-02T00:00:00.000Z','1','1','0')])).toThrow(/positive integer/);
  expect(()=>calculateTimeWeightedStatement([mark('a','2026-01-01T00:00:00.000Z','100','1','0'),mark('b','2026-01-02T00:00:00.000Z','10','1','20')])).toThrow(/non-negative/);
});
