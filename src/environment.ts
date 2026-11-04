/**
 * Environment isolation guard shared by the Fastify API, the CLI and the Next.js server.
 *
 * QLEAD_ENVIRONMENT=local       → DATABASE_URL must point at a loopback host (the Docker `muse_bridge` database).
 * QLEAD_ENVIRONMENT=production  → DATABASE_URL must NOT be loopback, and on Vercel only the Production deployment may use it.
 * Unset                         → treated as `local` off Vercel; refused on Vercel (every Vercel deployment must say what it is).
 *
 * Fails closed: a misconfigured process throws before its first query instead of writing to the wrong database.
 */
export type QleadEnvironment = 'local' | 'production';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function databaseHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { throw new Error('DATABASE_URL is not a valid connection URL.'); }
}

export function qleadEnvironment(env: NodeJS.ProcessEnv = process.env): QleadEnvironment {
  const value = (env.QLEAD_ENVIRONMENT ?? '').trim().toLowerCase();
  if (value === 'local' || value === 'production') return value;
  if (value) throw new Error(`QLEAD_ENVIRONMENT must be "local" or "production" (got an unknown value).`);
  if (env.VERCEL) throw new Error('QLEAD_ENVIRONMENT must be set explicitly on Vercel.');
  return 'local';
}

/** Throws when the configured database does not belong to this process's environment. Returns the environment. */
export function assertDatabaseEnvironment(url: string | undefined, env: NodeJS.ProcessEnv = process.env): QleadEnvironment {
  const environment = qleadEnvironment(env);
  if (!url) throw new Error('DATABASE_URL is not configured.');
  const host = databaseHost(url);
  const loopback = LOOPBACK.has(host);
  if (environment === 'local' && !loopback) {
    throw new Error('Refusing to start: QLEAD_ENVIRONMENT=local requires a loopback DATABASE_URL (the local Docker database).');
  }
  if (environment === 'production') {
    if (loopback) throw new Error('Refusing to start: QLEAD_ENVIRONMENT=production cannot use a loopback DATABASE_URL.');
    // Preview/Development deployments on Vercel must never reach the production database, even if a variable leaks into their scope.
    if (env.VERCEL && env.VERCEL_ENV !== 'production') {
      throw new Error('Refusing to start: the production database is only available to the Vercel Production deployment.');
    }
  }
  return environment;
}

/**
 * Connection settings for a pg Pool. When DATABASE_CA_CERT (PEM text, e.g. Supabase's root CA from Database Settings)
 * is set, TLS is fully verified against it; any sslmode in the URL is dropped because pg lets the URL override `ssl`.
 * Without it the URL decides (local Docker: no TLS).
 */
export function connectionOptions(url: string, env: NodeJS.ProcessEnv = process.env): { connectionString: string; ssl?: { ca: string; rejectUnauthorized: true } } {
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim();
  if (!ca) return { connectionString: url };
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('DATABASE_CA_CERT must be a PEM certificate.');
  const stripped = new URL(url);
  for (const key of ['sslmode', 'sslrootcert', 'uselibpqcompat']) stripped.searchParams.delete(key);
  return { connectionString: stripped.toString(), ssl: { ca, rejectUnauthorized: true } };
}

/** Pool size from DATABASE_POOL_MAX (1–20). Serverless deployments should use a small pool behind the Supabase pooler. */
export function poolMax(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DATABASE_POOL_MAX);
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : fallback;
}
