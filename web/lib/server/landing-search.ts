import 'server-only';
import { createHash } from 'node:crypto';
import { extractContactFromPost } from '../../../src/lead-data';
import { isSupportedFacebookPostUrl, sourceLinkedPostSql } from '../../../src/lead-eligibility';
import {
  analyzeCandidates, displayableText, findPlaces, LANDING_MAX_AGE_DAYS, normalizeLandingQuery, rankLandingCandidates, nearestLandingCandidates,
  showcasePreviews, DEFAULT_LANDING_REQUEST, NEAREST_MATCH_LABEL,
  type AnalyzedCandidate, type LandingCandidate, type LandingPreviewLead,
} from '../landing-search';
import { db } from './db';

/**
 * Where landing-page leads come from: ONLY search profiles owned by the accounts listed in
 * QLEAD_LANDING_CATALOG_USER_IDS (server-side env, comma-separated user ids, like QLEAD_ADMIN_USER_IDS). These are
 * QLead's own showcase searches, set up by the admin for common industries. A customer's searches and leads are
 * never read here: being a customer does not make your data public. With no catalog configured the landing search
 * returns "nothing yet" honestly instead of borrowing anyone's data.
 */
export function landingCatalogUserIds(): string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [...new Set((process.env.QLEAD_LANDING_CATALOG_USER_IDS ?? '').split(',').map(value => value.trim()).filter(value => uuid.test(value)))];
}

/** A preview opens for 24 hours; after that the visitor is told so and can search again. */
export const PREVIEW_TTL_HOURS = 24;
/** The candidate pool is shared by every query on this server instance and reloaded at most once a minute. */
const POOL_TTL_MS = 60_000;
const POOL_LIMIT = 1500;
/** Same normalised query within this window returns the same answer without ranking again. */
const ANSWER_TTL_MS = 5 * 60_000;
const ANSWER_CACHE_MAX = 300;

type Pool = { key: string; loadedAt: number; items: AnalyzedCandidate[] };
type Answer = { at: number; nearest: boolean; matches: Array<{ postId: string; preview: LandingPreviewLead }> };
const state = globalThis as unknown as { qleadLandingPool?: Pool; qleadLandingLoad?: Promise<Pool>; qleadLandingAnswers?: Map<string, Answer> };

async function loadPool(catalog: string[]): Promise<Pool> {
  const { rows } = await db().query<LandingCandidate>(`SELECT DISTINCT ON (fp.normalized_url) fp.id, fp.normalized_url, fp.original_url, fp.title, fp.content, fp.summary_vi,
      fp.published_at, fp.first_seen_at AS discovered_at
    FROM facebook_posts fp
    JOIN agent_connections ac ON ac.id = fp.agent_connection_id
    JOIN users u ON u.id = ac.user_id
    WHERE ac.user_id = ANY($1::uuid[]) AND ac.kind = 'search_profile' AND ac.status = 'active' AND u.lead_monitoring_status = 'active'
      AND fp.first_seen_at > now() - make_interval(days => $2)
      AND ${sourceLinkedPostSql('fp')}
    ORDER BY fp.normalized_url, fp.first_seen_at DESC
    LIMIT $3`, [catalog, LANDING_MAX_AGE_DAYS + 5, POOL_LIMIT]);
  return { key: catalog.join(','), loadedAt: Date.now(), items: analyzeCandidates(rows) };
}

/** Returns the shared candidate pool, loading it once for concurrent callers. */
async function candidatePool(catalog: string[]): Promise<{ pool: Pool; loaded: boolean }> {
  const key = catalog.join(',');
  const current = state.qleadLandingPool;
  if (current && current.key === key && Date.now() - current.loadedAt < POOL_TTL_MS) return { pool: current, loaded: false };
  if (!state.qleadLandingLoad) {
    state.qleadLandingLoad = loadPool(catalog).then(pool => { state.qleadLandingPool = pool; return pool; })
      .finally(() => { state.qleadLandingLoad = undefined; });
  }
  return { pool: await state.qleadLandingLoad, loaded: true };
}

const PINS_TTL_MS = 60_000;
const pinState = globalThis as unknown as { qleadLandingPins?: { at: number; matches: Answer['matches'] } };

/** The admin-pinned showcase leads (landing_showcase_pins), cached for a minute. Missing table → none. */
async function showcasePins(): Promise<Answer['matches']> {
  const cached = pinState.qleadLandingPins;
  if (cached && Date.now() - cached.at < PINS_TTL_MS) return cached.matches;
  let matches: Answer['matches'] = [];
  try {
    const { rows } = await db().query<LandingCandidate & { pinned_at: string }>(`SELECT fp.id, fp.normalized_url, fp.original_url, fp.title, fp.content, fp.summary_vi,
        fp.published_at, fp.first_seen_at AS discovered_at, sp.pinned_at
      FROM landing_showcase_pins sp JOIN facebook_posts fp ON fp.id = sp.post_id
      WHERE ${sourceLinkedPostSql('fp')} ORDER BY sp.position`);
    matches = showcasePreviews(rows).map(match => ({ postId: match.candidate.id, preview: match.preview }));
  } catch { matches = []; }
  pinState.qleadLandingPins = { at: Date.now(), matches };
  return matches;
}

export type LandingSearchResult = {
  previewId: string;
  outcome: 'found' | 'empty';
  leads: LandingPreviewLead[];
  expiresAt: string;
  serverMs: number;
  /** The signed-in viewer can open full details straight away. */
  member: boolean;
  /** True when the leads are QLead's newest ones because nothing matched the visitor's own words. */
  nearest: boolean;
};

const queryHash = (normalized: string) => createHash('sha256').update(`landing:${normalized}`).digest('hex');

/**
 * Runs one landing search: rank the shared pool (or reuse a recent identical answer), store the preview row
 * (without the visitor's words), and return at most two masked previews. Never contacts Muse.
 */
export async function runLandingSearch(query: string, viewerUserId: string | null): Promise<LandingSearchResult> {
  const started = performance.now();
  const normalized = normalizeLandingQuery(query);
  const catalog = landingCatalogUserIds();
  const answers = state.qleadLandingAnswers ??= new Map();
  const cacheKey = `${catalog.join(',')}|${normalized}`;
  let servedFrom: 'pool' | 'database' | 'cache' = 'cache';
  let answer: Answer | undefined = answers.get(cacheKey);
  if (!answer || Date.now() - answer.at > ANSWER_TTL_MS) {
    let matches: Answer['matches'] = [];
    let nearest = false;
    const pins = await showcasePins();
    const isDefault = normalized === normalizeLandingQuery(DEFAULT_LANDING_REQUEST);
    if (isDefault && pins.length) {
      // The landing page's own example always shows the two showcase leads the admin pinned.
      matches = pins;
    } else {
      let poolItems: AnalyzedCandidate[] = [];
      if (catalog.length) {
        const { pool, loaded } = await candidatePool(catalog);
        servedFrom = loaded ? 'database' : 'pool';
        poolItems = pool.items;
        matches = rankLandingCandidates(query, pool.items).map(match => ({ postId: match.candidate.id, preview: match.preview }));
      } else servedFrom = 'pool';
      if (!matches.length) {
        // Never an empty box while QLead has real leads: the pinned showcase first, else the newest catalog leads.
        matches = pins.length ? pins.map(pin => ({ ...pin, preview: { ...pin.preview, match: NEAREST_MATCH_LABEL } }))
          : nearestLandingCandidates(poolItems).map(match => ({ postId: match.candidate.id, preview: match.preview }));
        nearest = matches.length > 0;
      }
    }
    answer = { at: Date.now(), nearest, matches } satisfies Answer;
    answers.delete(cacheKey);
    answers.set(cacheKey, answer);
    if (answers.size > ANSWER_CACHE_MAX) answers.delete(answers.keys().next().value!);
  }
  const serverMs = Math.round(performance.now() - started);
  const outcome = answer.matches.length ? 'found' : 'empty';
  const { rows: [row] } = await db().query<{ id: string; expires_at: Date }>(`INSERT INTO landing_previews
      (query_hash, post_ids, result_count, outcome, served_from, server_ms, viewer_user_id, expires_at)
    VALUES ($1, $2::uuid[], $3, $4, $5, $6, $7, now() + make_interval(hours => $8)) RETURNING id, expires_at`,
  [queryHash(normalized), answer.matches.map(match => match.postId), answer.matches.length, outcome, servedFrom, serverMs, viewerUserId, PREVIEW_TTL_HOURS]);
  return { previewId: row!.id, outcome, leads: answer.matches.map(match => match.preview), expiresAt: row!.expires_at.toISOString(), serverMs, member: Boolean(viewerUserId), nearest: answer.nearest };
}

export type LandingFullLead = {
  key: string;
  text: string;
  summarized: boolean;
  /** The poster's own words when QLead also has a summary; null otherwise. */
  original: string | null;
  author: string | null;
  url: string | null;
  publishedAt: string | null;
  area: string | null;
  contact: string | null;
};

export type UnlockResult =
  | { status: 'ok'; leads: LandingFullLead[]; expiresAt: string; firstClaim: boolean }
  | { status: 'expired' | 'not_found' };

/**
 * Full details of one preview, for a signed-in account only. Only the posts that preview showed, re-checked against
 * the current catalog (a post whose showcase search was removed is no longer opened). The first account to open a
 * preview is recorded as its claimant for the Signup-to-Value report.
 */
export async function unlockLandingPreview(previewId: string, userId: string): Promise<UnlockResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewId)) return { status: 'not_found' };
  const { rows: [preview] } = await db().query<{ post_ids: string[]; expires_at: Date; expired: boolean; claimed_by_user_id: string | null; created_at: Date }>(`SELECT post_ids, expires_at, expires_at <= now() AS expired,
      claimed_by_user_id, created_at FROM landing_previews WHERE id = $1`, [previewId]);
  if (!preview) return { status: 'not_found' };
  if (preview.expired) return { status: 'expired' };
  const catalog = landingCatalogUserIds();
  if (!preview.post_ids.length) return { status: 'ok', leads: [], expiresAt: preview.expires_at.toISOString(), firstClaim: false };
  // A post opens if it is a pinned showcase lead, or still belongs to the catalog. Nothing else ever opens here.
  const pinned = await db().query<{ post_id: string }>('SELECT post_id FROM landing_showcase_pins WHERE post_id = ANY($1::uuid[])', [preview.post_ids])
    .then(result => result.rows.map(row => row.post_id)).catch(() => [] as string[]);
  const { rows } = await db().query<{ id: string; author: string | null; title: string | null; content: string | null; summary_vi: string | null; published_at: Date | null; original_url: string | null }>(`SELECT fp.id, fp.author, fp.title, fp.content, fp.summary_vi, fp.published_at, fp.original_url
    FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id JOIN users u ON u.id = ac.user_id
    WHERE fp.id = ANY($1::uuid[]) AND ${sourceLinkedPostSql('fp')}
      AND (fp.id = ANY($3::uuid[]) OR (ac.user_id = ANY($2::uuid[]) AND ac.kind = 'search_profile' AND ac.status = 'active'
        AND u.lead_monitoring_status = 'active'))`, [preview.post_ids, catalog, pinned]);
  const leads: LandingFullLead[] = [];
  preview.post_ids.forEach((postId, index) => {
    const post = rows.find(row => row.id === postId);
    if (!post) return;
    const shown = displayableText(post);
    const content = post.content?.trim() || null;
    const text = shown?.text ?? content ?? '';
    const contact = extractContactFromPost(`${content ?? ''}`);
    leads.push({
      key: String(index + 1), text, summarized: shown?.summarized ?? false,
      original: shown?.summarized && content && content !== text ? content : null,
      author: post.author?.trim() || null,
      url: isSupportedFacebookPostUrl(post.original_url) ? post.original_url : null,
      publishedAt: post.published_at ? post.published_at.toISOString() : null,
      area: findPlaces([post.summary_vi, post.title, post.content].filter(Boolean).join(' . ')).places[0] ?? null,
      contact: contact?.number ?? null,
    });
  });
  const { rowCount } = await db().query(`UPDATE landing_previews SET claimed_by_user_id = $2, claimed_at = now() WHERE id = $1 AND claimed_by_user_id IS NULL`, [previewId, userId]);
  const firstClaim = (rowCount ?? 0) > 0;
  if (firstClaim) {
    // An account created after the search it is opening signed up from the landing page.
    await db().query(`INSERT INTO landing_events (event, preview_id, user_id, result_count)
      SELECT 'landing_signup_completed', $1, u.id, $3 FROM users u WHERE u.id = $2 AND u.created_at >= $4`, [previewId, userId, leads.length, preview.created_at]);
  }
  await db().query(`INSERT INTO landing_events (event, preview_id, user_id, result_count) VALUES ('landing_full_results_viewed', $1, $2, $3)`, [previewId, userId, leads.length]);
  return { status: 'ok', leads, expiresAt: preview.expires_at.toISOString(), firstClaim };
}

export const CLIENT_EVENTS = ['landing_search_started', 'landing_search_results_shown', 'landing_search_empty', 'landing_search_failed', 'landing_preview_opened', 'landing_signup_clicked'] as const;
export type ClientEvent = typeof CLIENT_EVENTS[number];
export type LandingEventInput = {
  event: ClientEvent; visitorId: string | null; previewId: string | null; trigger: 'auto' | 'user' | 'suggestion' | null;
  resultCount: number | null; clientMs: number | null; reason: 'timeout' | 'rate_limited' | 'overloaded' | 'network' | 'server' | 'expired' | null;
};

let eventWrites = 0;
/** Stores one funnel event. An unknown preview id is dropped (stored as NULL), never trusted. */
export async function recordLandingEvent(input: LandingEventInput, userId: string | null): Promise<void> {
  await db().query(`INSERT INTO landing_events (event, visitor_id, preview_id, trigger, result_count, client_ms, reason, user_id)
    VALUES ($1, $2, (SELECT id FROM landing_previews WHERE id = $3::uuid), $4, $5, $6, $7, $8)`,
  [input.event, input.visitorId, input.previewId, input.trigger, input.resultCount, input.clientMs, input.reason, userId]);
  if (++eventWrites % 500 === 0) {
    await db().query(`DELETE FROM landing_events WHERE created_at < now() - interval '180 days'`);
    await db().query(`DELETE FROM landing_previews WHERE created_at < now() - interval '180 days'`);
  }
}
