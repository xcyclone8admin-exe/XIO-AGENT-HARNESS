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
