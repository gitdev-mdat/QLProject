import 'server-only';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { allowLoginAttempt } from '../auth-rate-limit';
import { db } from './db';

/**
 * Customer accounts created through the web app (user_accounts, migration 010). A user without a row here
 * (CLI-created or DEV test users) cannot sign in with a password.
 */
const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const registerInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
  attribution: z.object({
    source: z.enum(['organic', 'blog', 'campaign', 'referral', 'direct', 'unknown']),
    campaign: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).nullable(),
    content: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable(),
  }).optional(),
}).strict();
export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
}).strict();

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compared against when the email is unknown, so both paths cost one scrypt.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

export async function registerAccount(input: z.infer<typeof registerInput>): Promise<{ ok: true; userId: string } | { ok: false; error: 'email_taken' }> {
  const passwordHash = await hashPassword(input.password);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query<{ id: string }>('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [input.name]);
    const inserted = await client.query('INSERT INTO user_accounts(user_id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING', [user.id, input.email, passwordHash]);
    if (!inserted.rowCount) { await client.query('ROLLBACK'); return { ok: false, error: 'email_taken' }; }
    if (input.attribution) await client.query(`UPDATE users SET first_touch_source = $2, first_touch_campaign = $3,
      first_touch_content = $4, first_touch_at = now() WHERE id = $1`, [user.id, input.attribution.source, input.attribution.campaign, input.attribution.content]);
    await client.query('COMMIT');
    return { ok: true, userId: user.id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function verifyLogin(input: z.infer<typeof loginInput>): Promise<string | null> {
  const { rows: [account] } = await db().query<{ user_id: string; password_hash: string }>('SELECT user_id, password_hash FROM user_accounts WHERE email = $1', [input.email]);
  const ok = await verifyPassword(input.password, account?.password_hash ?? await DUMMY_HASH);
  return account && ok ? account.user_id : null;
}

/**
 * Whether the signed-in user still has to finish onboarding: only web-registered accounts that have neither
 * completed it nor saved any search profile. DEV and CLI users have no account row and never qualify.
 */
export async function needsOnboarding(userId: string): Promise<boolean> {
  const { rows: [row] } = await db().query<{ pending: boolean }>(`SELECT (u.lead_monitoring_status = 'active' AND ua.onboarding_completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_connections ac WHERE ac.user_id = ua.user_id AND ac.kind = 'search_profile' AND ac.status = 'active')) AS pending
    FROM user_accounts ua JOIN users u ON u.id = ua.user_id WHERE ua.user_id = $1`, [userId]);
  return Boolean(row?.pending);
}
