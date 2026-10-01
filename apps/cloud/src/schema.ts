import { validateColumnValue, type ColumnSpec } from '@xyra/contracts';

export type SchemaProblem =
  { readonly kind: 'invalid'; readonly field: string } | { readonly kind: 'missing'; readonly field: string };

/**
 * Validates the merged row (stored fields + this change) against the table's column specs.
 * `insert` additionally requires every requiredOnInsert column.
 */
export function checkRow(
  columns: ReadonlyMap<string, ColumnSpec>,
  merged: Readonly<Record<string, { readonly value: unknown }>>,
  insert: boolean,
): SchemaProblem | null {
  for (const [field, write] of Object.entries(merged)) {
    const spec = columns.get(field);
    if (!spec || validateColumnValue(spec, write.value) !== null) return { kind: 'invalid', field };
  }
  if (insert) {
    for (const [field, spec] of columns) {
      if (spec.requiredOnInsert && !Object.hasOwn(merged, field)) return { kind: 'missing', field };
    }
  }
  return null;
}
