import 'server-only';
import pg from 'pg';

const globalForPool = globalThis as unknown as { qleadPool?: pg.Pool };

/** One pool per server process (survives dev hot reloads). Reads DATABASE_URL from the web app's environment. */
export function db(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured for the web app.');
  globalForPool.qleadPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 });
  return globalForPool.qleadPool;
}
