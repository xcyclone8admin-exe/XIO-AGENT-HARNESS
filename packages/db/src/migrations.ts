import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from '@neondatabase/serverless';

export interface Migration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
}

export function migration(id: string, sql: string): Migration {
  return { id, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = '';
  for (const item of migrations) {
    if (!/^[a-z][a-z0-9-]*\/\d{4}_[a-z0-9_]+$/.test(item.id) || item.id <= previous) {
      throw new Error(`Migration order or id invalid: ${item.id}`);
    }
    if (migration(item.id, item.sql).checksum !== item.checksum)
      throw new Error(`Migration checksum invalid: ${item.id}`);
    previous = item.id;
  }
}

const CREATE_TRACKING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Migration SQL is read and checksummed before entering a transaction. No I/O occurs inside it. */
export async function applyPGliteMigrations(db: PGlite, migrations: readonly Migration[]): Promise<void> {
  assertOrdered(migrations);
  await db.exec(CREATE_TRACKING);
  for (const item of migrations) {
    await db.transaction(async (tx) => {
      const found = await tx.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        [item.id],
      );
      if (found.rows[0]) {
        if (found.rows[0].checksum !== item.checksum)
          throw new Error(`Applied migration changed: ${item.id}`);
        return;
      }
      await tx.exec(item.sql);
      await tx.query('INSERT INTO schema_migrations(id, checksum) VALUES ($1, $2)', [item.id, item.checksum]);
    });
  }
}

/** The caller supplies a dedicated owner connection, never the xyra_app login. */
export async function applyNeonMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<void> {
  assertOrdered(migrations);
  await client.query(CREATE_TRACKING);
  for (const item of migrations) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [item.id]);
      const found = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1 FOR UPDATE',
        [item.id],
      );
      if (found.rows[0]) {
        if (found.rows[0].checksum !== item.checksum)
          throw new Error(`Applied migration changed: ${item.id}`);
      } else {
        await client.query(item.sql);
        await client.query('INSERT INTO schema_migrations(id, checksum) VALUES ($1, $2)', [
          item.id,
          item.checksum,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}
