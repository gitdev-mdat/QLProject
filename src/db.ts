import 'dotenv/config';
import pg from 'pg';
import { assertDatabaseEnvironment, connectionOptions, poolMax } from './environment.js';

const { Pool } = pg;
const shared = globalThis as unknown as { qleadPool?: pg.Pool };

/**
 * One pool per process. When the worker routes run inside the Next.js server (production on Vercel), they share the
 * web app's pool (web/lib/server/db.ts uses the same global) instead of opening a second one.
 */
function createPool(): pg.Pool {
  assertDatabaseEnvironment(process.env.DATABASE_URL);
  const created = new Pool({ ...connectionOptions(process.env.DATABASE_URL!), max: poolMax(10), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  created.on('error', (err) => console.error('Unexpected idle database connection error:', err.message));
  return created;
}
export const pool: pg.Pool = shared.qleadPool ??= createPool();
