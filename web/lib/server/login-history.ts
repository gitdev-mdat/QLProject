import 'server-only';
import { db } from './db';
import { LOGIN_HISTORY_PAGE_SIZE, type LoginHistoryEntry, type LoginHistoryFilter, type LoginHistoryPage } from '../login-history';

type Row = {
  id: string; created_at: Date; created_via: 'password' | 'dev_quick_login'; expires_at: Date; revoked_at: Date | null; active: boolean;
  method: LoginHistoryEntry['method'] | null; device: LoginHistoryEntry['device']; os: string | null; browser: string | null; recorded: boolean;
};

/**
 * One customer's successful sign-ins, newest first, for the Admin only (callers check Admin access first). Every
 * web_sessions row was created by a successful sign-in, so the sessions table is the history; web_login_events only
 * adds device facts for newer rows. The token hash column is never selected. Returns null for an unknown account.
 */
export async function getLoginHistory(userId: string, options: { page?: number; filter?: LoginHistoryFilter } = {}): Promise<LoginHistoryPage | null> {
  const filter: LoginHistoryFilter = options.filter === 'active' ? 'active' : 'all';
  const pageSize = LOGIN_HISTORY_PAGE_SIZE;
  const { rows: [summary] } = await db().query<{ exists: boolean; total: number; active_count: number; last_sign_in_at: Date | null }>(`SELECT
      EXISTS (SELECT 1 FROM users WHERE id = $1) AS exists,
      count(ws.id)::int AS total,
      count(ws.id) FILTER (WHERE ws.revoked_at IS NULL AND ws.expires_at > now())::int AS active_count,
      max(ws.created_at) AS last_sign_in_at
    FROM web_sessions ws WHERE ws.user_id = $1`, [userId]);
  if (!summary?.exists) return null;
  const filtered = filter === 'active' ? summary.active_count : summary.total;
  const pageCount = Math.max(1, Math.ceil(filtered / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pageCount);
  const { rows } = await db().query<Row>(`SELECT ws.id, ws.created_at, ws.created_via, ws.expires_at, ws.revoked_at,
      (ws.revoked_at IS NULL AND ws.expires_at > now()) AS active,
      e.method, e.device, e.os, e.browser, (e.id IS NOT NULL) AS recorded
    FROM web_sessions ws
    LEFT JOIN web_login_events e ON e.session_id = ws.id AND e.user_id = ws.user_id
    WHERE ws.user_id = $1 ${filter === 'active' ? 'AND ws.revoked_at IS NULL AND ws.expires_at > now()' : ''}
    ORDER BY ws.created_at DESC, ws.id DESC
    LIMIT $2 OFFSET $3`, [userId, pageSize, (page - 1) * pageSize]);
  return {
    userId, total: summary.total, activeCount: summary.active_count,
    lastSignInAt: summary.last_sign_in_at ? new Date(summary.last_sign_in_at).toISOString() : null,
    page, pageSize, filter,
    entries: rows.map(row => ({
      id: row.id,
      signedInAt: new Date(row.created_at).toISOString(),
      method: row.method ?? row.created_via,
      recorded: row.recorded,
      device: row.device, os: row.os, browser: row.browser,
      session: row.active ? 'active' : row.revoked_at ? 'revoked' : 'expired',
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    })),
  };
}
