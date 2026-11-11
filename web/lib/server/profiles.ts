import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { deriveProfileState, PROFILE_FREQUENCIES, type LegacySummary, type SearchProfile } from '../profile-state';
import { deriveProfileScan, type ProfileScan, type ScanRequestOutcome, type ScanRow } from '../profile-scan';
import { enqueueInitialJob, requestManualJob, supersedeQueuedJobs } from '../../../src/jobs';
import { planFromDescription } from '../../../src/search-plan';
import { sourceLinkedPostSql } from '../../../src/lead-eligibility';
import { db } from './db';

/**
 * Customer search profiles (agent_connections.kind = 'search_profile'). Every query filters on the signed-in user's
 * id, so profile ids from the browser are only ever looked up inside that user's own rows. Editing, pausing and
 * resuming append a scan_configs version: posts keep the version that found them and are never reassigned.
 *
 * The customer's description is the search instruction. Unless they chose to maintain their own phrases, the server
 * regenerates the search phrases from the description on every save, so the two can never drift apart.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROFILES = 10;
/** A finished customer-requested scan keeps its outcome on the card this long. */
const SHOW_FINISHED_REQUEST_HOURS = 6;
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const runLeadCount = (profile: string, received: string, version: string, alias = 'fp') => `(SELECT count(DISTINCT ${alias}.normalized_url)::int
  FROM facebook_posts ${alias} WHERE ${alias}.agent_connection_id = ${profile} AND ${alias}.first_seen_at = ${received}
    AND ${sourceLinkedPostSql(alias)} AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc
      WHERE psc.agent_connection_id = ${alias}.agent_connection_id AND psc.normalized_url = ${alias}.normalized_url
        AND psc.configuration_version = ${version}))`;

/** Latest non-cancelled job of the profile with its recorded run, for the progress panel. */
const LATEST_JOB = `LEFT JOIN LATERAL (SELECT j.kind, j.configuration_version, j.status, j.attempts, j.created_at, j.scheduled_for, j.lease_expires_at,
      (SELECT claimed_at FROM search_job_attempts WHERE id = j.current_attempt_id) AS claimed_at,
      r.status AS run_status, r.scanned_at AS run_at, r.new_posts, r.total_found,
      ${runLeadCount('r.agent_connection_id', 'r.received_at', 'r.configuration_version')} AS source_linked_new_posts
    FROM search_jobs j LEFT JOIN scan_runs r ON r.search_job_id = j.id
    WHERE j.search_profile_id = ac.id AND j.status <> 'cancelled' ORDER BY j.created_at DESC LIMIT 1) job ON true`;

function scanFrom(row: Partial<ScanRow> & { kind: string | null }, now: number, always = false): ProfileScan | null {
  if (!row.kind) return null;
  const scan = deriveProfileScan(row as ScanRow, now);
  if (always || ['queued', 'running', 'delayed'].includes(scan.state)) return scan;
  // A finished scan stays visible only when the customer asked for it, so the routine schedule does not crowd the card.
  const recent = scan.finishedAt && now - new Date(scan.finishedAt).getTime() < SHOW_FINISHED_REQUEST_HOURS * 3_600_000;
  return (scan.kind === 'manual' || scan.kind === 'initial') && recent ? scan : null;
}

export async function listProfilesForUser(userId: string, now = Date.now()): Promise<SearchProfile[]> {
  const { rows } = await db().query(`SELECT ac.id, ac.name, ac.created_at,
      sc.version, sc.keywords, sc.keywords_source, sc.location, sc.frequency_minutes, sc.enabled, sc.description, sc.updated_at, u.lead_monitoring_status, u.lead_monitoring_changed_at,
      (SELECT count(*)::int FROM scan_configs WHERE agent_connection_id = ac.id) AS versions,
      (SELECT count(DISTINCT (keywords::text, location, coalesce(description, '')))::int FROM scan_configs WHERE agent_connection_id = ac.id) > 1 AS conditions_changed,
      EXISTS (SELECT 1 FROM scan_configs WHERE agent_connection_id = ac.id AND enabled) AS ever_enabled,
      CASE WHEN u.lead_monitoring_status = 'active' AND sc.enabled
          AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.search_profile_id = ac.id AND j.status <> 'cancelled'
            AND (j.scheduled_for >= to_timestamp(floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60)) * sc.frequency_minutes * 60)
              OR (j.kind IN ('initial', 'manual') AND j.scheduled_for > now() - make_interval(secs => sc.frequency_minutes * 30))))
          AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.search_profile_id = ac.id
            AND j.status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization'))
        THEN to_timestamp(floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60)) * sc.frequency_minutes * 60)
        ELSE NULL END AS recurring_due_at,
      last_run.scanned_at AS last_scan_at, last_run.status AS last_scan_status, last_run.source_linked_new_posts AS last_new_posts, last_run.total_found AS last_total_found,
      (SELECT max(scanned_at) FROM scan_runs WHERE agent_connection_id = ac.id AND status <> 'failed') AS last_success_at,
      EXISTS (SELECT 1 FROM search_jobs WHERE search_profile_id = ac.id AND status IN ('blocked', 'needs_reauthorization')) AS blocked,
      (SELECT count(DISTINCT fp.normalized_url)::int FROM facebook_posts fp WHERE fp.agent_connection_id = ac.id AND ${sourceLinkedPostSql('fp')}) AS lead_count,
      job.kind, job.configuration_version, job.status, job.attempts, job.created_at AS job_created_at, job.lease_expires_at, job.claimed_at,
      job.run_status, job.run_at, job.source_linked_new_posts AS new_posts, job.total_found, job.scheduled_for
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT * FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    LEFT JOIN LATERAL (SELECT sr.scanned_at, sr.status, sr.total_found,
        ${runLeadCount('sr.agent_connection_id', 'sr.received_at', 'sr.configuration_version')} AS source_linked_new_posts
      FROM scan_runs sr WHERE sr.agent_connection_id = ac.id ORDER BY sr.scanned_at DESC LIMIT 1) last_run ON true
    ${LATEST_JOB}
    WHERE ac.user_id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active'
    ORDER BY ac.created_at`, [userId]);
  return rows.map(row => {
    const lastScan = row.last_scan_at ? { at: iso(row.last_scan_at)!, status: row.last_scan_status, newPosts: row.last_new_posts, totalFound: row.last_total_found } : null;
    const lastSuccessAt = iso(row.last_success_at);
    return {
      id: row.id, name: row.name, description: row.description, version: row.version, versions: row.versions, conditionsChanged: row.conditions_changed,
      keywords: row.keywords, keywordsSource: row.keywords_source, location: row.location, frequencyMinutes: row.frequency_minutes, enabled: row.enabled,
      createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, lastScan, lastSuccessAt, leadCount: row.lead_count,
      state: deriveProfileState({ enabled: row.enabled, everEnabled: row.ever_enabled, frequencyMinutes: row.frequency_minutes, enabledSince: row.updated_at, lastScan, lastSuccessAt, blocked: row.blocked, recurringDueAt: iso(row.recurring_due_at),
        accountSuspended: row.lead_monitoring_status === 'suspended', monitoringSince: iso(row.lead_monitoring_changed_at) }, now),
      scan: row.lead_monitoring_status === 'suspended' && row.status !== 'claimed' && !row.run_at ? null : scanFrom({ ...row, created_at: row.job_created_at }, now),
    };
  });
}

/** Progress of one of this user's profiles, polled by its card. Null when the profile is not theirs or never scanned. */
export async function getProfileScan(userId: string, profileId: string, now = Date.now()): Promise<{ scan: ProfileScan | null; version: number; leadCount: number } | null> {
  if (!UUID.test(profileId)) return null;
  const { rows: [row] } = await db().query(`SELECT sc.version AS current_version, u.lead_monitoring_status,
      (SELECT count(DISTINCT fp.normalized_url)::int FROM facebook_posts fp WHERE fp.agent_connection_id = ac.id AND ${sourceLinkedPostSql('fp')}) AS lead_count,
      job.kind, job.configuration_version, job.status, job.attempts, job.created_at, job.lease_expires_at, job.claimed_at,
      job.run_status, job.run_at, job.source_linked_new_posts AS new_posts, job.total_found
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT version FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    ${LATEST_JOB}
    WHERE ac.id = $1 AND ac.user_id = $2 AND ac.kind = 'search_profile' AND ac.status = 'active'`, [profileId, userId]);
  if (!row) return null;
  return { scan: row.lead_monitoring_status === 'suspended' && row.status !== 'claimed' && !row.run_at ? null : scanFrom(row, now, true), version: row.current_version, leadCount: row.lead_count };
}

/** Older integrations: leads and scans that exist without any search profile. Null when there are none. */
export async function getLegacySummaryForUser(userId: string): Promise<LegacySummary | null> {
  const { rows: [row] } = await db().query(`SELECT
      (SELECT count(DISTINCT fp.normalized_url)::int FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1 AND ac.kind = 'legacy_agent' AND ${sourceLinkedPostSql('fp')}) AS lead_count,
      (SELECT max(sr.scanned_at) FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id WHERE ac.user_id = $1 AND ac.kind = 'legacy_agent') AS last_scan_at`, [userId]);
  if (!row.lead_count && !row.last_scan_at) return null;
  return { leadCount: row.lead_count, lastScanAt: iso(row.last_scan_at) };
}

function cleanKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  return keywords.map(keyword => keyword.replace(/\s+/g, ' ').trim()).filter(keyword => {
    const key = keyword.toLocaleLowerCase('vi');
    if (!keyword || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What the customer edits. Only the description is required: the name defaults to one derived from it, an empty
 * location means no geographic limit, and search phrases are only accepted when the customer explicitly chose to
 * maintain their own (`keywords_source: 'manual'`).
 */
export const profileInput = z.object({
  name: z.string().trim().max(80).optional().default(''),
  description: z.string().trim().min(5).max(1000),
  location: z.string().trim().max(100).optional().default(''),
  frequency_minutes: z.number().int().refine(value => (PROFILE_FREQUENCIES as readonly number[]).includes(value)),
  keywords_source: z.enum(['description', 'manual']).optional().default('description'),
  keywords: z.array(z.string().trim().min(2).max(160)).max(10).optional().default([]),
}).strict().refine(input => input.keywords_source === 'description' || cleanKeywords(input.keywords).length > 0, { message: 'manual keywords required', path: ['keywords'] });
export type ProfileInput = z.infer<typeof profileInput>;

type SearchFields = { name: string; description: string; keywords: string[]; keywordsSource: 'description' | 'manual'; location: string };

/** The configuration a save stores. Generated phrases come from the description being saved, never from an older one. */
export function resolveSearch(input: ProfileInput): SearchFields {
  const plan = planFromDescription(input.description);
  const keywords = input.keywords_source === 'manual' ? cleanKeywords(input.keywords) : plan.queries;
  return { name: input.name || plan.name || input.description.slice(0, 80), description: input.description, keywords, keywordsSource: input.keywords_source, location: input.location };
}

const searchKey = (row: { keywords: string[]; location: string; description: string | null; keywords_source: string }) =>
  JSON.stringify([row.keywords, row.location, row.description ?? null, row.keywords_source]);

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function insertProfile(client: PoolClient, userId: string, input: ProfileInput, enabled: boolean): Promise<string> {
  const search = resolveSearch(input);
  const { rows: [profile] } = await client.query("INSERT INTO agent_connections (user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, search.name]);
  await client.query(`INSERT INTO scan_configs (agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id)
    VALUES ($1, 1, $2, $3, $4, $5, '["social.search"]', $6, $7, $8)`,
  [profile.id, enabled, JSON.stringify(search.keywords), search.keywordsSource, search.location, input.frequency_minutes, search.description, userId]);
  if (enabled) await enqueueInitialJob(client, profile.id);
  return profile.id;
}

export type ProfileResult =
  | { ok: true; id: string; version?: number; scan?: ScanRequestOutcome }
  | { ok: false; error: 'not_found' | 'limit_reached' | 'stale' };

export async function createProfile(userId: string, input: ProfileInput, enabled: boolean): Promise<ProfileResult> {
  return inTransaction(async client => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM agent_connections WHERE user_id = $1 AND kind = 'search_profile' AND status = 'active'", [userId]);
    if (count >= MAX_PROFILES) return { ok: false, error: 'limit_reached' };
    return { ok: true, id: await insertProfile(client, userId, input, enabled) };
  });
}

type Change =
  | { kind: 'edit'; input: ProfileInput; baseVersion?: number; rescan?: boolean }
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'rescan' };

function toOutcome(request: Awaited<ReturnType<typeof requestManualJob>>): ScanRequestOutcome | undefined {
  if (request.outcome === 'not_found') return undefined;
  if (request.outcome === 'cooldown') return { outcome: 'cooldown', retryAfterSeconds: request.retryAfterSeconds, lastFinishedAt: request.lastFinishedAt };
  if ((request.outcome === 'queued' || request.outcome === 'existing') && request.nextAllowedScanAt) return { outcome: request.outcome,
    quietHoursActive: true, nextAllowedScanAt: request.nextAllowedScanAt };
  if (request.outcome === 'queued' || request.outcome === 'existing') return { outcome: request.outcome };
  return { outcome: request.outcome };
}

/**
 * Appends a configuration version owned by this user, and optionally queues a scan of it, in one transaction.
 *
 * - A search-relevant edit cancels not-yet-claimed jobs of older versions (see supersedeQueuedJobs). A claimed job
 *   finishes under its own version; its results are recorded against that version only.
 * - `baseVersion` is the version the customer's form was opened on. If someone changed the search conditions since
 *   (another tab or device), the save is refused as stale instead of silently overwriting them. Repeating the same
 *   save (a retry) changes nothing and succeeds.
 * - Pausing cancels the profile's not-yet-claimed job so no new scan starts.
 */
export async function changeProfile(userId: string, profileId: string, change: Change): Promise<ProfileResult> {
  if (!UUID.test(profileId)) return { ok: false, error: 'not_found' };
  return inTransaction(async client => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: [current] } = await client.query(`SELECT sc.* FROM agent_connections ac
      JOIN LATERAL (SELECT * FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
      WHERE ac.id = $1 AND ac.user_id = $2 AND ac.kind = 'search_profile' AND ac.status = 'active' FOR UPDATE OF ac`, [profileId, userId]);
    if (!current) return { ok: false, error: 'not_found' };
    if (change.kind === 'rescan') {
      const scan = toOutcome(await requestManualJob(client, profileId, userId));
      return scan ? { ok: true, id: profileId, version: current.version, scan } : { ok: false, error: 'not_found' };
    }

    let next = { enabled: current.enabled, keywords: current.keywords, keywords_source: current.keywords_source, location: current.location, frequency: current.frequency_minutes, description: current.description };
    if (change.kind === 'edit') {
      const search = resolveSearch(change.input);
      next = { ...next, keywords: search.keywords, keywords_source: search.keywordsSource, location: search.location, frequency: change.input.frequency_minutes, description: search.description };
      if (change.baseVersion !== undefined && change.baseVersion !== current.version && searchKey(next) !== searchKey(current)) {
        const { rows: [base] } = await client.query('SELECT keywords, location, description, keywords_source FROM scan_configs WHERE agent_connection_id = $1 AND version = $2', [profileId, change.baseVersion]);
        if (!base || searchKey(base) !== searchKey(current)) return { ok: false, error: 'stale' };
      }
      await client.query('UPDATE agent_connections SET name = $2 WHERE id = $1', [profileId, search.name]);
    } else {
      next.enabled = change.enabled;
    }

    const searchChanged = searchKey(next) !== searchKey(current);
    const unchanged = !searchChanged && next.enabled === current.enabled && next.frequency === current.frequency_minutes;
    const version = unchanged ? current.version : current.version + 1;
    if (!unchanged) {
      await client.query(`INSERT INTO scan_configs (agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [profileId, version, next.enabled, JSON.stringify(next.keywords), next.keywords_source, next.location, JSON.stringify(current.sources), next.frequency, next.description, userId]);
    }
    if (searchChanged && next.enabled) await supersedeQueuedJobs(client, profileId, version);
    if (next.enabled && !current.enabled) await enqueueInitialJob(client, profileId);
    if (!next.enabled) {
      await client.query("UPDATE search_jobs SET status = 'cancelled', last_error = 'paused_by_customer', updated_at = now(), completed_at = now() WHERE search_profile_id = $1 AND status IN ('pending', 'blocked')", [profileId]);
    }
    const scan = change.kind === 'edit' && change.rescan ? toOutcome(await requestManualJob(client, profileId, userId)) : undefined;
    return { ok: true, id: profileId, version, scan };
  });
}

/**
 * Finishes web onboarding: saves the first search profile under this user unless they already have one (a repeated
 * or resumed submit never creates a duplicate), then marks onboarding complete.
 */
export async function completeOnboarding(userId: string, input: ProfileInput, enabled: boolean): Promise<{ created: boolean }> {
  return inTransaction(async client => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM agent_connections WHERE user_id = $1 AND kind = 'search_profile' AND status = 'active'", [userId]);
    if (!count) await insertProfile(client, userId, input, enabled);
    await client.query('UPDATE user_accounts SET onboarding_completed_at = coalesce(onboarding_completed_at, now()) WHERE user_id = $1', [userId]);
    return { created: !count };
  });
}
