import 'server-only';
import { db } from './db';

/**
 * DEV quick-login accounts come from DEV_QUICK_LOGIN_USERS (server env only), e.g.
 * "a:Test User A:<user uuid>,b:Test User B:<user uuid>". Ids must already exist; nothing is created here.
 */
export type DevUser = { key: string; label: string; userId: string; verify: () => Promise<boolean> };

export function devQuickLoginUsers(): DevUser[] {
  return (process.env.DEV_QUICK_LOGIN_USERS ?? '').split(',').map(entry => entry.trim()).filter(Boolean).flatMap(entry => {
    const [key, label, userId] = entry.split(':').map(part => part.trim());
    if (!key || !label || !userId || !/^[0-9a-f-]{36}$/i.test(userId)) return [];
    return [{ key, label, userId, verify: async () => Boolean((await db().query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) }];
  });
}
