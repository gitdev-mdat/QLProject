import 'server-only';
import { toLeadRecord, type StoredFacebookPost } from '../../../src/lead-data';
import type { Lead, LeadSource } from '../lead-source';
import { compareLeadByPostedAt } from '../lead-order';
import { db } from './db';

/**
 * Tenant scoping: every query joins agent_connections and filters on its user_id, so a user only ever reads
 * posts collected by their own agents. Same columns as the agent API's GET /api/agent/posts.
 */
const POST_SELECT = `SELECT fp.id, fp.author, fp.title, fp.content, fp.published_at, fp.original_url, fp.normalized_url,
    fp.first_seen_at AS discovered_at, fp.source_type, fp.collected_via, fp.platform, ac.name AS agent_name,
    ac.id AS connection_id, ac.kind AS connection_kind,
    COALESCE(jsonb_agg(jsonb_build_object('version',sc.version,'enabled',sc.enabled,'keywords',sc.keywords,
      'location',sc.location,'sources',sc.sources,'frequency_minutes',sc.frequency_minutes)
      ORDER BY sc.version DESC) FILTER (WHERE sc.version IS NOT NULL), '[]'::jsonb) AS search_configurations
  FROM facebook_posts fp
  JOIN agent_connections ac ON ac.id = fp.agent_connection_id
  LEFT JOIN facebook_post_search_configs psc ON psc.agent_connection_id = fp.agent_connection_id AND psc.normalized_url = fp.normalized_url
  LEFT JOIN scan_configs sc ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version`;

/**
 * A usable Facebook lead has a poster and text. Missing publication time is retained and explicitly ranked as unknown,
 * rather than dropped or treated as recent. Test-only fixtures remain hidden.
 */
const COMPLETE = "fp.author IS NOT NULL AND btrim(fp.author) <> '' AND btrim(coalesce(fp.content, fp.title, '')) <> '' AND coalesce(fp.collected_via, '') <> 'integration_test'";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUP_BY = 'GROUP BY fp.id, ac.id';

type Row = StoredFacebookPost & { id: string; normalized_url: string; connection_id: string; connection_kind: 'legacy_agent' | 'search_profile' };

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
    return { ...toLeadRecord(sorted[0]), published_at: originalPostTime(group), agent_name: null, sources: sorted.map(sourceOf) };
  });
}

export async function listLeadsForUser(userId: string, limit = 200, _rankingNow = Date.now()): Promise<Lead[]> {
  const { rows } = await db().query<Row>(`WITH lead_page AS (
      SELECT chosen.normalized_url, chosen.id, chosen.published_at FROM (
        SELECT DISTINCT ON (fp.normalized_url) fp.normalized_url, fp.id, fp.published_at
        FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
        WHERE ac.user_id = $1 AND ${COMPLETE}
        ORDER BY fp.normalized_url, (fp.published_at IS NULL), fp.id
      ) chosen
      ORDER BY chosen.published_at DESC NULLS LAST, chosen.id LIMIT $2
    )
    ${POST_SELECT}
    JOIN lead_page page ON page.normalized_url = fp.normalized_url
    WHERE ac.user_id = $1 AND ${COMPLETE} GROUP BY fp.id, ac.id, page.published_at, page.id
    ORDER BY page.published_at DESC NULLS LAST, page.id, fp.first_seen_at ASC NULLS LAST, fp.id`, [userId, limit]);
  return groupByPost(rows)
    .sort((a, b) => compareLeadByPostedAt(a, b))
    .slice(0, limit);
}

/** Returns null both for unknown ids and for posts owned by someone else, so ownership is not revealed. */
export async function getLeadForUser(userId: string, postId: string): Promise<Lead | null> {
  if (!UUID.test(postId)) return null;
  const { rows } = await db().query<Row>(`${POST_SELECT}
    WHERE ac.user_id = $1 AND ${COMPLETE}
      AND fp.normalized_url = (SELECT p.normalized_url FROM facebook_posts p JOIN agent_connections c ON c.id = p.agent_connection_id WHERE p.id = $2 AND c.user_id = $1)
    ${GROUP_BY}`, [userId, postId]);
  const self = rows.find(row => row.id === postId);
  if (!self) return null;
  const others = rows.filter(row => row.id !== postId).sort((x, y) => time(x) - time(y));
  return { ...toLeadRecord(self), published_at: originalPostTime(rows), agent_name: null, sources: [self, ...others].sort((x, y) => time(x) - time(y)).map(sourceOf) };
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
};

const COMPLETE_EARLIER = COMPLETE.replaceAll('fp.', 'p2.');

/**
 * New leads of a scan, counted the way the lead list shows them. scan_runs.new_posts counts rows inserted for that
 * search, which also includes rows the list hides (incomplete or test posts) and URLs this customer already has
 * from another search (shown as one lead). There is no post → scan link, but a scan's posts are inserted in the
 * same transaction as its scan_runs row, so both carry the same now(): posts first seen at the scan's received_at
 * are that scan's new rows. Of those, a lead is new when it is complete and no earlier complete row of this
 * customer has the same URL.
 */
const SCAN_FROM = `FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id
    CROSS JOIN LATERAL (SELECT count(*)::int AS new_leads FROM facebook_posts fp
      WHERE fp.agent_connection_id = sr.agent_connection_id AND fp.first_seen_at = sr.received_at AND ${COMPLETE}
        AND NOT EXISTS (SELECT 1 FROM facebook_posts p2 JOIN agent_connections a2 ON a2.id = p2.agent_connection_id
          WHERE a2.user_id = ac.user_id AND p2.normalized_url = fp.normalized_url AND p2.first_seen_at < fp.first_seen_at AND ${COMPLETE_EARLIER})) nl`;

const SCAN_SELECT = `SELECT sr.id, ac.id AS connection_id, ac.kind, ac.name, sr.configuration_version, sr.scanned_at, sr.status, nl.new_leads ${SCAN_FROM}`;

function toScanRun(row: Record<string, any>): ScanRun {
  return {
    id: row.id, scannedAt: new Date(row.scanned_at).toISOString(), status: row.status,
    profile: row.kind === 'search_profile' ? { id: row.connection_id, name: row.name, version: row.configuration_version } : null,
    newLeads: row.new_leads,
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

export type ScanDay = { day: string; scans: number; newLeads: number; failed: number };
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
      count(*) FILTER (WHERE sr.status = 'failed')::int AS failed
    ${SCAN_FROM}
    WHERE ${filter} AND sr.scanned_at >= $${params.length + 1}::timestamptz - interval '1 day' AND sr.scanned_at <= $${params.length + 2}::timestamptz + interval '1 day'
    GROUP BY 1`, [...params, runs.at(-1)!.scannedAt, runs[0].scannedAt]);
  return { runs, total, page, pageCount, days: dayRows.map(row => ({ day: row.day, scans: row.scans, newLeads: row.new_leads, failed: row.failed })) };
}
