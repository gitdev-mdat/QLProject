import 'server-only';
import pg from 'pg';
import { assertDatabaseEnvironment, connectionOptions, poolMax } from '../../../src/environment';

const globalForPool = globalThis as unknown as { qleadPool?: pg.Pool };

/**
 * One pool per server process (survives dev hot reloads; shared with the worker routes from ../src). Reads DATABASE_URL
 * from the web app's environment and refuses a database that does not belong to QLEAD_ENVIRONMENT (src/environment.ts),
 * e.g. a Preview deployment reaching production.
 */
export function db(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured for the web app.');
  if (!globalForPool.qleadPool) {
    assertDatabaseEnvironment(process.env.DATABASE_URL);
    globalForPool.qleadPool = new pg.Pool({ ...connectionOptions(process.env.DATABASE_URL), max: poolMax(5), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  }
  return globalForPool.qleadPool;
}
