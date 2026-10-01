import { notionalUnits } from './risk';

export type FifoLotBalance = { id:string; remainingUnits:string; remainingBasisUnits:string };
export type FifoLotAllocation = { lotId:string; consumedUnits:string; remainingUnits:string; basisUnits:string; remainingBasisUnits:string; proceedsUnits:string; realizedGainUnits:string };

/** Allocates disposal against oldest lots. Partial basis rounds down; the last disposal takes the exact residual. */
export function allocateFifoTaxLots(lots: readonly FifoLotBalance[], quantityUnits: string, priceUnits: string, quantityScale: number): FifoLotAllocation[] {
  let quantity = BigInt(quantityUnits);
  if (quantity <= 0n) throw new RangeError('FIFO disposal quantity must be positive');
  const allocations: FifoLotAllocation[] = [];
  for (const lot of lots) {
    if (quantity === 0n) break;
    const available = BigInt(lot.remainingUnits); const remainingBasis = BigInt(lot.remainingBasisUnits);
    if (available < 0n || remainingBasis < 0n || available === 0n) continue;
    const consumed = available < quantity ? available : quantity;
    const basis = consumed === available ? remainingBasis : remainingBasis * consumed / available;
    const proceeds = notionalUnits(consumed.toString(), priceUnits, quantityScale);
    allocations.push({ lotId:lot.id,consumedUnits:consumed.toString(),remainingUnits:(available-consumed).toString(),basisUnits:basis.toString(),
      remainingBasisUnits:(remainingBasis-basis).toString(),proceedsUnits:proceeds.toString(),realizedGainUnits:(proceeds-basis).toString() });
    quantity -= consumed;
  }
  if (quantity !== 0n) throw new Error('PAPER FIFO tax lots do not reconcile to the ledger position');
  return allocations;
}
