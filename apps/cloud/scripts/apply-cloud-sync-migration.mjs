import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const steps = [
  ['platform/0001_platform', 'packages/db/migrations/0001_platform.sql'],
  ['platform/0002_modules', 'packages/db/migrations/0002_modules.sql'],
  ['platform/0003_swarm', 'packages/db/migrations/0003_swarm.sql'],
  ['platform/0004_receipt_time', 'packages/db/migrations/0004_receipt_time.sql'],
  ['core/0001_cloud_auth', 'modules/core/migrations/0001_cloud_auth.sql'],
  ['core/0002_cloud_sync', 'modules/core/migrations/0002_cloud_sync.sql'],
];

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function main() {
  const url = process.env.NEON_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_BINDING_MISSING');
  const loaded = await Promise.all(
    steps.map(async ([id, path]) => ({ id, path, sql: await readFile(resolve(root, path), 'utf8') })),
  );
  for (let i = 0; i < loaded.length; i += 1) {
    const [owner, sequence] = loaded[i].id.split('/');
    if (!new RegExp(`^${owner}/\\d{4}_[a-z0-9_]+$`).test(loaded[i].id)) throw new Error('MIGRATION_ID_INVALID');
    const expected = `${owner}/${String(i < 4 ? i + 1 : i - 3).padStart(4, '0')}_`;
    if (!loaded[i].id.startsWith(expected)) throw new Error('MIGRATION_ORDER_INVALID');
    if (i === 0 && owner !== 'platform') throw new Error('PLATFORM_MIGRATIONS_MUST_LEAD');
    if (!sequence) throw new Error('MIGRATION_SEQUENCE_INVALID');
  }
  const target = loaded.at(-1);
  if (target?.id !== 'core/0002_cloud_sync') throw new Error('UNEXPECTED_MIGRATION_TARGET');

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const tracking = await client.query("SELECT to_regclass('public.schema_migrations') AS tracking");
    if (!tracking.rows[0]?.tracking) throw new Error('MIGRATION_BASELINE_MISSING');
    const expectedApplied = loaded.slice(0, -1);
    for (const migration of expectedApplied) {
      const result = await client.query('SELECT checksum FROM schema_migrations WHERE id=$1', [migration.id]);
      if (result.rows[0]?.checksum !== checksum(migration.sql)) throw new Error('MIGRATION_BASELINE_CHECKSUM_MISMATCH');
    }

    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [target.id]);
      const found = await client.query('SELECT checksum FROM schema_migrations WHERE id=$1 FOR UPDATE', [target.id]);
      const targetChecksum = checksum(target.sql);
      if (found.rows[0]) {
        if (found.rows[0].checksum !== targetChecksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      } else {
        await client.query(target.sql);
        await client.query('INSERT INTO schema_migrations(id,checksum) VALUES ($1,$2)', [target.id, targetChecksum]);
      }
      await client.query('COMMIT');
      process.stdout.write(`${JSON.stringify({ status: 'PASS', migration: target.id, checksum: targetChecksum })}\n`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  // Provider error objects can include connection strings. Emit only a locally-authored code.
  const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'MIGRATION_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
});
