import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './db';
import { loginDevice } from '../login-device';

export const SESSION_COOKIE = 'qlead_session';
const SESSION_DAYS = 7;

export type SessionUser = { sessionId: string; userId: string; displayName: string; createdVia: string; leadMonitoringStatus: 'active' | 'suspended' };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** How a successful sign-in happened, for the Admin's login history. 'register' = the session created by signing up. */
export type LoginMethod = 'password' | 'register' | 'dev_quick_login';

/** New login-history rows are kept this long; older ones are deleted by later sign-ins. Sessions are not affected. */
export const LOGIN_EVENT_RETENTION_DAYS = 180;

/**
 * Creates a server-side session row and sets the HttpOnly cookie. Only the token hash is stored. Any session the
 * browser already carries is revoked first, so signing in as someone else never leaves the old identity usable.
 *
 * Callers invoke this only after authentication succeeded. The same statement records the sign-in in
 * web_login_events (method + coarse device facts parsed from the User-Agent, never the raw header, IP or token) and
 * prunes history rows past the retention window, so a sign-in costs one extra index write, not another round trip.
 */
export async function createSession(userId: string, createdVia: 'dev_quick_login' | 'password', method: LoginMethod = createdVia): Promise<void> {
  const previous = (await cookies()).get(SESSION_COOKIE)?.value;
  if (previous) await db().query(`WITH revoked AS (
      UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id
    ) DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM revoked)`, [hash(previous)]);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600_000);
  const device = loginDevice((await headers()).get('user-agent'));
  await db().query(`WITH session AS (
      INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, user_id, created_at
    ), pruned AS (
      DELETE FROM web_login_events WHERE created_at < now() - make_interval(days => $9)
    )
    INSERT INTO web_login_events(user_id, session_id, method, device, os, browser, created_at)
    SELECT user_id, id, $5, $6, $7, $8, created_at FROM session`,
    [userId, hash(token), createdVia, expires, method, device.device, device.os, device.browser, LOGIN_EVENT_RETENTION_DAYS]);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires });
}

/**
 * The signed-in user for this request. Memoised per server request with React cache(), so the /app layout and the
 * page it wraps share one lookup instead of querying web_sessions twice; nothing is shared between requests or users.
 */
export const getSession = cache(async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
  const { rows } = await db().query<{ id: string; user_id: string; display_name: string; created_via: string; lead_monitoring_status: 'active' | 'suspended' }>(
    `SELECT ws.id, ws.user_id, u.display_name, ws.created_via, u.lead_monitoring_status FROM web_sessions ws JOIN users u ON u.id = ws.user_id
     WHERE ws.token_hash = $1 AND ws.revoked_at IS NULL AND ws.expires_at > now()`, [hash(token)]);
  const row = rows[0];
  return row ? { sessionId: row.id, userId: row.user_id, displayName: row.display_name, createdVia: row.created_via, leadMonitoringStatus: row.lead_monitoring_status } : null;
});

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect('/dang-nhap');
  return session;
}

/** Revokes the current session server-side and clears the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db().query(`WITH revoked AS (
      UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id
    ) DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM revoked)`, [hash(token)]);
  store.delete(SESSION_COOKIE);
}
