import { z } from 'zod';

/**
 * Column specs for device-writable sync fields (CLD-R-007). The Worker and the sidecar
 * validate every synced value against the same spec, and a PGlite parity test keeps the specs
 * equal to the migrations, so a row the server accepts is a row every device can store.
 *
 * Canonical wire encoding: `integer`/`numeric` travel as decimal strings (lossless for
 * numeric(38,0) ledger units; a JSON number is also accepted for safe integers),
 * `timestamptz` as ISO 8601 with offset, `date` as YYYY-MM-DD, `jsonb` as any JSON value.
 */
export const ColumnType = z.enum([
  'uuid',
  'text',
  'integer',
  'numeric',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
]);
export type ColumnType = z.infer<typeof ColumnType>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

export const ColumnSpec = z
  .object({
    type: ColumnType,
    nullable: z.boolean().default(false),
    /** NOT NULL without a database default: an insert must carry it. */
    requiredOnInsert: z.boolean().default(false),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    enum: z.array(z.string()).min(1).optional(),
    /** Inclusive bounds for integer/numeric, as decimal strings. */
    min: z.string().regex(DECIMAL).optional(),
    max: z.string().regex(DECIMAL).optional(),
    /** numeric: maximum digits after the decimal point. */
    scale: z.number().int().nonnegative().optional(),
    /** Serialized size cap for jsonb values, in bytes. */
    maxBytes: z.number().int().positive().optional(),
    /** Same-tenant, same-workspace parent row in a synced table (the value is its id). */
    references: z.object({ table: z.string().regex(/^[a-z][a-z0-9_]*$/) }).optional(),
  })
  .superRefine((spec, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((spec.minLength !== undefined || spec.maxLength !== undefined || spec.enum) && spec.type !== 'text')
      issue('minLength/maxLength/enum apply to text columns');
    if ((spec.min !== undefined || spec.max !== undefined) && !['integer', 'numeric'].includes(spec.type))
      issue('min/max apply to integer/numeric columns');
    if (spec.scale !== undefined && spec.type !== 'numeric') issue('scale applies to numeric columns');
    if (spec.maxBytes !== undefined && spec.type !== 'jsonb') issue('maxBytes applies to jsonb columns');
    if (spec.references !== undefined && spec.type !== 'uuid') issue('references applies to uuid columns');
    if (spec.requiredOnInsert && spec.nullable) issue('a nullable column cannot be requiredOnInsert');
  });
export type ColumnSpec = z.infer<typeof ColumnSpec>;

export type ColumnViolation = 'TYPE' | 'NULL' | 'LENGTH' | 'ENUM' | 'RANGE' | 'SCALE' | 'SIZE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT32 = { min: -2147483648n, max: 2147483647n };

/** Exact comparison of two decimal strings. */
export function compareDecimal(a: string, b: string): number {
  const split = (value: string) => {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
    return { negative, whole, fraction };
  };
  const x = split(a);
  const y = split(b);
  const width = Math.max(x.fraction.length, y.fraction.length);
  const scaled = (part: { negative: boolean; whole: string; fraction: string }) =>
    (part.negative ? -1n : 1n) * BigInt(part.whole + part.fraction.padEnd(width, '0'));
  const difference = scaled(x) - scaled(y);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

/** UTF-8 byte length without TextEncoder (contracts stay lib-neutral). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function decimalOf(value: unknown): string | null {
  if (typeof value === 'string') return DECIMAL.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** Validates one wire value against its column spec; returns null when valid. */
export function validateColumnValue(spec: ColumnSpec, value: unknown): ColumnViolation | null {
  if (value === null || value === undefined) return spec.nullable ? null : 'NULL';
  switch (spec.type) {
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? null : 'TYPE';
    case 'text': {
      if (typeof value !== 'string') return 'TYPE';
      const length = [...value].length;
      if (spec.minLength !== undefined && length < spec.minLength) return 'LENGTH';
      if (spec.maxLength !== undefined && length > spec.maxLength) return 'LENGTH';
      if (spec.enum && !spec.enum.includes(value)) return 'ENUM';
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'TYPE';
    case 'timestamptz':
      return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : 'TYPE';
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : 'TYPE';
    case 'integer':
    case 'numeric': {
      const decimal = decimalOf(value);
      if (decimal === null) return 'TYPE';
      if (spec.type === 'integer') {
        if (decimal.includes('.')) return 'TYPE';
        const n = BigInt(decimal);
        if (n < INT32.min || n > INT32.max) return 'RANGE';
      }
      if (spec.scale !== undefined && (decimal.split('.')[1]?.length ?? 0) > spec.scale) return 'SCALE';
      if (spec.min !== undefined && compareDecimal(decimal, spec.min) < 0) return 'RANGE';
      if (spec.max !== undefined && compareDecimal(decimal, spec.max) > 0) return 'RANGE';
      return null;
    }
    case 'jsonb': {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return 'TYPE';
      }
      if (serialized === undefined) return 'TYPE';
      if (spec.maxBytes !== undefined && utf8Length(serialized) > spec.maxBytes) return 'SIZE';
      return null;
    }
  }
}
