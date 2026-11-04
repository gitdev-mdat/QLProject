/**
 * Production (Supabase) database operations. Never touches the local Docker database except to READ the one local
 * admin's login row for `provision-admin`.
 *
 * Reads PROD_DATABASE_URL from .env.supabase (git-ignored) ??? never from DATABASE_URL ??? so a local shell cannot be
 * pointed at production by accident, and production cannot be pointed at local.
 *
 *   npx tsx ops/production-db.ts check            connection + server facts (no writes)
 *   npx tsx ops/production-db.ts migrate          apply migrations/*.sql not yet in schema_migrations, then harden
 *   npx tsx ops/production-db.ts harden           re-apply ops/supabase-harden.sql
 *   npx tsx ops/production-db.ts verify           schema + RLS + empty business data report (no writes)
 *   npx tsx ops/production-db.ts provision-admin  copy ONE local admin's email + scrypt hash (no plaintext) to a new prod user
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return out;
}
async function envFile(path: string): Promise<Record<string, string>> {
  try { return parseEnvFile(await readFile(resolve(path), 'utf8')); } catch { return {}; }
}
const hostOf = (url: string) => new URL(url).hostname.toLowerCase();
const mask = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || '5432'}${u.pathname}`; };

async function productionUrl(): Promise<string> {
  const url = (await envFile('.env.supabase')).PROD_DATABASE_URL;
  if (!url) throw new Error('PROD_DATABASE_URL is missing from .env.supabase.');
  const host = hostOf(url);
  if (LOOPBACK.has(host)) throw new Error('PROD_DATABASE_URL points at a loopback host; refusing.');
  if (!/(^|\.)supabase\.(co|com)$/.test(host)) throw new Error('PROD_DATABASE_URL is not a Supabase host; refusing.');
  const local = (await envFile('.env')).DATABASE_URL;
  if (local && hostOf(local) === host) throw new Error('PROD_DATABASE_URL equals the local database host; refusing.');
  return url;
}

function client(url: string): pg.Client {
  // Supabase requires TLS. PROD_DATABASE_CA_FILE (Supabase's CA from Database Settings) enables full verification.
  return new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/g, ''), ssl: sslOptions(), connectionTimeoutMillis: 10000 });
}
let caPem: string | undefined;
function sslOptions(): pg.ClientConfig['ssl'] { return caPem ? { ca: caPem, rejectUnauthorized: true } : { rejectUnauthorized: true }; }

const APP_TABLES_ALLOWED_ROWS = new Set(['schema_migrations', 'users', 'user_accounts', 'web_sessions']);

async function check(db: pg.Client) {
  const { rows: [info] } = await db.query(`SELECT current_database() AS database, current_user AS "user", split_part(version(), ' ', 2) AS version,
    (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_tables,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS supabase_roles,
    current_setting('ssl', true) AS ssl`);
  console.log(JSON.stringify({ target: mask(await productionUrl()), ...info, tls_verified: true }, null, 2));
}

async function migrate(db: pg.Client) {
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(resolve('migrations'))).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const name of files) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])).rowCount) continue;
    const sql = await readFile(resolve('migrations', name), 'utf8');
    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      await db.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
  }
  await harden(db);
}

async function harden(db: pg.Client) {
  await db.query(await readFile(resolve('ops', 'supabase-harden.sql'), 'utf8'));
  console.log('Hardening applied (RLS on, anon/authenticated revoked on public).');
}

async function verify(db: pg.Client) {
  const { rows: migrations } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  const expected = (await readdir(resolve('migrations'))).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();
  const { rows: tables } = await db.query<{ tablename: string; rls: boolean; anon_select: boolean }>(`SELECT t.tablename, c.relrowsecurity AS rls,
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN has_table_privilege('anon', format('public.%I', t.tablename), 'SELECT') ELSE false END AS anon_select
    FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = 'public'::regnamespace WHERE t.schemaname = 'public' ORDER BY t.tablename`);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.tablename] = (await db.query(`SELECT count(*)::int AS n FROM public.${pg.escapeIdentifier(t.tablename)}`)).rows[0].n;
  const nonEmptyBusiness = Object.entries(counts).filter(([name, n]) => n > 0 && !APP_TABLES_ALLOWED_ROWS.has(name));
  const { rows: [people] } = await db.query(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM user_accounts) AS accounts`).catch(() => ({ rows: [{}] }));
  console.log(JSON.stringify({
    migrations_applied: migrations.map(m => m.name), migrations_missing: expected.filter(n => !migrations.some(m => m.name === n)),
    tables: tables.map(t => ({ table: t.tablename, rows: counts[t.tablename], rls: t.rls, anon_can_select: t.anon_select })),
    business_data_empty: nonEmptyBusiness.length === 0, non_empty_business_tables: nonEmptyBusiness.map(([n]) => n), people,
  }, null, 2));
}

async function provisionAdmin(db: pg.Client) {
  const localUrl = (await envFile('.env')).DATABASE_URL;
  if (!localUrl || !LOOPBACK.has(hostOf(localUrl))) throw new Error('Local DATABASE_URL (.env) must be a loopback database.');
  const argId = process.argv.find(a => a.startsWith('--local-admin-id='))?.split('=')[1];
  const ids = (argId ?? (await envFile('web/.env.development.local')).QLEAD_ADMIN_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length !== 1) throw new Error('Exactly one local admin id is required (--local-admin-id=<uuid>).');
  const local = new pg.Client({ connectionString: localUrl });
  await local.connect();
  let source: { display_name: string; email: string; password_hash: string } | undefined;
  try {
    ({ rows: [source] } = await local.query('SELECT u.display_name, ua.email, ua.password_hash FROM users u JOIN user_accounts ua ON ua.user_id = u.id WHERE u.id = $1', [ids[0]]));
  } finally { await local.end(); }
  if (!source) throw new Error('The local admin has no email/password account row.');
  if (!source.password_hash.startsWith('scrypt$')) throw new Error('Unexpected password hash format.');
  try {
    await db.query('BEGIN');
    const existing = await db.query<{ user_id: string }>('SELECT user_id FROM user_accounts WHERE email = $1', [source.email]);
    let userId = existing.rows[0]?.user_id;
    if (!userId) {
      ({ rows: [{ id: userId }] } = await db.query<{ id: string }>('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [source.display_name]));
      // The hash (salted scrypt) is copied, never the password: the same login works, sessions and data stay separate.
      await db.query('INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, $2, $3, now())', [userId, source.email, source.password_hash]);
    }
    await db.query('COMMIT');
    const at = source.email.indexOf('@');
    console.log(JSON.stringify({ production_admin_user_id: userId, email: `${source.email.slice(0, 2)}***${source.email.slice(at)}`, created: !existing.rows[0],
      next: 'Set QLEAD_ADMIN_USER_IDS to production_admin_user_id in the Vercel Production environment only.' }, null, 2));
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
}

const command = process.argv[2];
const actions: Record<string, (db: pg.Client) => Promise<void>> = { check, migrate, harden, verify, 'provision-admin': provisionAdmin };
if (!command || !actions[command]) { console.error(`Usage: npx tsx ops/production-db.ts <${Object.keys(actions).join('|')}>`); process.exit(2); }
// Pinned to Supabase's public root CA (also set as DATABASE_CA_CERT on Vercel). Override with PROD_DATABASE_CA_FILE.
const caFile = (await envFile('.env.supabase')).PROD_DATABASE_CA_FILE ?? 'ops/supabase-root-2021-ca.pem';
caPem = await readFile(resolve(caFile), 'utf8');
const db = client(await productionUrl());
await db.connect();
try { await actions[command]!(db); }
catch (error: any) { console.error(`Failed: ${error?.code ?? ''} ${error?.message ?? error}`); process.exitCode = 1; }
finally { await db.end(); }
