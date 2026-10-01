import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Migration } from '@xyra/db';

export function loadMigrations(): readonly Migration[] {
  const text = readFileSync(join(process.cwd(), 'apps/sidecar/src/generated/migrations.ts'), 'utf8');
  const match = /export const MIGRATIONS: readonly Migration\[] = (\[[\s\S]*?\]);/.exec(text);
  if (!match) throw new Error('MIGRATIONS export not found in generated migrations');
  return JSON.parse(match[1]) as Migration[];
}
