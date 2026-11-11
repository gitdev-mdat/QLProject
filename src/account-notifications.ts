import type { PoolClient, Pool } from 'pg';

/**
 * Customer-visible account notifications: "what happened" records shown in the in-app notification center and, when the
 * customer turned Web Push on, delivered through the existing push outbox. They are written only from a real Admin state
 * change, inside the same transaction that holds the users row lock, so retries and re-renders never add rows.
 */
export type AccountNotificationKind = 'lead_monitoring_suspended' | 'lead_monitoring_resumed';

export type AccountNotification = {
  id: string;
  kind: AccountNotificationKind;
  /** Only the reason an Admin explicitly published for this event; absent otherwise. Never the internal note. */
  publicReason?: string;
  createdAt: string;
  read: boolean;
};

/** Rows kept per account; older ones are pruned when a new one is written. */
export const NOTIFICATION_HISTORY_LIMIT = 50;
/** Rows returned to the notification center. */
export const NOTIFICATION_PAGE_SIZE = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The single current-origin subscription rule shared with new-lead pushes (qlead.vn first, then the newest origin). */
const CURRENT_ORIGIN_SUBSCRIPTION = `
  (ps.expiration_time IS NULL OR ps.expiration_time > now())
  AND ws.revoked_at IS NULL AND ws.expires_at > now()
  AND ps.origin = (
    SELECT candidate.origin FROM push_subscriptions candidate
    JOIN web_sessions cws ON cws.id = candidate.session_id AND cws.user_id = candidate.user_id
    WHERE candidate.user_id = ps.user_id
      AND (candidate.expiration_time IS NULL OR candidate.expiration_time > now())
      AND cws.revoked_at IS NULL AND cws.expires_at > now()
    ORDER BY CASE WHEN candidate.origin = 'https://qlead.vn' THEN 0 ELSE 1 END, candidate.created_at DESC, candidate.id DESC
    LIMIT 1
  )`;

/**
 * Records the notification for a monitoring change that was just applied on the locked users row (call it only when the
 * status really changed). Idempotent per change: the key is the row's lead_monitoring_changed_at. Returns the push outbox
 * id when at least one of the customer's devices should receive it.
 */
export async function recordMonitoringNotification(client: PoolClient, input: { userId: string; kind: AccountNotificationKind; publicReason: string | null }): Promise<{ notificationId: string | null; pushOutboxId: string | null }> {
  const publicReason = input.kind === 'lead_monitoring_suspended' ? normalizePublicReason(input.publicReason) : null;
  const { rows: [created] } = await client.query<{ id: string }>(`
    INSERT INTO account_notifications (user_id, kind, public_reason, event_key)
    SELECT u.id, $2, $3, $2 || ':' || u.id || ':' || floor(extract(epoch FROM u.lead_monitoring_changed_at) * 1000000)::bigint
    FROM users u WHERE u.id = $1
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id`, [input.userId, input.kind, publicReason]);
  if (!created) return { notificationId: null, pushOutboxId: null };
  await client.query(`DELETE FROM account_notifications WHERE user_id = $1 AND id NOT IN (
    SELECT id FROM account_notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2)`, [input.userId, NOTIFICATION_HISTORY_LIMIT]);
  const { rows: [outbox] } = await client.query<{ id: string }>(`
    WITH inserted_event AS (
      INSERT INTO push_notification_outbox (account_notification_id, user_id, lead_count, preference_revision, monitoring_changed_at, notification_kind)
      SELECT $1, u.id, 0, pref.revision, u.lead_monitoring_changed_at, 'account_status'
      FROM users u
      JOIN push_notification_preferences pref ON pref.user_id = u.id AND pref.enabled = true
      WHERE u.id = $2 AND EXISTS (
        SELECT 1 FROM push_subscriptions ps JOIN web_sessions ws ON ws.id = ps.session_id AND ws.user_id = ps.user_id
        WHERE ps.user_id = u.id AND ${CURRENT_ORIGIN_SUBSCRIPTION})
      ON CONFLICT (account_notification_id) DO NOTHING
      RETURNING id, user_id
    ), created_deliveries AS (
      INSERT INTO push_notification_deliveries (outbox_id, subscription_id, session_id)
      SELECT e.id, ps.id, ps.session_id FROM inserted_event e
      JOIN push_subscriptions ps ON ps.user_id = e.user_id
      JOIN web_sessions ws ON ws.id = ps.session_id AND ws.user_id = ps.user_id
      WHERE ${CURRENT_ORIGIN_SUBSCRIPTION}
      ON CONFLICT (outbox_id, subscription_id) DO NOTHING
      RETURNING outbox_id
    )
    SELECT e.id FROM inserted_event e WHERE EXISTS (SELECT 1 FROM created_deliveries) LIMIT 1`, [created.id, input.userId]);
  return { notificationId: created.id, pushOutboxId: outbox?.id ?? null };
}

/** Trims and collapses an Admin-entered public reason; empty means "no public reason". Line breaks are kept as written. */
export function normalizePublicReason(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text ? text.slice(0, 500) : null;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** The signed-in account's own notifications only (the caller passes the session's user id). */
export async function listAccountNotifications(db: Queryable, userId: string): Promise<{ items: AccountNotification[]; unread: number }> {
  const [{ rows }, unread] = await Promise.all([
    db.query<{ id: string; kind: AccountNotificationKind; public_reason: string | null; created_at: Date; read_at: Date | null }>(`
      SELECT id, kind, public_reason, created_at, read_at FROM account_notifications
      WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, NOTIFICATION_PAGE_SIZE]),
    countUnreadNotifications(db, userId),
  ]);
  return {
    unread,
    items: rows.map(row => ({
      id: row.id, kind: row.kind, createdAt: row.created_at.toISOString(), read: row.read_at !== null,
      ...(row.kind === 'lead_monitoring_suspended' && row.public_reason ? { publicReason: row.public_reason } : {}),
    })),
  };
}

export async function countUnreadNotifications(db: Queryable, userId: string): Promise<number> {
  const { rows: [row] } = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM account_notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return row?.count ?? 0;
}

/** Marks only the given notifications of this account as read (ids of other accounts are ignored). Returns the new unread count. */
export async function markNotificationsRead(db: Queryable, userId: string, ids: string[]): Promise<number> {
  const valid = [...new Set(ids.filter(id => UUID.test(id)))].slice(0, NOTIFICATION_PAGE_SIZE);
  if (valid.length) await db.query('UPDATE account_notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [userId, valid]);
  return countUnreadNotifications(db, userId);
}
