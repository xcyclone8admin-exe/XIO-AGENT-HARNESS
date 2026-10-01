/**
 * Minor-unit helpers. Every amount is a bigint count of the asset's smallest unit; strings cross every
 * boundary (JSON, SQL parameters). Rounding is explicit per operation (see RoundingMode in @xyra/core).
 */
import { divRound, formatAmount, parseAmount, type RoundingMode } from '@xyra/core';
import { MAX_ASSET_SCALE, MinorUnits } from './contracts';

/** numeric(38,0) bound: at most 38 decimal digits. */
export const MAX_UNITS = 10n ** 38n - 1n;

export function assertUnitsInRange(units: bigint): bigint {
  if (units > MAX_UNITS || units < -MAX_UNITS) throw new RangeError('units exceed numeric(38,0)');
  return units;
}

/** Parse wire units ("-12345") into a bigint. Rejects anything that is not an integer string. */
export function toUnits(text: string): bigint {
  const parsed = MinorUnits.safeParse(text);
  if (!parsed.success) throw new RangeError(`not integer minor units: "${text}"`);
  return BigInt(parsed.data);
}

export function fromUnits(units: bigint): string {
  return assertUnitsInRange(units).toString();
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ASSET_SCALE)
    throw new RangeError(`invalid scale ${scale}`);
}

/**
 * Parse a human decimal ("1234.56") into units at `scale`. Excess precision is an error unless the
 * caller names a rounding mode.
 */
export function decimalToUnits(text: string, scale: number, rounding?: RoundingMode): bigint {
  assertScale(scale);
  return assertUnitsInRange(parseAmount(text, scale, rounding).units);
}

/** Render units as a plain decimal string ("-1234.50"); never goes through a float. */
export function unitsToDecimal(units: bigint, scale: number): string {
  assertScale(scale);
  return formatAmount({ units: assertUnitsInRange(units), scale });
}

/** Re-express units from one scale at another with an explicit rounding mode (e.g. 18 → 8). */
export function rescaleUnits(
  units: bigint,
  fromScale: number,
  toScale: number,
  rounding: RoundingMode,
): bigint {
  assertScale(fromScale);
  assertScale(toScale);
  if (toScale >= fromScale) return assertUnitsInRange(units * 10n ** BigInt(toScale - fromScale));
  return assertUnitsInRange(divRound(units, 10n ** BigInt(fromScale - toScale), rounding));
}

/**
 * quantity × price → value, all exact integers. `quantity` is at `quantityScale`, `price` at `priceScale`
 * (price per whole unit), the result is at `valueScale`, rounded once with `rounding`.
 */
export function multiplyUnits(
  quantity: bigint,
  quantityScale: number,
  price: bigint,
  priceScale: number,
  valueScale: number,
  rounding: RoundingMode,
): bigint {
  assertScale(quantityScale);
  assertScale(priceScale);
  assertScale(valueScale);
  const numerator = quantity * price * 10n ** BigInt(valueScale);
  const denominator = 10n ** BigInt(quantityScale + priceScale);
  return assertUnitsInRange(divRound(numerator, denominator, rounding));
}

/** units × bps / 10_000 with explicit rounding (fees, limits expressed in basis points). */
export function applyBps(units: bigint, bps: bigint, rounding: RoundingMode): bigint {
  return assertUnitsInRange(divRound(units * bps, 10_000n, rounding));
}

/** Sum wire or bigint units exactly. */
export function sumUnits(values: Iterable<bigint | string>): bigint {
  let total = 0n;
  for (const value of values) total += typeof value === 'bigint' ? value : toUnits(value);
  return assertUnitsInRange(total);
}
