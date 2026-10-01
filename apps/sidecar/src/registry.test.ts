import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { applyPGliteMigrations, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { MIGRATIONS } from './generated/migrations';
import { MANIFESTS } from './generated/modules';

const sorted = (values: readonly string[]) => [...values].sort();

test('package.json dependsOn matches each manifest (the generator orders by the former)', () => {
  for (const manifest of MANIFESTS) {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../modules/${manifest.id}/package.json`, import.meta.url)),
        'utf8',
      ),
    ) as { xyraModule: { dependsOn?: string[] } };
    expect(sorted(pkg.xyraModule.dependsOn ?? []), manifest.id).toEqual(sorted(manifest.dependsOn));
  }
});

/**
 * Applies every module block in a second valid dependency order (reverse tie-breaking). A module
 * migration that uses another module's tables without declaring dependsOn fails in one of the two
 * orders, so the order a device or Neon branch happened to see can never matter (ADR-0016).
 */
test('migrations apply in an alternate valid dependency order', async () => {
  const deps = new Map(MANIFESTS.map((manifest) => [manifest.id, sorted(manifest.dependsOn)]));
  const order: string[] = [];
  const visit = (id: string) => {
    if (order.includes(id)) return;
    for (const dep of [...(deps.get(id) ?? [])].reverse()) visit(dep);
    order.push(id);
  };
  for (const id of sorted([...deps.keys()]).reverse()) visit(id);
  const blocks = new Map<string, Migration[]>();
  for (const item of MIGRATIONS) {
    const owner = item.id.split('/')[0] ?? '';
    blocks.set(owner, [...(blocks.get(owner) ?? []), item]);
  }
  const alternate = [...(blocks.get('platform') ?? []), ...order.flatMap((id) => blocks.get(id) ?? [])];
  expect(alternate).toHaveLength(MIGRATIONS.length);
  const db = await openLocalStore();
  try {
    await applyPGliteMigrations(db, alternate);
  } finally {
    await db.close();
  }
}, 60_000);

const PG_TYPE: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  text: 'text',
  integer: 'integer',
  numeric: 'numeric',
  boolean: 'boolean',
  'timestamp with time zone': 'timestamptz',
  date: 'date',
  jsonb: 'jsonb',
};

/**
 * Manifest column specs mirror the migrations (CLD-R-007): type, nullability, requiredOnInsert
 * (NOT NULL without default) and every `references` backed by a real foreign key. The Worker
 * validates synced rows with these specs, so drift here would let it accept rows devices reject.
 */
test('manifest column specs match the migrated schema', async () => {
  const db = await openLocalStore();
  try {
    await applyPGliteMigrations(db, MIGRATIONS);
    for (const table of MANIFESTS.flatMap((manifest) => manifest.tables)) {
      if (!table.columns) continue;
      const described = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table.name],
      );
      const byName = new Map(described.rows.map((row) => [row.column_name, row]));
      for (const [name, spec] of Object.entries(table.columns)) {
        const column = byName.get(name);
        const where = `${table.name}.${name}`;
        expect(column, where).toBeDefined();
        if (!column) continue;
        expect(PG_TYPE[column.data_type], where).toBe(spec.type);
        expect(column.is_nullable === 'YES', `${where} nullable`).toBe(spec.nullable);
        expect(
          column.is_nullable === 'NO' && column.column_default === null,
          `${where} requiredOnInsert`,
        ).toBe(spec.requiredOnInsert);
        if (spec.references) {
          const fk = await db.query(
            `SELECT 1 FROM information_schema.key_column_usage k
             JOIN information_schema.referential_constraints r
               ON r.constraint_name = k.constraint_name AND r.constraint_schema = k.constraint_schema
             JOIN information_schema.table_constraints t
               ON t.constraint_name = r.unique_constraint_name
               AND t.constraint_schema = r.unique_constraint_schema
             WHERE k.table_name = $1 AND k.column_name = $2 AND t.table_name = $3`,
            [table.name, name, spec.references.table],
          );
          expect(fk.rows.length, `${where} references ${spec.references.table}`).toBeGreaterThan(0);
        }
      }
    }
  } finally {
    await db.close();
  }
}, 60_000);

/** A manifest table without a migration breaks derived grants at startup (SWM-R-014). */
test('every manifest-declared table exists after the full migration list', async () => {
  const db = await openLocalStore();
  try {
    await applyPGliteMigrations(db, MIGRATIONS);
    const present = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(present.rows.map((row) => row.table_name));
    const missing = MANIFESTS.flatMap((manifest) =>
      manifest.tables
        .filter((table) => !names.has(table.name))
        .map((table) => `${manifest.id}:${table.name}`),
    );
    expect(missing).toEqual([]);
  } finally {
    await db.close();
  }
}, 60_000);
