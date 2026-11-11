import type { PoolClient } from 'pg';
import { sourceLinkedPostSql } from './lead-eligibility.js';
import { assessHotLead } from './hot-leads.js';
import { getLeadEngagementProgress } from './lead-engagement.js';

export const DEFAULT_MAX_LEADS_PER_SCAN = 10;
export const DEFAULT_LEAD_EXPIRY_DAYS = 30;

type Profile = { id: string; frequency_minutes: number; max_leads_per_scan: number; expiry_days: number };
export type DistributionCandidate = {
  id: string; normalized_url: string; title: string | null; content: string | null; summary_vi: string | null;
  author: string | null; published_at: Date | null; first_seen_at: Date; keywords: string[];
};

export type DistributionResult = {
  cycleKey: string;
  maxLeads: number;
  delivered: number;
  queued: number;
  expired: number;
  nextCycleAt: string;
  deliveredPostIds: string[];
  hotPostIds: string[];
};

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi');
}

/** Explainable, bounded ranking: customer intent match, post age, active opportunity, and usable source metadata. */
export function scoreDistributionCandidate(candidate: DistributionCandidate, now = Date.now()): number {
  const text = normalized(`${candidate.title ?? ''} ${candidate.content ?? ''} ${candidate.summary_vi ?? ''}`);
  const keywords = [...new Set((candidate.keywords ?? []).flatMap(k => normalized(k).match(/[a-z0-9]{3,}/g) ?? []))];
  const relevance = keywords.length ? Math.min(32, keywords.filter(k => text.includes(k)).length * 5) : 0;
  const published = candidate.published_at ? new Date(candidate.published_at).getTime() : Number.NaN;
  const ageDays = Number.isFinite(published) ? Math.max(0, (now - published) / 86_400_000) : Number.POSITIVE_INFINITY;
  const freshness = ageDays <= 1 ? 36 : ageDays <= 3 ? 28 : ageDays <= 7 ? 18 : ageDays <= 30 ? 7 : 0;
  const active = /\b(dang can|can tim|tuyen gap|van dang tuyen|sap khai truong|chuan bi khai truong|mo chi nhanh moi)\b/.test(text) ? 12 : 0;
  const quality = (candidate.author?.trim() ? 3 : 0) + (candidate.title?.trim() ? 4 : 0)
    + (candidate.content?.trim() ? 5 : 0) + (Number.isFinite(published) ? 4 : 0);
  return relevance + freshness + active + quality;
}

export function rankDistributionCandidates(candidates: DistributionCandidate[], limit: number, now = Date.now()): DistributionCandidate[] {
  return [...candidates].sort((a, b) => scoreDistributionCandidate(b, now) - scoreDistributionCandidate(a, now)
    || (new Date(b.published_at ?? b.first_seen_at).getTime() - new Date(a.published_at ?? a.first_seen_at).getTime())
    || a.id.localeCompare(b.id)).slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Make one bounded, idempotent delivery for a real logical scan or threshold-crossing review event. The profile row
 * lock serializes result/review transactions. Reusing the trigger key cannot create another distribution cycle.
 * This only exposes posts already stored in PostgreSQL; it never asks Muse to rescan.
 */
export async function distributeProfileLeads(client: PoolClient, userId: string, profileId: string, cycleKey: string): Promise<DistributionResult | null> {
  // One account lock prevents the same Facebook permalink from being delivered by two different profiles at once.
  const account = await client.query('SELECT id FROM users WHERE id = $1::uuid FOR UPDATE', [userId]);
  if (!account.rowCount) return null;
  await client.query(`INSERT INTO lead_distribution_settings(search_profile_id)
    SELECT id FROM agent_connections WHERE id = $1 AND user_id = $2 AND kind = 'search_profile'
    ON CONFLICT (search_profile_id) DO NOTHING`, [profileId, userId]);
  const { rows: [profile] } = await client.query<Profile>(`SELECT ac.id, sc.frequency_minutes,
      least(coalesce(settings.max_leads_per_scan, ${DEFAULT_MAX_LEADS_PER_SCAN}), ${DEFAULT_MAX_LEADS_PER_SCAN})::int AS max_leads_per_scan,
      coalesce(settings.expiry_days, ${DEFAULT_LEAD_EXPIRY_DAYS})::int AS expiry_days
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT frequency_minutes, enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    LEFT JOIN lead_distribution_settings settings ON settings.search_profile_id = ac.id
    WHERE ac.id = $1 AND ac.user_id = $2 AND ac.kind = 'search_profile' AND ac.status = 'active'
      AND sc.enabled AND u.lead_monitoring_status = 'active'
    FOR UPDATE OF ac`, [profileId, userId]);
  if (!profile) return null;

  const { rows: [slot] } = await client.query<{ next_cycle_at: Date }>(`SELECT
      to_timestamp((floor(extract(epoch FROM now()) / ($1::int * 60)) + 1) * ($1::int * 60)) AS next_cycle_at`,
  [Math.max(1, profile.frequency_minutes)]);
  if (!slot) return null;

  const created = await client.query(`INSERT INTO lead_distribution_cycles(search_profile_id, cycle_key, max_leads)
      VALUES ($1, $2, $3) ON CONFLICT (search_profile_id, cycle_key) DO NOTHING RETURNING id`,
  [profile.id, cycleKey, profile.max_leads_per_scan]);
  if (!created.rowCount) {
    const { rows: [counts] } = await client.query(`SELECT c.max_leads,
        (SELECT count(*)::int FROM profile_lead_deliveries WHERE search_profile_id = $1 AND state = 'queued') AS queued,
        (SELECT count(*)::int FROM profile_lead_deliveries WHERE delivery_cycle_id = c.id AND state = 'delivered') AS delivered,
        (SELECT count(*)::int FROM profile_lead_deliveries WHERE delivery_cycle_id = c.id AND state = 'expired') AS expired
      FROM lead_distribution_cycles c WHERE c.search_profile_id = $1 AND c.cycle_key = $2`, [profile.id, cycleKey]);
    return { cycleKey, maxLeads: counts?.max_leads ?? profile.max_leads_per_scan, delivered: counts?.delivered ?? 0,
      queued: counts?.queued ?? 0, expired: counts?.expired ?? 0, nextCycleAt: new Date(slot.next_cycle_at).toISOString(), deliveredPostIds: [], hotPostIds: [] };
  }
  const { rows: [cycle] } = await client.query<{ id: string }>(`SELECT id FROM lead_distribution_cycles WHERE search_profile_id = $1 AND cycle_key = $2`, [profile.id, cycleKey]);
  if (!cycle) throw new Error('lead distribution cycle insert did not persist');

  // Queue every newly discovered, source-linked candidate. A missing post time is retained and ranked lower; age is
  // measured from discovery for expiration so incomplete source timestamps cannot keep stale rows eligible forever.
  await client.query(`INSERT INTO profile_lead_deliveries(search_profile_id, post_id, state)
    SELECT fp.agent_connection_id, fp.id, 'queued' FROM facebook_posts fp
    WHERE fp.agent_connection_id = $1 AND ${sourceLinkedPostSql('fp')}
    ON CONFLICT (search_profile_id, post_id) DO NOTHING`, [profile.id]);
  const { rows: pendingAssessments } = await client.query<{ id: string; title: string | null; content: string | null; summary_vi: string | null; published_at: Date | null; keywords: string[]; description: string | null }>(`SELECT fp.id, fp.title, fp.content, fp.summary_vi, fp.published_at,
      sc.keywords, sc.description
    FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id = d.post_id
    JOIN LATERAL (SELECT keywords, description FROM scan_configs WHERE agent_connection_id = d.search_profile_id ORDER BY version DESC LIMIT 1) sc ON true
    WHERE d.search_profile_id = $1 AND d.state = 'queued' AND d.hot_assessed_at IS NULL AND ${sourceLinkedPostSql('fp')}
    ORDER BY d.queued_at, d.post_id`, [profile.id]);
  for (const candidate of pendingAssessments) {
    const assessment = assessHotLead(candidate, new Date());
    await client.query(`UPDATE profile_lead_deliveries SET hot_at_discovery=$3, hot_reason_vi=$4, hot_evidence=$5,
        hot_assessed_at=now(), hot_expires_at=$6
      WHERE search_profile_id=$1 AND post_id=$2 AND state='queued' AND hot_assessed_at IS NULL`,
    [profile.id, candidate.id, assessment.hot, assessment.reasonVi, assessment.evidence, assessment.expiresAt]);
  }
  const { rowCount: expired } = await client.query(`UPDATE profile_lead_deliveries d SET state = 'expired', expired_at = now(), exclusion_reason = 'lead_expired'
    FROM facebook_posts fp WHERE d.search_profile_id = $1 AND d.state = 'queued' AND fp.id = d.post_id
      AND coalesce(fp.published_at, fp.first_seen_at) < now() - make_interval(days => $2)`, [profile.id, profile.expiry_days]);

  // Permanently retire candidates that another profile or the legacy collector already delivered to this account.
  await client.query(`UPDATE profile_lead_deliveries d SET state = 'rejected', exclusion_reason = 'already_delivered_to_account'
    FROM facebook_posts fp WHERE d.search_profile_id = $1 AND d.state = 'queued' AND fp.id = d.post_id
      AND (EXISTS (SELECT 1 FROM profile_lead_deliveries prior JOIN facebook_posts p2 ON p2.id = prior.post_id
          WHERE prior.state = 'delivered' AND p2.normalized_url = fp.normalized_url
            AND prior.search_profile_id IN (SELECT id FROM agent_connections WHERE user_id = $2 AND kind = 'search_profile'))
        OR EXISTS (SELECT 1 FROM facebook_posts legacy JOIN agent_connections lac ON lac.id = legacy.agent_connection_id
          WHERE lac.user_id = $2 AND lac.kind = 'legacy_agent' AND legacy.normalized_url = fp.normalized_url))`, [profile.id, userId]);

  const engagement = await getLeadEngagementProgress(client, userId, profileId);
  if (engagement?.policyActive && !engagement.mayReceivePendingLeads) {
    const { rows: [held] } = await client.query<{ queued: number }>(`SELECT count(*)::int AS queued
      FROM profile_lead_deliveries WHERE search_profile_id=$1 AND state='queued'`, [profile.id]);
    return { cycleKey, maxLeads: profile.max_leads_per_scan, delivered: 0, queued: Number(held?.queued ?? 0),
      expired: expired ?? 0, nextCycleAt: new Date(slot.next_cycle_at).toISOString(), deliveredPostIds: [], hotPostIds: [] };
  }

  const { rows: [cycleState] } = await client.query<{ delivered: number; queued: number; expired: number }>(`SELECT
      (SELECT count(*)::int FROM profile_lead_deliveries WHERE delivery_cycle_id=$2 AND state='delivered') AS delivered,
      (SELECT count(*)::int FROM profile_lead_deliveries WHERE search_profile_id=$1 AND state='queued') AS queued,
      (SELECT count(*)::int FROM profile_lead_deliveries WHERE delivery_cycle_id=$2 AND state='expired') AS expired`, [profile.id, cycle.id]);
  const alreadyDelivered = Number(cycleState?.delivered ?? 0);
  const remaining = Math.max(0, profile.max_leads_per_scan - alreadyDelivered);
  const { rows: [hotQueue] } = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM profile_lead_deliveries
    WHERE search_profile_id=$1 AND state='queued' AND hot_at_discovery AND hot_expires_at > now()`, [profile.id]);
  // Keep ordinary batches idempotent. A newly available Hot Lead may fill unused slots in this cycle, but never exceed
  // its existing cap or displace something already delivered.
  if (!remaining || (alreadyDelivered > 0 && Number(hotQueue?.count ?? 0) === 0)) {
    return { cycleKey, maxLeads: profile.max_leads_per_scan, delivered: alreadyDelivered, queued: Number(cycleState?.queued ?? 0),
      expired: expired ?? 0, nextCycleAt: new Date(slot.next_cycle_at).toISOString(), deliveredPostIds: [], hotPostIds: [] };
  }

  const { rows: selected } = await client.query<{ id: string; is_hot: boolean }>(`SELECT fp.id,
      (d.hot_at_discovery AND d.hot_expires_at > now()) AS is_hot
    FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id = d.post_id
    JOIN LATERAL (SELECT keywords FROM facebook_post_search_configs psc JOIN scan_configs sc
      ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version
      WHERE psc.agent_connection_id = fp.agent_connection_id AND psc.normalized_url = fp.normalized_url
      ORDER BY psc.configuration_version DESC LIMIT 1) sc ON true
    CROSS JOIN LATERAL (SELECT lower(concat_ws(' ', fp.title, fp.content, fp.summary_vi)) AS searchable) txt
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE txt.searchable LIKE '%' || lower(btrim(keyword.value)) || '%')::int AS matches
      FROM jsonb_array_elements_text(coalesce(sc.keywords, '[]'::jsonb)) AS keyword(value)) rel
    WHERE d.search_profile_id = $1 AND d.state = 'queued' AND ${sourceLinkedPostSql('fp')}
      AND ($4::boolean = false OR (d.hot_at_discovery AND d.hot_expires_at > now()))
      AND NOT EXISTS (SELECT 1 FROM profile_lead_deliveries prior JOIN facebook_posts p2 ON p2.id = prior.post_id
        WHERE prior.state = 'delivered' AND p2.normalized_url = fp.normalized_url
          AND prior.search_profile_id IN (SELECT id FROM agent_connections WHERE user_id = $2 AND kind = 'search_profile'))
      AND NOT EXISTS (SELECT 1 FROM facebook_posts legacy JOIN agent_connections lac ON lac.id = legacy.agent_connection_id
        WHERE lac.user_id = $2 AND lac.kind = 'legacy_agent' AND legacy.normalized_url = fp.normalized_url)
    ORDER BY (d.hot_at_discovery AND d.hot_expires_at > now()) DESC,
      (CASE WHEN fp.published_at > now() THEN 0 WHEN fp.published_at >= now() - interval '1 day' THEN 36
        WHEN fp.published_at >= now() - interval '3 days' THEN 28 WHEN fp.published_at >= now() - interval '7 days' THEN 18
        WHEN fp.published_at >= now() - interval '30 days' THEN 7 ELSE 0 END
       + least(32, rel.matches * 5)
       + CASE WHEN txt.searchable ILIKE ANY(ARRAY['%đang cần%','%cần tìm%','%tuyển gấp%','%vẫn đang tuyển%','%sắp khai trương%','%chuẩn bị khai trương%','%mở chi nhánh mới%']) THEN 12 ELSE 0 END
       + CASE WHEN nullif(btrim(fp.author), '') IS NOT NULL THEN 3 ELSE 0 END
       + CASE WHEN nullif(btrim(fp.title), '') IS NOT NULL THEN 4 ELSE 0 END
       + CASE WHEN nullif(btrim(fp.content), '') IS NOT NULL THEN 5 ELSE 0 END
       + CASE WHEN fp.published_at IS NOT NULL THEN 4 ELSE 0 END) DESC,
      fp.published_at DESC NULLS LAST, fp.first_seen_at DESC, fp.id
    LIMIT $3`, [profile.id, userId, remaining, alreadyDelivered > 0]);

  if (selected.length) await client.query(`UPDATE profile_lead_deliveries SET state = 'delivered', delivery_cycle_id = $2, delivered_at = now()
    WHERE search_profile_id = $1 AND post_id = ANY($3::uuid[]) AND state = 'queued'`, [profile.id, cycle.id, selected.map(item => item.id)]);
  const { rows: [queued] } = await client.query(`SELECT count(*)::int AS count FROM profile_lead_deliveries WHERE search_profile_id = $1 AND state = 'queued'`, [profile.id]);
  return { cycleKey, maxLeads: profile.max_leads_per_scan, delivered: alreadyDelivered + selected.length, queued: queued.count,
    expired: expired ?? 0, nextCycleAt: new Date(slot.next_cycle_at).toISOString(), deliveredPostIds: selected.map(item => item.id),
    hotPostIds: selected.filter(item => item.is_hot).map(item => item.id) };
}
