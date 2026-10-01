import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  ['platform/0001_platform', 'packages/db/migrations/0001_platform.sql'],
  ['platform/0002_modules', 'packages/db/migrations/0002_modules.sql'],
  ['platform/0003_swarm', 'packages/db/migrations/0003_swarm.sql'],
  ['platform/0004_receipt_time', 'packages/db/migrations/0004_receipt_time.sql'],
  ['core/0001_cloud_auth', 'modules/core/migrations/0001_cloud_auth.sql'],
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function main() {
  const url = process.env.NEON_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_BINDING_MISSING');
  const loaded = await Promise.all(migrations.map(async ([id, path]) => ({
    id,
    sql: await readFile(resolve(root, path), 'utf8'),
  })));
  let currentOwner = '';
  const owners = new Set();
  const sequence = new Map();
  for (const item of loaded) {
    const match = /^([a-z][a-z0-9-]*)\/(\d{4})_[a-z0-9_]+$/.exec(item.id);
    if (!match) throw new Error('MIGRATION_ID_INVALID');
    const [, owner, number] = match;
    if (owner !== currentOwner) {
      if (owners.has(owner)) throw new Error('MIGRATION_BLOCK_NONCONTIGUOUS');
      if (!currentOwner && owner !== 'platform') throw new Error('PLATFORM_MIGRATIONS_MUST_LEAD');
      owners.add(owner);
      currentOwner = owner;
    }
    const expected = (sequence.get(owner) ?? 0) + 1;
    if (Number(number) !== expected) throw new Error('MIGRATION_SEQUENCE_INVALID');
    sequence.set(owner, expected);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const syncAlready = await client.query(
      "SELECT 1 FROM schema_migrations WHERE id='core/0002_cloud_sync'",
    );
    if (syncAlready.rows.length) throw new Error('SYNC_MIGRATION_MUST_REMAIN_SEPARATE');

    const applied = [];
    for (const migration of loaded) {
      const checksum = sha256(migration.sql);
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migration.id]);
        const found = await client.query('SELECT checksum FROM schema_migrations WHERE id=$1 FOR UPDATE', [migration.id]);
        if (found.rows[0]) {
          if (found.rows[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
          applied.push({ id: migration.id, action: 'verified', checksum });
        } else {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations(id,checksum) VALUES ($1,$2)', [migration.id, checksum]);
          applied.push({ id: migration.id, action: 'applied', checksum });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    process.stdout.write(`${JSON.stringify({ status: 'PASS', applied })}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  // Do not surface provider exception text; Neon errors can contain connection details.
  const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'BASELINE_MIGRATION_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
});
