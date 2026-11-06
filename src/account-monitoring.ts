import type { PoolClient } from 'pg';
import { normalizePublicReason, recordMonitoringNotification } from './account-notifications.js';

export type LeadMonitoringStatus = 'active' | 'suspended';
/**
 * reason: the Admin-only internal note (never shown to the customer).
 * publicReason: optional text the Admin explicitly publishes to the customer with a suspension; shown exactly as written.
 */
export type MonitoringMutation = { status: LeadMonitoringStatus; reason?: string | null; publicReason?: string | null };

/** Serializes account suspension against worker claims by locking the same user row claimJobs locks. */
export async function setLeadMonitoringStatus(client: PoolClient, userId: string, adminUserId: string, change: MonitoringMutation): Promise<{
  changed: boolean; userId: string; status: LeadMonitoringStatus; changedAt: string; changedByUserId: string | null;
  suspendedAt: string | null; suspendedByUserId: string | null; reason: string | null; publicReason: string | null; inFlightJobCount: number;
  /** Set only when this call changed the status: the customer notification it created, and its push outbox row if any. */
  notificationId: string | null; pushOutboxId: string | null;
} | null> {
  const { rows: [user] } = await client.query(`SELECT id, lead_monitoring_status, lead_monitoring_changed_at, lead_monitoring_changed_by_user_id,
      lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason, lead_monitoring_public_reason
    FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!user) return null;
  let current = user;
  let changed = false;
  let notification: { notificationId: string | null; pushOutboxId: string | null } = { notificationId: null, pushOutboxId: null };
  if (user.lead_monitoring_status !== change.status) {
    const { rows: [updated] } = change.status === 'suspended'
      ? await client.query(`UPDATE users SET lead_monitoring_status = 'suspended', lead_monitoring_changed_at = now(),
          lead_monitoring_changed_by_user_id = $2, lead_monitoring_suspended_at = now(), lead_monitoring_suspended_by_user_id = $2,
          lead_monitoring_reason = $3, lead_monitoring_public_reason = $4 WHERE id = $1 RETURNING id, lead_monitoring_status, lead_monitoring_changed_at,
          lead_monitoring_changed_by_user_id, lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason, lead_monitoring_public_reason`,
        [userId, adminUserId, change.reason ?? null, normalizePublicReason(change.publicReason)])
      : await client.query(`UPDATE users SET lead_monitoring_status = 'active', lead_monitoring_changed_at = now(),
          lead_monitoring_changed_by_user_id = $2 WHERE id = $1 RETURNING id, lead_monitoring_status, lead_monitoring_changed_at,
          lead_monitoring_changed_by_user_id, lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason, lead_monitoring_public_reason`, [userId, adminUserId]);
    current = updated;
    changed = true;
    notification = await recordMonitoringNotification(client, {
      userId, kind: change.status === 'suspended' ? 'lead_monitoring_suspended' : 'lead_monitoring_resumed', publicReason: updated.lead_monitoring_public_reason,
    });
  }
  const { rows: [inFlight] } = await client.query(`SELECT count(*)::int AS count FROM search_jobs j
    JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = $1 AND j.status = 'claimed' AND j.lease_expires_at >= now()`, [userId]);
  return {
    changed, userId: current.id, status: current.lead_monitoring_status, changedAt: new Date(current.lead_monitoring_changed_at).toISOString(),
    changedByUserId: current.lead_monitoring_changed_by_user_id,
    suspendedAt: current.lead_monitoring_suspended_at ? new Date(current.lead_monitoring_suspended_at).toISOString() : null,
    suspendedByUserId: current.lead_monitoring_suspended_by_user_id, reason: current.lead_monitoring_reason,
    publicReason: current.lead_monitoring_public_reason ?? null, inFlightJobCount: inFlight.count, ...notification,
  };
}
