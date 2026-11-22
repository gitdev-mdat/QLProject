import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Forgot password (migration 026).
 *
 * A reset link carries a random 32-byte token; only its SHA-256 hash is stored. A link:
 *   - works for RESET_RULES.linkMinutes after it was sent,
 *   - works once (consuming it is one conditional UPDATE, so two tabs submitting together cannot both win),
 *   - stops working when a newer link is sent or the password is changed.
 * A completed reset also signs the account out everywhere (all web sessions revoked, their push subscriptions removed).
 *
 * Callers never tell the browser whether an email has an account: createPasswordReset returns null for an unknown
 * email and for a throttled account alike, and the HTTP route answers the same way in every case.
 */
export const RESET_RULES = {
  /** How long a link works after it is sent. */
  linkMinutes: 30,
  /** Links sent per account per rolling hour; further requests are silently ignored. */
  perAccountPerHour: 3,
} as const;

type Queryable = Pick<Pool | PoolClient, 'query'>;

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Shape check before touching the database: 32 random bytes in base64url are 43 characters. */
export const isResetTokenShape = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

export type PasswordResetIssued = { token: string; email: string; displayName: string; expiresAt: Date };

/**
 * Issues a new reset link for a web account. Returns null when there is no account with this email, or the account
 * already received RESET_RULES.perAccountPerHour links in the last hour. Older unused links of the account stop working.
 */
export async function createPasswordReset(client: PoolClient, email: string, now = new Date()): Promise<PasswordResetIssued | null> {
  const { rows: [account] } = await client.query<{ user_id: string; email: string; display_name: string }>(
    `SELECT ua.user_id, ua.email, u.display_name FROM user_accounts ua JOIN users u ON u.id = ua.user_id
     WHERE ua.email = $1 FOR UPDATE OF ua`, [email.trim().toLowerCase()]);
  if (!account) return null;
  const { rows: [recent] } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM password_reset_tokens WHERE user_id = $1 AND created_at > $2::timestamptz - interval '1 hour'`,
    [account.user_id, now]);
  if ((recent?.count ?? 0) >= RESET_RULES.perAccountPerHour) return null;
  await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [account.user_id, now]);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + RESET_RULES.linkMinutes * 60_000);
  await client.query('INSERT INTO password_reset_tokens(user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [account.user_id, hashResetToken(token), now, expiresAt]);
  return { token, email: account.email, displayName: account.display_name, expiresAt };
}

/** Whether a link can still be used (read only; does not consume it). */
export async function isPasswordResetUsable(db: Queryable, token: string, now = new Date()): Promise<boolean> {
  if (!isResetTokenShape(token)) return false;
  const { rowCount } = await db.query(
    'SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2', [hashResetToken(token), now]);
  return Boolean(rowCount);
}

/**
 * Uses a link to set a new password. Run inside a transaction. Returns the user id, or null when the link is unknown,
 * expired, already used or replaced. On success every other open link and every web session of the account end.
 */
export async function consumePasswordReset(client: PoolClient, token: string, passwordHash: string, now = new Date()): Promise<string | null> {
  if (!isResetTokenShape(token)) return null;
  const { rows: [used] } = await client.query<{ user_id: string }>(
    `UPDATE password_reset_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id`,
    [hashResetToken(token), now]);
  if (!used) return null;
  await client.query('UPDATE user_accounts SET password_hash = $2 WHERE user_id = $1', [used.user_id, passwordHash]);
  await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [used.user_id, now]);
  await client.query(`WITH revoked AS (
      UPDATE web_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id
    ) DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM revoked)`, [used.user_id, now]);
  return used.user_id;
}
