import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = [
  ['platform/0001_platform', 'packages/db/migrations/0001_platform.sql'],
  ['platform/0002_modules', 'packages/db/migrations/0002_modules.sql'],
  ['platform/0003_swarm', 'packages/db/migrations/0003_swarm.sql'],
  ['platform/0004_receipt_time', 'packages/db/migrations/0004_receipt_time.sql'],
  ['core/0001_cloud_auth', 'modules/core/migrations/0001_cloud_auth.sql'],
  ['core/0002_cloud_sync', 'modules/core/migrations/0002_cloud_sync.sql'],
];

async function main() {
  const url = process.env.NEON_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_BINDING_MISSING');
  const expected = await Promise.all(sources.map(async ([id, path]) => ({
    id,
    checksum: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'),
  })));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await pool.query("SELECT to_regclass('public.schema_migrations') AS tracking");
    if (!result.rows[0]?.tracking) {
      process.stdout.write(`${JSON.stringify({ status: 'EMPTY', schemaMigrations: false, expected })}\n`);
      return;
    }
    const rows = await pool.query('SELECT id,checksum FROM schema_migrations ORDER BY id');
    const applied = new Map(rows.rows.map((row) => [row.id, row.checksum]));
    const checks = expected.map(({ id, checksum }) => ({
      id,
      expected: checksum,
      applied: applied.get(id) ?? null,
      matches: applied.get(id) === checksum,
    }));
    process.stdout.write(`${JSON.stringify({ status: 'PRESENT', schemaMigrations: true, checks })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'MIGRATION_INSPECTION_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
});
