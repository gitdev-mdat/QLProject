import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './db';

export const SESSION_COOKIE = 'qlead_session';
const SESSION_DAYS = 7;

export type SessionUser = { sessionId: string; userId: string; displayName: string; createdVia: string; leadMonitoringStatus: 'active' | 'suspended' };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Creates a server-side session row and sets the HttpOnly cookie. Only the token hash is stored. Any session the
 * browser already carries is revoked first, so signing in as someone else never leaves the old identity usable.
 */
export async function createSession(userId: string, createdVia: 'dev_quick_login' | 'password'): Promise<void> {
  const previous = (await cookies()).get(SESSION_COOKIE)?.value;
  if (previous) await db().query('UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hash(previous)]);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600_000);
  await db().query('INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, $3, $4)', [userId, hash(token), createdVia, expires]);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires });
}

export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
  const { rows } = await db().query<{ id: string; user_id: string; display_name: string; created_via: string; lead_monitoring_status: 'active' | 'suspended' }>(
    `SELECT ws.id, ws.user_id, u.display_name, ws.created_via, u.lead_monitoring_status FROM web_sessions ws JOIN users u ON u.id = ws.user_id
     WHERE ws.token_hash = $1 AND ws.revoked_at IS NULL AND ws.expires_at > now()`, [hash(token)]);
  const row = rows[0];
  return row ? { sessionId: row.id, userId: row.user_id, displayName: row.display_name, createdVia: row.created_via, leadMonitoringStatus: row.lead_monitoring_status } : null;
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect('/dang-nhap');
  return session;
}

/** Revokes the current session server-side and clears the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db().query('UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hash(token)]);
  store.delete(SESSION_COOKIE);
}
