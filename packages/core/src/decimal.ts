/**
 * Decimal-safe amounts (Protocol 05 §22–23, ADR-0010). Values are bigint minor units with an explicit
 * scale; they cross boundaries as strings. No floating point is ever used for money or quantities.
 */
export type RoundingMode = 'half-even' | 'half-up' | 'down' | 'up';

export interface Amount {
  readonly units: bigint;
  readonly scale: number;
}

const assertScale = (scale: number): void => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new RangeError(`scale must be 0..18, got ${scale}`);
};

/** Parse "1234.5" at scale 2 → 123450n. Rejects excess precision unless a rounding mode is given. */
export function parseAmount(text: string, scale: number, rounding?: RoundingMode): Amount {
  assertScale(scale);
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`Not a decimal: "${text}"`);
  const neg = m[1] === '-';
  const int = m[2] ?? '0';
  const frac = m[3] ?? '';
  let units: bigint;
  if (frac.length <= scale) {
    units = BigInt(int + frac.padEnd(scale, '0'));
  } else {
    if (!rounding) throw new RangeError(`"${text}" exceeds scale ${scale}`);
    const kept = BigInt(int + frac.slice(0, scale));
    const rest = frac.slice(scale);
    units = roundRemainder(kept, rest, rounding, neg);
  }
  return { units: neg ? -units : units, scale };
}

function roundRemainder(kept: bigint, rest: string, mode: RoundingMode, neg: boolean): bigint {
  const nonZero = /[1-9]/.test(rest);
  if (!nonZero) return kept;
  const first = Number(rest[0]);
  const exactlyHalf = first === 5 && !/[1-9]/.test(rest.slice(1));
  switch (mode) {
    case 'down':
      return kept;
    case 'up':
      return kept + 1n;
    case 'half-up':
      return first >= 5 ? kept + 1n : kept;
    case 'half-even':
      if (first > 5 || (first === 5 && !exactlyHalf)) return kept + 1n;
      if (exactlyHalf) return kept % 2n === 0n ? kept : kept + 1n;
      return kept;
  }
  void neg;
  return kept;
}

export function formatAmount(a: Amount): string {
  assertScale(a.scale);
  const neg = a.units < 0n;
  const digits = (neg ? -a.units : a.units).toString().padStart(a.scale + 1, '0');
  const int = digits.slice(0, digits.length - a.scale);
  const frac = a.scale ? '.' + digits.slice(digits.length - a.scale) : '';
  return (neg ? '-' : '') + int + frac;
}

const same = (a: Amount, b: Amount): void => {
  if (a.scale !== b.scale) throw new RangeError(`scale mismatch ${a.scale} vs ${b.scale}`);
};
export const add = (a: Amount, b: Amount): Amount => (same(a, b), { units: a.units + b.units, scale: a.scale });
export const sub = (a: Amount, b: Amount): Amount => (same(a, b), { units: a.units - b.units, scale: a.scale });
export const neg = (a: Amount): Amount => ({ units: -a.units, scale: a.scale });
export const isZero = (a: Amount): boolean => a.units === 0n;
export const cmp = (a: Amount, b: Amount): number => (same(a, b), a.units < b.units ? -1 : a.units > b.units ? 1 : 0);

/** a × (num/den) rounded into targetScale, e.g. quantity × price, or FX conversion. */
export function mulRatio(a: Amount, num: bigint, den: bigint, targetScale: number, mode: RoundingMode = 'half-even'): Amount {
  assertScale(targetScale);
  if (den === 0n) throw new RangeError('division by zero');
  const shift = targetScale - a.scale;
  let n = a.units * num;
  let d = den;
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else d *= 10n ** BigInt(-shift);
  return { units: divRound(n, d, mode), scale: targetScale };
}

export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = n < 0n;
  const twice = (r < 0n ? -r : r) * 2n;
  const away = negative ? q - 1n : q + 1n;
  switch (mode) {
    case 'down':
      return q;
    case 'up':
      return away;
    case 'half-up':
      return twice >= d ? away : q;
    case 'half-even':
      if (twice > d) return away;
      if (twice < d) return q;
      return q % 2n === 0n ? q : away;
  }
}

/** Split an amount into n parts that sum exactly (remainder to the first parts). */
export function allocate(a: Amount, parts: number): Amount[] {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError('parts must be a positive integer');
  const base = a.units / BigInt(parts);
  let rem = a.units - base * BigInt(parts);
  const step = rem < 0n ? -1n : 1n;
  return Array.from({ length: parts }, () => {
    let u = base;
    if (rem !== 0n) {
      u += step;
      rem -= step;
    }
    return { units: u, scale: a.scale };
  });
}
