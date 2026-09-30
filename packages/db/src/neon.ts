import { Pool } from '@neondatabase/serverless';

/** Application login must be a non-owner role without BYPASSRLS or CREATEROLE. */
export function createNeonAppPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 4 });
}
