import 'server-only';
import type { PoolClient } from 'pg';
import { toLeadRecord, type StoredFacebookPost } from '../../../src/lead-data';
import { distributeProfileLeads } from '../../../src/lead-distribution';
import type { HotLeadAssessment, Lead, LeadSource } from '../lead-source';
import { compareLeadByPostedAt } from '../lead-order';
import { completeLeadMetadataSql, sourceLinkedPostSql } from '../../../src/lead-eligibility';
import { db } from './db';
import { quietHoursState } from '../../../src/quiet-hours';

/**
 * Tenant scoping: every query joins agent_connections and filters on its user_id, so a user only ever reads
 * posts collected by their own agents. Same columns as the agent API's GET /api/agent/posts.
 */
const POST_SELECT = `SELECT fp.id, fp.author, fp.title, fp.content, fp.summary_vi, fp.published_at, fp.original_url, fp.normalized_url,
    fp.first_seen_at AS discovered_at, (SELECT min(d.delivered_at) FROM profile_lead_deliveries d WHERE d.post_id = fp.id AND d.state = 'delivered') AS delivered_at,
    fp.source_type, fp.collected_via, fp.platform, ac.name AS agent_name,
    (SELECT jsonb_agg(jsonb_build_object('profileId', d.search_profile_id, 'status',
        CASE WHEN d.hot_at_discovery AND d.hot_expires_at > now() THEN 'hot' WHEN d.hot_at_discovery THEN 'historical' ELSE 'standard' END,
        'reasonVi', d.hot_reason_vi, 'evidence', d.hot_evidence,
        'publishedAt', fp.published_at, 'assessedAt', d.hot_assessed_at, 'expiresAt', d.hot_expires_at)
      ORDER BY d.search_profile_id)
      FROM profile_lead_deliveries d WHERE d.post_id=fp.id AND d.state='delivered') AS hot_assessments,
    ac.id AS connection_id, ac.kind AS connection_kind,
    COALESCE(jsonb_agg(jsonb_build_object('version',sc.version,'enabled',sc.enabled,'keywords',sc.keywords,
      'location',sc.location,'sources',sc.sources,'frequency_minutes',sc.frequency_minutes)
      ORDER BY sc.version DESC) FILTER (WHERE sc.version IS NOT NULL), '[]'::jsonb) AS search_configurations
  FROM facebook_posts fp
  JOIN agent_connections ac ON ac.id = fp.agent_connection_id
  LEFT JOIN facebook_post_search_configs psc ON psc.agent_connection_id = fp.agent_connection_id AND psc.normalized_url = fp.normalized_url
  LEFT JOIN scan_configs sc ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUP_BY = 'GROUP BY fp.id, ac.id';

type Row = StoredFacebookPost & { id: string; normalized_url: string; connection_id: string; connection_kind: 'legacy_agent' | 'search_profile'; hot_assessments?: HotLeadAssessment[] | null };

function sourceOf(row: Row): LeadSource {
  const discoveredAt = row.discovered_at ? new Date(row.discovered_at).toISOString() : null;
  if (row.connection_kind !== 'search_profile') return { kind: 'legacy', discoveredAt };
  // search_configurations is ordered newest version first; the last entry is the version that first found the post.
  const config = row.search_configurations?.at(-1);
  return { kind: 'profile', profileId: row.connection_id, profileName: row.agent_name ?? '', version: config?.version ?? null, keywords: config?.keywords ?? [], location: config?.location ?? null, discoveredAt };
}

/** A repeated Facebook URL may first be discovered without a post time; prefer a known original timestamp. */
function originalPostTime(rows: Row[]): string | null {
  const dated = rows.filter(row => row.published_at && Number.isFinite(new Date(row.published_at).getTime()))
    .sort((x, y) => x.id.localeCompare(y.id))[0];
  return dated ? toLeadRecord(dated).published_at : null;
}

const time = (row: Row) => (row.discovered_at ? new Date(row.discovered_at).getTime() : Number.POSITIVE_INFINITY);

/**
 * Each search profile stores its own copy of a post, so the same Facebook URL found by two profiles is two rows.
 * They are shown as one lead (the earliest row, which owns status and notes) listing every search that found it.
 */
function groupByPost(rows: Row[]): Lead[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.normalized_url, [...(groups.get(row.normalized_url) ?? []), row]);
  return [...groups.values()].map(group => {
    const sorted = [...group].sort((x, y) => time(x) - time(y) || x.id.localeCompare(y.id));
    const firstValue = (field: 'author' | 'title' | 'content' | 'summary_vi') => sorted.find(row => row[field]?.trim())?.[field] ?? null;
    const record = toLeadRecord({ ...sorted[0], author: firstValue('author'), title: firstValue('title'), content: firstValue('content'), summary_vi: firstValue('summary_vi'), published_at: originalPostTime(group) });
    const deliveredAt = sorted.map(row => row.delivered_at).filter(Boolean).map(value => new Date(value!).toISOString()).sort()[0] ?? null;
    const hotAssessments = sorted.flatMap(row => row.hot_assessments ?? []);
    const uniqueAssessments = [...new Map(hotAssessments.map(assessment => [assessment.profileId, assessment])).values()];
    return { ...record, agent_name: null, sources: sorted.map(sourceOf), deliveredAt, hotAssessments: uniqueAssessments,
      eligibility: { basis: 'source_linked_search' as const, relevance: 'selected_by_search' as const, independentlyVerified: false as const } };
  });
}

/**
 * Which leads a list request covers. `profile`: leads at least one of whose rows was stored by that search profile;
 * the profile must belong to the same user (checked in SQL, so another user's id simply matches nothing). `legacy`:
 * leads with a row from an older integration. Every other source of the same Facebook post is still returned, so a
 * post found by two searches shows both and counts once.
 */
export type LeadScope = { kind: 'all' } | { kind: 'profile'; profileId: string } | { kind: 'legacy' };

/** Newest leads in scope, plus how many leads the scope holds in total (before the limit). */
export type LeadPage = { leads: Lead[]; total: number; delivery: LeadDistributionSummary };

export type LeadDistributionSummary = {
  status: 'ready' | 'searching' | 'paused' | 'suspended' | 'worker_unavailable';
  maxLeadsPerCycle: number;
  deliveredThisCycle: number;
  queued: number;
  nextCycleAt: string | null;
  workerClaimed: boolean;
  currentSearchStatus: 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | null;
  worker: { configuredActive: boolean; lastAuthenticatedAt: string | null; lastClaimAt: string | null; connectionVerifiedAt: string | null };
  quietHours: ReturnType<typeof quietHoursState>;
};

/** Upper bound for one scoped list. A single search profile is far below this; the total says when it is not. */
export const SCOPED_LEAD_LIMIT = 2000;

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function deliverWaitingLeads(userId: string, scope: LeadScope): Promise<void> {
  await withTx(async client => {
    const params: unknown[] = [userId];
    const filter = scope.kind === 'profile' ? 'AND ac.id = $2 AND ac.kind = \'search_profile\'' : scope.kind === 'legacy' ? 'AND false' : "AND ac.kind = 'search_profile'";
    if (scope.kind === 'profile') params.push(scope.profileId);
    const { rows } = await client.query<{ id: string }>(`SELECT ac.id FROM agent_connections ac JOIN users u ON u.id = ac.user_id
      JOIN LATERAL (SELECT enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
      WHERE ac.user_id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled AND u.lead_monitoring_status = 'active' ${filter}
      ORDER BY ac.id`, params);
    for (const profile of rows) await distributeProfileLeads(client, userId, profile.id);
  });
}

async function deliverySummary(userId: string, scope: LeadScope): Promise<LeadDistributionSummary> {
  const params: unknown[] = [userId];
  let filter = '';
  if (scope.kind === 'profile') { params.push(scope.profileId); filter = 'AND ac.id = $2'; }
  if (scope.kind === 'legacy') filter = "AND ac.kind <> 'search_profile'";
  const { rows: [row] } = await db().query(`SELECT
      coalesce(sum(settings.max_leads_per_scan), 0)::int AS max_leads_per_cycle,
      coalesce(sum(CASE WHEN c.cycle_key = floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60))::bigint::text THEN
        (SELECT count(*) FROM profile_lead_deliveries d WHERE d.search_profile_id = ac.id AND d.delivery_cycle_id = c.id AND d.state = 'delivered') ELSE 0 END), 0)::int AS delivered_this_cycle,
      coalesce(sum((SELECT count(*) FROM profile_lead_deliveries d WHERE d.search_profile_id = ac.id AND d.state = 'queued')), 0)::int AS queued,
      min(to_timestamp((floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60)) + 1) * sc.frequency_minutes * 60)) AS next_cycle_at,
      bool_or(j.status = 'claimed' AND j.lease_expires_at > now()) AS worker_claimed,
      bool_or(j.status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization')) AS searching,
      bool_or((j.status = 'claimed' AND j.lease_expires_at <= now()) OR (j.status = 'pending' AND j.attempts > 0)) AS retrying,
      bool_or(j.status = 'blocked' AND j.last_error = 'no_authorized_worker') AS worker_unavailable,
      bool_or(NOT sc.enabled) AS paused,
      bool_or(u.lead_monitoring_status <> 'active') AS suspended,
      bool_or(j.status = 'failed') AS latest_failed,
      bool_or(j.status = 'completed') AS latest_completed
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT enabled, frequency_minutes FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    LEFT JOIN lead_distribution_settings settings ON settings.search_profile_id = ac.id
    LEFT JOIN LATERAL (SELECT status, lease_expires_at, attempts, last_error FROM search_jobs WHERE search_profile_id = ac.id ORDER BY created_at DESC LIMIT 1) j ON true
    LEFT JOIN LATERAL (SELECT id, cycle_key FROM lead_distribution_cycles WHERE search_profile_id = ac.id ORDER BY created_at DESC LIMIT 1) c ON true
    WHERE ac.user_id = $1 ${filter}`, params);
  const { rows: [worker] } = await db().query(`SELECT bool_or(status = 'active' AND credential_status = 'active') AS configured_active,
      max(last_seen_at) AS last_authenticated_at, max(last_claim_at) AS last_claim_at, max(connection_verified_at) AS connection_verified_at
    FROM muse_workers WHERE status = 'active' AND credential_status = 'active'`);
  const searching = Boolean(row?.searching);
  const status = row?.suspended ? 'suspended' : row?.paused ? 'paused' : row?.worker_unavailable ? 'worker_unavailable' : searching ? 'searching' : 'ready';
  return { status, maxLeadsPerCycle: row?.max_leads_per_cycle ?? 0, deliveredThisCycle: row?.delivered_this_cycle ?? 0,
    queued: row?.queued ?? 0, nextCycleAt: row?.next_cycle_at ? new Date(row.next_cycle_at).toISOString() : null,
    workerClaimed: Boolean(row?.worker_claimed), currentSearchStatus: row?.worker_claimed ? 'running'
      : row?.retrying ? 'retrying' : searching ? 'queued' : row?.latest_failed ? 'failed' : row?.latest_completed ? 'completed' : null,
    worker: { configuredActive: Boolean(worker?.configured_active), lastAuthenticatedAt: worker?.last_authenticated_at ? new Date(worker.last_authenticated_at).toISOString() : null,
      lastClaimAt: worker?.last_claim_at ? new Date(worker.last_claim_at).toISOString() : null,
      connectionVerifiedAt: worker?.connection_verified_at ? new Date(worker.connection_verified_at).toISOString() : null }, quietHours: quietHoursState() };
}

export async function listLeadPageForUser(userId: string, scope: LeadScope, limit = 200): Promise<LeadPage> {
  if (scope.kind === 'profile' && !UUID.test(scope.profileId)) {
    return { leads: [], total: 0, delivery: { status: 'ready', maxLeadsPerCycle: 0, deliveredThisCycle: 0, queued: 0, nextCycleAt: null, workerClaimed: false, currentSearchStatus: null,
      worker: { configuredActive: false, lastAuthenticatedAt: null, lastClaimAt: null, connectionVerifiedAt: null }, quietHours: quietHoursState() } };
  }
  await deliverWaitingLeads(userId, scope);
  const params: unknown[] = [userId, limit];
  let scopeSql = '';
  if (scope.kind === 'profile') {
    if (!UUID.test(scope.profileId)) return { leads: [], total: 0, delivery: { status: 'ready', maxLeadsPerCycle: 0, deliveredThisCycle: 0, queued: 0, nextCycleAt: null, workerClaimed: false, currentSearchStatus: null,
      worker: { configuredActive: false, lastAuthenticatedAt: null, lastClaimAt: null, connectionVerifiedAt: null }, quietHours: quietHoursState() } };
    params.push(scope.profileId);
    scopeSql = `AND EXISTS (SELECT 1 FROM facebook_posts sp JOIN agent_connections sac ON sac.id = sp.agent_connection_id
          WHERE sac.id = $3 AND sac.user_id = $1 AND sac.kind = 'search_profile' AND sp.normalized_url = fp.normalized_url AND ${sourceLinkedPostSql('sp')}
            AND EXISTS (SELECT 1 FROM profile_lead_deliveries d WHERE d.search_profile_id = sp.agent_connection_id AND d.post_id = sp.id AND d.state = 'delivered'))`;
  } else if (scope.kind === 'legacy') {
    scopeSql = `AND EXISTS (SELECT 1 FROM facebook_posts sp JOIN agent_connections sac ON sac.id = sp.agent_connection_id
          WHERE sac.user_id = $1 AND sac.kind <> 'search_profile' AND sp.normalized_url = fp.normalized_url AND ${sourceLinkedPostSql('sp')})`;
  }
  const deliveredOnly = "AND (ac.kind <> 'search_profile' OR EXISTS (SELECT 1 FROM profile_lead_deliveries d WHERE d.search_profile_id = fp.agent_connection_id AND d.post_id = fp.id AND d.state = 'delivered'))";
  const { rows } = await db().query<Row & { scope_total: number }>(`WITH lead_page AS (
      SELECT chosen.normalized_url, chosen.id, chosen.published_at, chosen.scope_total FROM (
        SELECT url_pick.*, count(*) OVER ()::int AS scope_total FROM (
          SELECT DISTINCT ON (fp.normalized_url) fp.normalized_url, fp.id, fp.published_at
          FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
          WHERE ac.user_id = $1 AND ${sourceLinkedPostSql('fp')} ${deliveredOnly} ${scopeSql}
          ORDER BY fp.normalized_url, (fp.published_at IS NULL), fp.id
        ) url_pick
      ) chosen
      ORDER BY chosen.published_at DESC NULLS LAST, chosen.id LIMIT $2
    )
    ${POST_SELECT.replace('SELECT fp.id,', 'SELECT page.scope_total, fp.id,')}
    JOIN lead_page page ON page.normalized_url = fp.normalized_url
    WHERE ac.user_id = $1 AND ${sourceLinkedPostSql('fp')} ${deliveredOnly} GROUP BY fp.id, ac.id, page.published_at, page.id, page.scope_total
    ORDER BY page.published_at DESC NULLS LAST, page.id, fp.first_seen_at ASC NULLS LAST, fp.id`, params);
  const leads = groupByPost(rows)
    .sort((a, b) => compareLeadByPostedAt(a, b))
    .slice(0, limit);
  return { leads, total: rows[0]?.scope_total ?? 0, delivery: await deliverySummary(userId, scope) };
}

export async function listLeadsForUser(userId: string, limit = 200, _rankingNow = Date.now()): Promise<Lead[]> {
  return (await listLeadPageForUser(userId, { kind: 'all' }, limit)).leads;
}

/** Returns null both for unknown ids and for posts owned by someone else, so ownership is not revealed. */
export async function getLeadForUser(userId: string, postId: string): Promise<Lead | null> {
  if (!UUID.test(postId)) return null;
  const { rows } = await db().query<Row>(`${POST_SELECT}
    WHERE ac.user_id = $1 AND ${sourceLinkedPostSql('fp')}
      AND (ac.kind <> 'search_profile' OR EXISTS (SELECT 1 FROM profile_lead_deliveries d WHERE d.search_profile_id = fp.agent_connection_id AND d.post_id = fp.id AND d.state = 'delivered'))
      AND fp.normalized_url = (SELECT p.normalized_url FROM facebook_posts p JOIN agent_connections c ON c.id = p.agent_connection_id WHERE p.id = $2 AND c.user_id = $1)
    ${GROUP_BY}`, [userId, postId]);
  const self = rows.find(row => row.id === postId);
  if (!self) return null;
  const others = rows.filter(row => row.id !== postId).sort((x, y) => time(x) - time(y));
  const ordered = [self, ...others].sort((x, y) => time(x) - time(y));
  const firstValue = (field: 'author' | 'title' | 'content' | 'summary_vi') => ordered.find(row => row[field]?.trim())?.[field] ?? null;
  const record = toLeadRecord({ ...self, author: firstValue('author'), title: firstValue('title'), content: firstValue('content'), summary_vi: firstValue('summary_vi'), published_at: originalPostTime(rows) });
  const hotAssessments = ordered.flatMap(row => row.hot_assessments ?? []);
  const uniqueAssessments = [...new Map(hotAssessments.map(assessment => [assessment.profileId, assessment])).values()];
  return { ...record, agent_name: null, sources: ordered.map(sourceOf), deliveredAt: ordered.map(row => row.delivered_at).filter(Boolean).map(value => new Date(value!).toISOString()).sort()[0] ?? null,
    hotAssessments: uniqueAssessments,
    eligibility: { basis: 'source_linked_search', relevance: 'selected_by_search', independentlyVerified: false } };
}

/**
 * A scan as customers see it: when it finished, which search ran it, whether it worked and how many new leads it
 * added. Posts examined or submitted are diagnostics (admin only) and are deliberately not read here.
 */
export type ScanRun = {
  id: string; scannedAt: string; status: string;
  /** Which saved search ran this scan; null for older integrations that recorded no search profile. */
  profile: { id: string; name: string; version: number } | null;
  newLeads: number;
  sourceLinkedPosts: number;
  metadataCompletePosts: number;
  metadataIncompletePosts: number;
};

/**
 * New leads of a scan, counted the way the lead list shows them. scan_runs.new_posts counts rows inserted for that
 * search, which also includes rows the list hides (incomplete or test posts) and URLs this customer already has
 * from another search (shown as one lead). There is no post → scan link, but a scan's posts are inserted in the
 * same transaction as its scan_runs row, so both carry the same now(): posts first seen at the scan's received_at
 * are that scan's new rows. Of those, a lead is new when it is source-linked and no earlier source-linked row of
 * this customer has the same URL.
 */
const SCAN_FROM = `FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id
    CROSS JOIN LATERAL (SELECT
      count(DISTINCT fp.normalized_url) FILTER (WHERE ${sourceLinkedPostSql('fp')}
        AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc WHERE psc.agent_connection_id = fp.agent_connection_id
          AND psc.normalized_url = fp.normalized_url AND psc.configuration_version = sr.configuration_version)
        AND NOT EXISTS (SELECT 1 FROM facebook_posts p2 JOIN agent_connections a2 ON a2.id = p2.agent_connection_id
          WHERE a2.user_id = ac.user_id AND p2.normalized_url = fp.normalized_url
            AND (p2.first_seen_at < fp.first_seen_at OR (p2.first_seen_at = fp.first_seen_at AND p2.id < fp.id))
            AND ${sourceLinkedPostSql('p2')}))::int AS new_leads,
      count(DISTINCT fp.normalized_url) FILTER (WHERE ${sourceLinkedPostSql('fp')}
        AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc WHERE psc.agent_connection_id = fp.agent_connection_id
          AND psc.normalized_url = fp.normalized_url AND psc.configuration_version = sr.configuration_version))::int AS source_linked_posts,
      count(DISTINCT fp.normalized_url) FILTER (WHERE ${sourceLinkedPostSql('fp')} AND ${completeLeadMetadataSql('fp')}
        AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc WHERE psc.agent_connection_id = fp.agent_connection_id
          AND psc.normalized_url = fp.normalized_url AND psc.configuration_version = sr.configuration_version))::int AS metadata_complete_posts
      FROM facebook_posts fp WHERE fp.agent_connection_id = sr.agent_connection_id AND fp.first_seen_at >= sr.received_at
        AND fp.first_seen_at < sr.received_at + interval '1 millisecond') nl`;

const SCAN_SELECT = `SELECT sr.id, ac.id AS connection_id, ac.kind, ac.name, sr.configuration_version, sr.scanned_at, sr.status,
    nl.new_leads, nl.source_linked_posts, nl.metadata_complete_posts,
    (nl.source_linked_posts - nl.metadata_complete_posts)::int AS metadata_incomplete_posts ${SCAN_FROM}`;

function toScanRun(row: Record<string, any>): ScanRun {
  return {
    id: row.id, scannedAt: new Date(row.scanned_at).toISOString(), status: row.status,
    profile: row.kind === 'search_profile' ? { id: row.connection_id, name: row.name, version: row.configuration_version } : null,
    newLeads: Number(row.new_leads), sourceLinkedPosts: Number(row.source_linked_posts),
    metadataCompletePosts: Number(row.metadata_complete_posts), metadataIncompletePosts: Number(row.metadata_incomplete_posts),
  };
}

/** Most recent scans for this user's searches (newest first). */
export async function listScanHistoryForUser(userId: string, limit = 8): Promise<ScanRun[]> {
  const { rows } = await db().query(`${SCAN_SELECT} WHERE ac.user_id = $1 ORDER BY sr.scanned_at DESC, sr.id LIMIT $2`, [userId, limit]);
  return rows.map(toScanRun);
}

export type ScanTotals = { total: number; last24h: { scans: number; newLeads: number; failed: number } };

/** All-time scan count (for the link to the full history) and what the last 24 hours added up to. */
export async function getScanTotalsForUser(userId: string): Promise<ScanTotals> {
  const { rows: [row] } = await db().query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE sr.scanned_at > now() - interval '24 hours')::int AS scans,
      coalesce(sum(nl.new_leads) FILTER (WHERE sr.scanned_at > now() - interval '24 hours'), 0)::int AS new_leads,
      count(*) FILTER (WHERE sr.scanned_at > now() - interval '24 hours' AND sr.status = 'failed')::int AS failed
    ${SCAN_FROM} WHERE ac.user_id = $1`, [userId]);
  return { total: row.total, last24h: { scans: row.scans, newLeads: row.new_leads, failed: row.failed } };
}

/** Vietnam calendar day of a scan, used to group the full history. */
const SCAN_DAY = `to_char(sr.scanned_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

export type ScanDay = { day: string; scans: number; newLeads: number; sourceLinkedPosts: number; metadataCompletePosts: number; metadataIncompletePosts: number; failed: number };
export type ScanHistoryPage = { runs: ScanRun[]; total: number; page: number; pageCount: number; days: ScanDay[] };

/**
 * One page of the full history, newest first. `profileId` narrows to one of this user's searches ('legacy' = scans
 * recorded without one) and is matched inside the user's own rows, so another user's id simply returns nothing.
 * `onlyNew` keeps scans that added at least one new lead. Day totals cover the whole day, not just this page.
 */
export async function listScanHistoryPage(userId: string, options: { profileId?: string | null; onlyNew?: boolean; page?: number; pageSize?: number }): Promise<ScanHistoryPage> {
  const pageSize = options.pageSize ?? 50;
  const where = ['ac.user_id = $1'];
  const params: unknown[] = [userId];
  if (options.profileId === 'legacy') where.push("ac.kind <> 'search_profile'");
  else if (options.profileId) {
    if (!UUID.test(options.profileId)) return { runs: [], total: 0, page: 1, pageCount: 1, days: [] };
    params.push(options.profileId); where.push(`ac.id = $${params.length}`);
  }
  if (options.onlyNew) where.push('nl.new_leads > 0');
  const filter = where.join(' AND ');
  const { rows: [{ total }] } = await db().query(`SELECT count(*)::int AS total ${options.onlyNew ? SCAN_FROM : 'FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id'} WHERE ${filter}`, params);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pageCount);
  const { rows } = await db().query(`${SCAN_SELECT} WHERE ${filter} ORDER BY sr.scanned_at DESC, sr.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  const runs = rows.map(toScanRun);
  if (!runs.length) return { runs, total, page, pageCount, days: [] };
  const { rows: dayRows } = await db().query(`SELECT ${SCAN_DAY} AS day, count(*)::int AS scans, coalesce(sum(nl.new_leads), 0)::int AS new_leads,
      coalesce(sum(nl.source_linked_posts), 0)::int AS source_linked_posts,
      coalesce(sum(nl.metadata_complete_posts), 0)::int AS metadata_complete_posts,
      coalesce(sum(nl.source_linked_posts - nl.metadata_complete_posts), 0)::int AS metadata_incomplete_posts,
      count(*) FILTER (WHERE sr.status = 'failed')::int AS failed
    ${SCAN_FROM}
    WHERE ${filter} AND sr.scanned_at >= $${params.length + 1}::timestamptz - interval '1 day' AND sr.scanned_at <= $${params.length + 2}::timestamptz + interval '1 day'
    GROUP BY 1`, [...params, runs.at(-1)!.scannedAt, runs[0].scannedAt]);
  return { runs, total, page, pageCount, days: dayRows.map(row => ({ day: row.day, scans: row.scans, newLeads: row.new_leads,
    sourceLinkedPosts: row.source_linked_posts, metadataCompletePosts: row.metadata_complete_posts,
    metadataIncompletePosts: row.metadata_incomplete_posts, failed: row.failed })) };
}
