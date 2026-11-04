import type { PoolClient } from 'pg';

export type LeadMonitoringStatus = 'active' | 'suspended';
export type MonitoringMutation = { status: LeadMonitoringStatus; reason?: string | null };

/** Serializes account suspension against worker claims by locking the same user row claimJobs locks. */
export async function setLeadMonitoringStatus(client: PoolClient, userId: string, adminUserId: string, change: MonitoringMutation): Promise<{
  changed: boolean; userId: string; status: LeadMonitoringStatus; changedAt: string; changedByUserId: string | null;
  suspendedAt: string | null; suspendedByUserId: string | null; reason: string | null; inFlightJobCount: number;
} | null> {
  const { rows: [user] } = await client.query(`SELECT id, lead_monitoring_status, lead_monitoring_changed_at, lead_monitoring_changed_by_user_id,
      lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason
    FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!user) return null;
  let current = user;
  let changed = false;
  if (user.lead_monitoring_status !== change.status) {
    const { rows: [updated] } = change.status === 'suspended'
      ? await client.query(`UPDATE users SET lead_monitoring_status = 'suspended', lead_monitoring_changed_at = now(),
          lead_monitoring_changed_by_user_id = $2, lead_monitoring_suspended_at = now(), lead_monitoring_suspended_by_user_id = $2,
          lead_monitoring_reason = $3 WHERE id = $1 RETURNING id, lead_monitoring_status, lead_monitoring_changed_at,
          lead_monitoring_changed_by_user_id, lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason`, [userId, adminUserId, change.reason ?? null])
      : await client.query(`UPDATE users SET lead_monitoring_status = 'active', lead_monitoring_changed_at = now(),
          lead_monitoring_changed_by_user_id = $2 WHERE id = $1 RETURNING id, lead_monitoring_status, lead_monitoring_changed_at,
          lead_monitoring_changed_by_user_id, lead_monitoring_suspended_at, lead_monitoring_suspended_by_user_id, lead_monitoring_reason`, [userId, adminUserId]);
    current = updated;
    changed = true;
  }
  const { rows: [inFlight] } = await client.query(`SELECT count(*)::int AS count FROM search_jobs j
    JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = $1 AND j.status = 'claimed' AND j.lease_expires_at >= now()`, [userId]);
  return {
    changed, userId: current.id, status: current.lead_monitoring_status, changedAt: new Date(current.lead_monitoring_changed_at).toISOString(),
    changedByUserId: current.lead_monitoring_changed_by_user_id,
    suspendedAt: current.lead_monitoring_suspended_at ? new Date(current.lead_monitoring_suspended_at).toISOString() : null,
    suspendedByUserId: current.lead_monitoring_suspended_by_user_id, reason: current.lead_monitoring_reason, inFlightJobCount: inFlight.count,
  };
}
