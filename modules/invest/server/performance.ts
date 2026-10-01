export type PerformanceMark = { id:string; capturedAt:string; navUnits:string; benchmarkIndexUnits:string; externalFlowUnits:string; cumulativeFeeUnits:string };
export type PerformanceStatement = { calculationVersion:'invest-twr-fixed-v1'; fromMarkId:string; toMarkId:string; startNavUnits:string; endNavUnits:string; netExternalFlowUnits:string;
  feesUnits:string; twrBps:string; benchmarkReturnBps:string; relativeReturnBps:string; markCount:number };

const SCALE=1_000_000_000_000n; const BPS=10_000n;
const units=(value:string,label:string,positive=false,signed=false) => {
  if (!(signed ? /^(0|-?[1-9]\d{0,37})$/ : /^(0|[1-9]\d{0,37})$/).test(value) || (positive && BigInt(value)<=0n)) throw new RangeError(`${label} must be a canonical ${positive?'positive':signed?'signed':'non-negative'} integer`);
  return BigInt(value);
};
const roundedRatio=(numerator:bigint,denominator:bigint) => (numerator*SCALE+denominator/2n)/denominator;

/** Chains flow-adjusted returns at a documented 1e-12 fixed precision; no float enters the statement. */
export function calculateTimeWeightedStatement(marksInput:readonly PerformanceMark[]):PerformanceStatement {
  if (marksInput.length<2 || marksInput.length>10000) throw new RangeError('A performance statement requires 2 to 10000 marks');
  const marks=[...marksInput];
  for (let i=0;i<marks.length;i+=1) {
    const mark=marks[i]!; const time=Date.parse(mark.capturedAt);
    if (!Number.isFinite(time) || (i>0 && Date.parse(marks[i-1]!.capturedAt)>=time)) throw new RangeError('Performance marks must be strictly chronological');
    units(mark.navUnits,`mark ${i} NAV`,true); units(mark.benchmarkIndexUnits,`mark ${i} benchmark`,true);
    units(mark.externalFlowUnits,`mark ${i} external flow`,false,true); units(mark.cumulativeFeeUnits,`mark ${i} fees`);
  }
  let wealth=SCALE; let totalFlow=0n;
  for (let i=1;i<marks.length;i+=1) {
    const previous=marks[i-1]!; const current=marks[i]!;
    const start=BigInt(previous.navUnits); const end=BigInt(current.navUnits); const flow=BigInt(current.externalFlowUnits);
    if (start<=0n || end-flow<0n) throw new RangeError('Flow-adjusted NAV must be non-negative and start NAV positive');
    wealth=(wealth*roundedRatio(end-flow,start)+SCALE/2n)/SCALE;
    totalFlow+=flow;
  }
  const first=marks[0]!; const last=marks[marks.length-1]!;
  const twr=(wealth-SCALE)*BPS/SCALE;
  const benchmark=(BigInt(last.benchmarkIndexUnits)-BigInt(first.benchmarkIndexUnits))*BPS/BigInt(first.benchmarkIndexUnits);
  const fees=BigInt(last.cumulativeFeeUnits)-BigInt(first.cumulativeFeeUnits);
  if (fees<0n) throw new RangeError('Cumulative fees cannot decrease');
  return {calculationVersion:'invest-twr-fixed-v1',fromMarkId:first.id,toMarkId:last.id,startNavUnits:first.navUnits,endNavUnits:last.navUnits,
    netExternalFlowUnits:totalFlow.toString(),feesUnits:fees.toString(),twrBps:twr.toString(),benchmarkReturnBps:benchmark.toString(),relativeReturnBps:(twr-benchmark).toString(),markCount:marks.length};
}
