import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

/** Sidecar owns this instance in a worker thread; never expose its SQL interface to callers. */
export async function openLocalStore(dataDir: string = 'memory://'): Promise<PGlite> {
  return PGlite.create(dataDir, { extensions: { vector } });
}
