import 'server-only';
import { db } from './db';
import { setLeadMonitoringStatus } from '../../../src/account-monitoring';
import type { LeadMonitoringStatus } from '../../../src/account-monitoring';

export { setLeadMonitoringStatus };
export type { LeadMonitoringStatus };

export async function getLeadMonitoringStatus(userId: string): Promise<{ status: LeadMonitoringStatus; changedAt: string } | null> {
  const { rows: [row] } = await db().query<{ lead_monitoring_status: LeadMonitoringStatus; lead_monitoring_changed_at: Date }>(
    'SELECT lead_monitoring_status, lead_monitoring_changed_at FROM users WHERE id = $1', [userId]);
  return row ? { status: row.lead_monitoring_status, changedAt: row.lead_monitoring_changed_at.toISOString() } : null;
}

export type AdminUserMonitoring = {
  id: string; displayName: string; email: string | null; createdAt: string; status: LeadMonitoringStatus;
  changedAt: string; changedByUserId: string | null; suspendedAt: string | null; suspendedByUserId: string | null; reason: string | null;
  /** Text the Admin published to the customer with the latest suspension (separate from the internal note `reason`). */
  publicReason: string | null;
  profileCount: number; activeProfileCount: number; leadCount: number; scanCount: number; pendingJobCount: number; claimedJobCount: number;
  // Read-only display fields for /admin/users: enabled = the profile's own latest pause setting, independent of the account status.
  enabledProfileCount: number; lastScanAt: string | null; lastScanStatus: string | null; changedByName: string | null; suspendedByName: string | null;
};

const ADMIN_USER_SELECT = `SELECT u.id, u.display_name, ua.email, u.created_at, u.lead_monitoring_status, u.lead_monitoring_changed_at,
    u.lead_monitoring_changed_by_user_id, u.lead_monitoring_suspended_at, u.lead_monitoring_suspended_by_user_id, u.lead_monitoring_reason, u.lead_monitoring_public_reason,
    (SELECT count(*)::int FROM agent_connections ac WHERE ac.user_id = u.id AND ac.kind = 'search_profile') AS profile_count,
    (SELECT count(*)::int FROM agent_connections ac WHERE ac.user_id = u.id AND ac.kind = 'search_profile' AND ac.status = 'active') AS active_profile_count,
    (SELECT count(*)::int FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = u.id) AS lead_count,
    (SELECT count(*)::int FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id WHERE ac.user_id = u.id) AS scan_count,
    (SELECT count(*)::int FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = u.id AND j.status = 'pending') AS pending_job_count,
    (SELECT count(*)::int FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = u.id AND j.status = 'claimed') AS claimed_job_count,
    (SELECT count(*)::int FROM agent_connections ac JOIN LATERAL (SELECT enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
      WHERE ac.user_id = u.id AND ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled) AS enabled_profile_count,
    last_scan.scanned_at AS last_scan_at, last_scan.status AS last_scan_status,
    (SELECT display_name FROM users c WHERE c.id = u.lead_monitoring_changed_by_user_id) AS changed_by_name,
    (SELECT display_name FROM users s WHERE s.id = u.lead_monitoring_suspended_by_user_id) AS suspended_by_name
  FROM users u LEFT JOIN user_accounts ua ON ua.user_id = u.id
  LEFT JOIN LATERAL (SELECT sr.scanned_at, sr.status FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id
    WHERE ac.user_id = u.id ORDER BY sr.scanned_at DESC LIMIT 1) last_scan ON true`;

function toAdminUser(row: any): AdminUserMonitoring {
  return {
    id: row.id, displayName: row.display_name, email: row.email, createdAt: new Date(row.created_at).toISOString(),
    status: row.lead_monitoring_status, changedAt: new Date(row.lead_monitoring_changed_at).toISOString(),
    changedByUserId: row.lead_monitoring_changed_by_user_id, suspendedAt: row.lead_monitoring_suspended_at ? new Date(row.lead_monitoring_suspended_at).toISOString() : null,
    suspendedByUserId: row.lead_monitoring_suspended_by_user_id, reason: row.lead_monitoring_reason, publicReason: row.lead_monitoring_public_reason ?? null,
    profileCount: row.profile_count, activeProfileCount: row.active_profile_count, leadCount: row.lead_count, scanCount: row.scan_count,
    pendingJobCount: row.pending_job_count, claimedJobCount: row.claimed_job_count,
    enabledProfileCount: row.enabled_profile_count, lastScanAt: row.last_scan_at ? new Date(row.last_scan_at).toISOString() : null,
    lastScanStatus: row.last_scan_status ?? null, changedByName: row.changed_by_name ?? null, suspendedByName: row.suspended_by_name ?? null,
  };
}

export async function listAdminUsers(search: string, limit: number, offset: number): Promise<{ users: AdminUserMonitoring[]; total: number; limit: number; offset: number }> {
  const normalized = search.trim();
  const where = `($1 = '' OR strpos(lower(u.display_name), lower($1)) > 0 OR strpos(lower(coalesce(ua.email, '')), lower($1)) > 0 OR u.id::text = $1)`;
  const [{ rows: [count] }, { rows }] = await Promise.all([
    db().query<{ total: number }>(`SELECT count(*)::int AS total FROM users u LEFT JOIN user_accounts ua ON ua.user_id = u.id WHERE ${where}`, [normalized]),
    db().query(`${ADMIN_USER_SELECT} WHERE ${where} ORDER BY u.created_at DESC, u.id LIMIT $2 OFFSET $3`, [normalized, limit, offset]),
  ]);
  return { users: rows.map(toAdminUser), total: count.total, limit, offset };
}

export async function getAdminUserMonitoring(userId: string): Promise<(AdminUserMonitoring & { profiles: Array<Record<string, unknown>> }) | null> {
  const { rows: [row] } = await db().query(`${ADMIN_USER_SELECT} WHERE u.id = $1`, [userId]);
  if (!row) return null;
  const { rows: profiles } = await db().query(`SELECT ac.id, ac.name, ac.status AS profile_status, sc.enabled, sc.version, sc.frequency_minutes,
      sc.description, last_scan.scanned_at AS last_scan_at, lead_count.count AS lead_count
    FROM agent_connections ac
    JOIN LATERAL (SELECT version, enabled, frequency_minutes, description FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    LEFT JOIN LATERAL (SELECT max(scanned_at) AS scanned_at FROM scan_runs WHERE agent_connection_id = ac.id) last_scan ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS count FROM facebook_posts WHERE agent_connection_id = ac.id) lead_count ON true
    WHERE ac.user_id = $1 AND ac.kind = 'search_profile' ORDER BY ac.created_at`, [userId]);
  return { ...toAdminUser(row), profiles: profiles.map(profile => ({
    id: profile.id, name: profile.name, profileStatus: profile.profile_status, enabled: profile.enabled, version: profile.version,
    frequencyMinutes: profile.frequency_minutes, description: profile.description, lastScanAt: profile.last_scan_at ? new Date(profile.last_scan_at).toISOString() : null,
    leadCount: profile.lead_count,
  })) };
}
