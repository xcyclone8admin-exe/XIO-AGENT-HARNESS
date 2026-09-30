import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from '@neondatabase/serverless';

export interface Migration {
  readonly id: string;
  readonly module?: string;
  readonly sql: string;
  readonly checksum: string;
}

export function migration(id: string, sql: string): Migration {
  return { id, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

/**
 * The list is `platform/*` first, then each module's migrations as one contiguous block in the
 * generator's dependency order (ADR-0016). Module blocks are not lexically ordered, so ordering is
 * checked per module: gap-free sequence numbers from 0001, each module block appearing once.
 */
export function assertOrdered(migrations: readonly Migration[]): void {
  const lastSeq = new Map<string, number>();
  let current = '';
  for (const item of migrations) {
    const match = /^([a-z][a-z0-9-]*)\/(\d{4})_[a-z0-9_]+$/.exec(item.id);
    if (!match || match[1] === undefined || match[2] === undefined)
      throw new Error(`Migration id invalid: ${item.id}`);
    const [, owner, seqText] = match;
    if (owner !== current) {
      if (lastSeq.has(owner)) throw new Error(`Migration block for ${owner} is not contiguous: ${item.id}`);
      if (lastSeq.size === 0 && owner !== 'platform')
        throw new Error(`Platform migrations must come first: ${item.id}`);
      current = owner;
    }
    const seq = Number(seqText);
    if (seq !== (lastSeq.get(owner) ?? 0) + 1) throw new Error(`Migration sequence invalid: ${item.id}`);
    lastSeq.set(owner, seq);
    if (migration(item.id, item.sql).checksum !== item.checksum)
      throw new Error(`Migration checksum invalid: ${item.id}`);
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
