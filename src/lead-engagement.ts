import type { PoolClient } from 'pg';
import { distributeProfileLeads } from './lead-distribution.js';

export const ENGAGEMENT_THRESHOLD_PERCENT = 80;
export const ENGAGEMENT_GATE_AFTER_SCANS = 3;

export function requiredReviewedForDeliveryCount(deliveredCount: number): number {
  return Math.ceil(Math.max(0, deliveredCount) * ENGAGEMENT_THRESHOLD_PERCENT / 100);
}

export function isEngagementEligible(completedDiscoveryScans: number, deliveredCount: number, reviewedCount: number): boolean {
  return completedDiscoveryScans < ENGAGEMENT_GATE_AFTER_SCANS || deliveredCount === 0
    || reviewedCount >= requiredReviewedForDeliveryCount(deliveredCount);
}

export type LeadEngagementProgress = {
  policyActive: boolean;
  completedDiscoveryScans: number;
  deliveredCount: number;
  reviewedCount: number;
  requiredReviewedCount: number;
  reviewedPercent: number;
  thresholdPercent: 80;
  pendingCount: number;
  gateState: 'first_two_scans' | 'eligible' | 'holding_third_scan_results' | 'awaiting_review';
  mayStartNewScan: boolean;
  mayReceivePendingLeads: boolean;
  nextAction: 'none' | 'review_leads' | 'deliver_pending';
};

/** SQL predicate shared by enqueue and claim. Job rows are still checked under profile locks before assignment. */
export function profileMaySearchSql(profileId: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM lead_distribution_settings gate_settings
    WHERE gate_settings.search_profile_id = ${profileId}
      AND (SELECT count(DISTINCT sr.search_job_id)::int
        FROM scan_runs sr JOIN search_jobs completed_job ON completed_job.id = sr.search_job_id
        WHERE sr.agent_connection_id = gate_settings.search_profile_id
          AND sr.received_at >= gate_settings.policy_activated_at
          AND sr.status IN ('success', 'partial')) >= ${ENGAGEMENT_GATE_AFTER_SCANS}
      AND (SELECT count(DISTINCT fp.normalized_url)::int
        FROM profile_lead_deliveries delivered JOIN facebook_posts fp ON fp.id = delivered.post_id
        WHERE delivered.search_profile_id = gate_settings.search_profile_id AND delivered.state = 'delivered'
          AND delivered.delivered_at >= gate_settings.policy_activated_at) > 0
      AND (SELECT count(DISTINCT review.normalized_url)::int
        FROM lead_engagement_reviews review JOIN profile_lead_deliveries delivered
          ON delivered.search_profile_id = review.search_profile_id AND delivered.post_id = review.post_id
        WHERE review.search_profile_id = gate_settings.search_profile_id AND delivered.state = 'delivered'
          AND delivered.delivered_at >= gate_settings.policy_activated_at
          AND review.reviewed_at >= gate_settings.policy_activated_at) * 5
        < (SELECT count(DISTINCT fp.normalized_url)::int * 4
          FROM profile_lead_deliveries delivered JOIN facebook_posts fp ON fp.id = delivered.post_id
          WHERE delivered.search_profile_id = gate_settings.search_profile_id AND delivered.state = 'delivered'
            AND delivered.delivered_at >= gate_settings.policy_activated_at)
  )`;
}

export async function getLeadEngagementProgress(client: PoolClient, userId: string, profileId: string): Promise<LeadEngagementProgress | null> {
  const { rows: [row] } = await client.query<{
    policy_active: boolean; completed_discovery_scans: number; delivered_count: number; reviewed_count: number; pending_count: number;
  }>(`SELECT settings.policy_activated_at IS NOT NULL AS policy_active,
      (SELECT count(DISTINCT sr.search_job_id)::int FROM scan_runs sr JOIN search_jobs j ON j.id = sr.search_job_id
        WHERE sr.agent_connection_id = ac.id AND sr.received_at >= settings.policy_activated_at AND sr.status IN ('success','partial')) AS completed_discovery_scans,
      (SELECT count(DISTINCT fp.normalized_url)::int FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id = d.post_id
        WHERE d.search_profile_id = ac.id AND d.state = 'delivered' AND d.delivered_at >= settings.policy_activated_at) AS delivered_count,
      (SELECT count(DISTINCT r.normalized_url)::int FROM lead_engagement_reviews r
        JOIN profile_lead_deliveries d ON d.search_profile_id = r.search_profile_id AND d.post_id = r.post_id
        WHERE r.search_profile_id = ac.id AND d.state = 'delivered' AND d.delivered_at >= settings.policy_activated_at
          AND r.reviewed_at >= settings.policy_activated_at) AS reviewed_count,
      (SELECT count(*)::int FROM profile_lead_deliveries d WHERE d.search_profile_id = ac.id AND d.state = 'queued') AS pending_count
    FROM agent_connections ac JOIN lead_distribution_settings settings ON settings.search_profile_id = ac.id
    WHERE ac.id = $1 AND ac.user_id = $2 AND ac.kind = 'search_profile' AND ac.status = 'active'`, [profileId, userId]);
  if (!row) return null;
  const completedDiscoveryScans = row.completed_discovery_scans ?? 0;
  const deliveredCount = row.delivered_count ?? 0;
  const reviewedCount = row.reviewed_count ?? 0;
  const requiredReviewedCount = requiredReviewedForDeliveryCount(deliveredCount);
  const eligible = isEngagementEligible(completedDiscoveryScans, deliveredCount, reviewedCount);
  const pendingCount = row.pending_count ?? 0;
  const gateState = completedDiscoveryScans < ENGAGEMENT_GATE_AFTER_SCANS
    ? 'first_two_scans'
    : eligible ? 'eligible'
      : completedDiscoveryScans === ENGAGEMENT_GATE_AFTER_SCANS ? 'holding_third_scan_results' : 'awaiting_review';
  return {
    policyActive: row.policy_active,
    completedDiscoveryScans,
    deliveredCount,
    reviewedCount,
    requiredReviewedCount,
    reviewedPercent: deliveredCount ? reviewedCount / deliveredCount * 100 : 0,
    thresholdPercent: 80,
    pendingCount,
    gateState,
    mayStartNewScan: eligible,
    mayReceivePendingLeads: eligible,
    nextAction: !eligible ? 'review_leads' : pendingCount ? 'deliver_pending' : 'none',
  };
}

/** Record a deliberate, authenticated action once and release one bounded pending batch if it opens the gate. */
export async function recordLeadReview(
  client: PoolClient,
  userId: string,
  postId: string,
  interaction: 'source_open' | 'manual_status',
): Promise<number> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows } = await client.query<{ profile_id: string; review_key: string }>(`SELECT ac.id AS profile_id, fp.normalized_url AS review_key
    FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
    JOIN lead_distribution_settings settings ON settings.search_profile_id = ac.id
    JOIN profile_lead_deliveries d ON d.search_profile_id = ac.id AND d.post_id = fp.id AND d.state = 'delivered'
    WHERE fp.id = $2 AND ac.user_id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active'
      AND d.delivered_at >= settings.policy_activated_at
    ORDER BY ac.id FOR UPDATE OF ac`, [userId, postId]);
  let delivered = 0;
  for (const profile of rows) {
    const inserted = await client.query(`INSERT INTO lead_engagement_reviews(search_profile_id, post_id, normalized_url, interaction)
      VALUES ($1, $2, $3, $4) ON CONFLICT (search_profile_id, normalized_url) DO NOTHING RETURNING search_profile_id`,
    [profile.profile_id, postId, profile.review_key, interaction]);
    if (!inserted.rowCount) continue;
    const progress = await getLeadEngagementProgress(client, userId, profile.profile_id);
    if (progress?.policyActive && progress.completedDiscoveryScans >= ENGAGEMENT_GATE_AFTER_SCANS
      && progress.reviewedCount >= progress.requiredReviewedCount && progress.pendingCount > 0) {
      const cycle = `unlock:${profile.review_key}`;
      const result = await distributeProfileLeads(client, userId, profile.profile_id, cycle);
      delivered += result?.delivered ?? 0;
      const afterDelivery = await getLeadEngagementProgress(client, userId, profile.profile_id);
      if (afterDelivery?.policyActive && !afterDelivery.mayStartNewScan) {
        await client.query(`UPDATE search_jobs SET status = 'cancelled', last_error = 'usage_gate', updated_at = now(), completed_at = now()
          WHERE search_profile_id = $1 AND status = 'pending'`, [profile.profile_id]);
      }
    }
  }
  return delivered;
}
