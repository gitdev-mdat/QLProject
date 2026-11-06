import type { Pool, PoolClient } from 'pg';
import { sourceLinkedPostSql } from './lead-eligibility.js';

/**
 * One-time customer feedback (migration 019).
 *
 * Evidence: lead_source_opens has one row per account and Facebook post URL the customer opened with "Xem bài Facebook".
 * It is written only for the customer's own source-linked leads and only records the click in QLead.
 *
 * Invitation states:
 *   not_eligible  computed: fewer than 3 distinct opened leads, the first open is under 24 hours old, or monitoring is suspended
 *   eligible      computed: all conditions met, no invitation row yet
 *   shown         row claimed atomically by one tab of one device (INSERT … ON CONFLICT DO NOTHING)
 *   submitted     final: answers saved (through the invitation or voluntarily)
 *   declined      final: the customer closed the invitation (X or "Không, cảm ơn"); never counted as a rating
 * A row is never deleted or reset by this module, so nothing (refresh, another device, more leads, time) shows it again.
 */
export const FEEDBACK_RULES = {
  /** Distinct leads whose Facebook post the customer opened from QLead. */
  minDistinctSourceOpens: 3,
  /** Time between the first opened post and the invitation, so the customer has actually worked with the leads. */
  minExperienceHours: 24,
  /** How long the tab that claimed the invitation may show it again after a reload (it never moves to another tab). */
  resumeMinutes: 30,
  /** Voluntary submissions accepted per account per 24 hours (spam guard; the automatic invitation is separate). */
  voluntaryPerDay: 5,
} as const;

export const FEEDBACK_LIMITS = { unmetReason: 1000, improvement: 2000 } as const;

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opened leads that still belong to the account (a deleted post or search removes its evidence). */
const OWNED_OPENS = `SELECT o.normalized_url, o.first_opened_at FROM lead_source_opens o
  WHERE o.user_id = $1 AND EXISTS (SELECT 1 FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
    WHERE fp.id = o.post_id AND ac.user_id = $1)`;

/**
 * Records that the customer clicked "Xem bài Facebook" for a lead. Returns false when the post is not one of this
 * account's source-linked leads (unknown and foreign ids look the same). Repeated clicks on the same post — or on
 * another copy of the same Facebook URL found by a second search — keep the first row.
 */
export async function recordLeadSourceOpen(db: Queryable, userId: string, postId: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID.test(postId) || !UUID.test(userId)) return false;
  const { rows: [row] } = await db.query<{ owned: number }>(`WITH lead AS (
      SELECT fp.id, fp.normalized_url FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
      WHERE fp.id = $2 AND ac.user_id = $1 AND ${sourceLinkedPostSql('fp')}
    ), inserted AS (
      INSERT INTO lead_source_opens(user_id, normalized_url, post_id, first_opened_at)
      SELECT $1, normalized_url, id, $3 FROM lead ON CONFLICT (user_id, normalized_url) DO NOTHING RETURNING 1
    ) SELECT count(*)::int AS owned FROM lead`, [userId, postId, now]);
  return (row?.owned ?? 0) > 0;
}

export type InvitationState = 'not_eligible' | 'eligible' | 'shown' | 'submitted' | 'declined';
export type FeedbackEligibility = { state: InvitationState; distinctSourceOpens: number; firstOpenedAt: string | null; suspended: boolean };

/** The account's invitation state, with the evidence behind it (for tests and support; the browser only sees show/hide). */
export async function getFeedbackEligibility(db: Queryable, userId: string, now: Date = new Date()): Promise<FeedbackEligibility> {
  const { rows: [row] } = await db.query<{ opens: number; first_opened_at: Date | null; status: string | null; suspended: boolean }>(`SELECT
      (SELECT count(*)::int FROM (${OWNED_OPENS}) o) AS opens,
      (SELECT min(first_opened_at) FROM (${OWNED_OPENS}) o) AS first_opened_at,
      (SELECT status FROM customer_feedback_invitations WHERE user_id = $1) AS status,
      coalesce((SELECT lead_monitoring_status = 'suspended' FROM users WHERE id = $1), true) AS suspended`, [userId]);
  const opens = row?.opens ?? 0;
  const first = row?.first_opened_at ?? null;
  const base = { distinctSourceOpens: opens, firstOpenedAt: first ? first.toISOString() : null, suspended: Boolean(row?.suspended) };
  if (row?.status === 'shown' || row?.status === 'submitted' || row?.status === 'declined') return { state: row.status, ...base };
  const experienced = first !== null && now.getTime() - first.getTime() >= FEEDBACK_RULES.minExperienceHours * 3600_000;
  return { state: !base.suspended && opens >= FEEDBACK_RULES.minDistinctSourceOpens && experienced ? 'eligible' : 'not_eligible', ...base };
}

export type InvitationClaim = { show: true; token: string } | { show: false; final: boolean };

/**
 * Called by a tab that is ready to show the invitation (natural moment, no other dialog). The eligibility check and the
 * claim are one INSERT, so with several tabs or devices exactly one gets `show: true`. A tab that already claimed it may
 * show it again after a reload for a short time with its token, which is rotated so a duplicated tab cannot reuse it.
 */
export async function claimFeedbackInvitation(db: Queryable, userId: string, options: { now?: Date; resumeToken?: string | null } = {}): Promise<InvitationClaim> {
  const now = options.now ?? new Date();
  if (!UUID.test(userId)) return { show: false, final: false };
  const { rows: [claimed] } = await db.query<{ claim_token: string }>(`INSERT INTO customer_feedback_invitations(user_id, status, shown_at, claim_token)
    SELECT $1, 'shown', $2, gen_random_uuid() FROM users u
    WHERE u.id = $1 AND u.lead_monitoring_status = 'active'
      AND (SELECT count(*) FROM (${OWNED_OPENS}) o) >= $3
      AND (SELECT min(first_opened_at) FROM (${OWNED_OPENS}) o) <= $2::timestamptz - make_interval(hours => $4)
    ON CONFLICT (user_id) DO NOTHING RETURNING claim_token`,
    [userId, now, FEEDBACK_RULES.minDistinctSourceOpens, FEEDBACK_RULES.minExperienceHours]);
  if (claimed) return { show: true, token: claimed.claim_token };

  if (options.resumeToken && UUID.test(options.resumeToken)) {
    const { rows: [resumed] } = await db.query<{ claim_token: string }>(`UPDATE customer_feedback_invitations i SET claim_token = gen_random_uuid()
      FROM users u WHERE i.user_id = $1 AND u.id = i.user_id AND u.lead_monitoring_status = 'active'
        AND i.status = 'shown' AND i.claim_token = $2 AND i.shown_at > $3::timestamptz - make_interval(mins => $4)
      RETURNING i.claim_token`, [userId, options.resumeToken, now, FEEDBACK_RULES.resumeMinutes]);
    if (resumed) return { show: true, token: resumed.claim_token };
  }
  const { rows: [existing] } = await db.query<{ status: string }>('SELECT status FROM customer_feedback_invitations WHERE user_id = $1', [userId]);
  // `final`: this account will never be invited automatically again, so the browser can stop asking.
  return { show: false, final: Boolean(existing) };
}

/** X or "Không, cảm ơn" on the invitation. Final; idempotent; a submitted invitation stays submitted. */
export async function declineFeedbackInvitation(db: Queryable, userId: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const { rowCount } = await db.query(`UPDATE customer_feedback_invitations SET status = 'declined', responded_at = $2, claim_token = NULL
    WHERE user_id = $1 AND status = 'shown'`, [userId, now]);
  return Boolean(rowCount);
}

export type FeedbackAnswers = {
  submissionId: string;
  /** Which form the customer used; the server still decides whether it counts as the invitation answer. */
  context: 'invitation' | 'voluntary';
  easeRating: number | null;
  needsRating: number | null;
  unmetReason: string | null;
  improvement: string | null;
};

/**
 * Trims, normalizes line breaks, drops control characters (including bidi overrides that could make an Admin read text
 * reversed) and empty text. Never invents a value.
 */
export function normalizeFeedbackText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return text ? text.slice(0, max) : null;
}

export function hasAnyAnswer(answers: Pick<FeedbackAnswers, 'easeRating' | 'needsRating' | 'unmetReason' | 'improvement'>): boolean {
  return answers.easeRating !== null || answers.needsRating !== null || answers.unmetReason !== null || answers.improvement !== null;
}

export type SubmitResult = { ok: true; duplicate: boolean; source: 'invitation' | 'voluntary' } | { ok: false; error: 'empty' | 'invalid' | 'rate_limited' | 'conflict' };

const rating = (value: number | null) => value === null || (Number.isInteger(value) && value >= 1 && value <= 5);

/**
 * Saves one set of answers. Must run inside a transaction (the invitation row is locked). The same submission id is
 * accepted once: a retry gets `duplicate: true` and changes nothing. Answers count as the invitation answer only while
 * this account's invitation is 'shown'; anything else is voluntary. Either way the account is never invited again.
 */
export async function submitCustomerFeedback(client: PoolClient, userId: string, answers: FeedbackAnswers, now: Date = new Date()): Promise<SubmitResult> {
  if (!UUID.test(userId) || !UUID.test(answers.submissionId)) return { ok: false, error: 'invalid' };
  if (!rating(answers.easeRating) || !rating(answers.needsRating)) return { ok: false, error: 'invalid' };
  if ((answers.unmetReason?.length ?? 0) > FEEDBACK_LIMITS.unmetReason || (answers.improvement?.length ?? 0) > FEEDBACK_LIMITS.improvement) return { ok: false, error: 'invalid' };
  if (!hasAnyAnswer(answers)) return { ok: false, error: 'empty' };

  // Serializes this account's submissions (two tabs, double click) without touching any other table's locks.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 19))', [`customer-feedback:${userId}`]);
  const { rows: [previous] } = await client.query<{ user_id: string; source: 'invitation' | 'voluntary' }>('SELECT user_id, source FROM customer_feedback WHERE submission_id = $1', [answers.submissionId]);
  if (previous) return previous.user_id === userId ? { ok: true, duplicate: true, source: previous.source } : { ok: false, error: 'conflict' };

  const { rows: [invitation] } = await client.query<{ status: string }>('SELECT status FROM customer_feedback_invitations WHERE user_id = $1 FOR UPDATE', [userId]);
  const source = answers.context === 'invitation' && invitation?.status === 'shown' ? 'invitation' : 'voluntary';
  if (source === 'voluntary') {
    const { rows: [recent] } = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM customer_feedback
      WHERE user_id = $1 AND source = 'voluntary' AND created_at > $2::timestamptz - interval '24 hours'`, [userId, now]);
    if ((recent?.count ?? 0) >= FEEDBACK_RULES.voluntaryPerDay) return { ok: false, error: 'rate_limited' };
  }
  await client.query(`INSERT INTO customer_feedback(user_id, submission_id, source, ease_rating, needs_rating, unmet_reason, improvement, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, answers.submissionId, source, answers.easeRating, answers.needsRating, answers.unmetReason, answers.improvement, now]);
  // Someone who already gave feedback is never asked automatically; a declined invitation stays declined.
  await client.query(`INSERT INTO customer_feedback_invitations(user_id, status, responded_at) VALUES ($1, 'submitted', $2)
    ON CONFLICT (user_id) DO UPDATE SET status = 'submitted', responded_at = EXCLUDED.responded_at, claim_token = NULL
    WHERE customer_feedback_invitations.status = 'shown'`, [userId, now]);
  return { ok: true, duplicate: false, source };
}

export type FeedbackFilter = 'all' | 'low';
export type AdminFeedbackItem = {
  id: string; createdAt: string; source: 'invitation' | 'voluntary';
  easeRating: number | null; needsRating: number | null; unmetReason: string | null; improvement: string | null;
  user: { id: string; displayName: string; email: string | null } | null;
};
export type AdminFeedbackReport = {
  stats: {
    responses: number; ratedResponses: number;
    easeAverage: number | null; easeCount: number; needsAverage: number | null; needsCount: number;
    /** Index 0 = 1 star … index 4 = 5 stars. */
    easeDistribution: number[]; needsDistribution: number[];
    withText: number; lowRated: number;
    invitations: { shown: number; submitted: number; declined: number };
  };
  items: AdminFeedbackItem[]; total: number; limit: number; offset: number; filter: FeedbackFilter;
};

/** A rating of 1 or 2 stars on either question. */
export const LOW_RATING_SQL = '(f.ease_rating <= 2 OR f.needs_rating <= 2)';

/** Everything /admin/feedback shows. Only called behind the server-side Admin allowlist. */
export async function getAdminFeedbackReport(db: Queryable, options: { filter: FeedbackFilter; limit: number; offset: number }): Promise<AdminFeedbackReport> {
  const where = options.filter === 'low' ? `WHERE ${LOW_RATING_SQL}` : '';
  const [{ rows: [stats] }, { rows: dist }, { rows: [inv] }, { rows: [count] }, { rows }] = await Promise.all([
    db.query(`SELECT count(*)::int AS responses,
        count(*) FILTER (WHERE f.ease_rating IS NOT NULL OR f.needs_rating IS NOT NULL)::int AS rated,
        round(avg(f.ease_rating), 2)::float AS ease_avg, count(f.ease_rating)::int AS ease_count,
        round(avg(f.needs_rating), 2)::float AS needs_avg, count(f.needs_rating)::int AS needs_count,
        count(*) FILTER (WHERE f.unmet_reason IS NOT NULL OR f.improvement IS NOT NULL)::int AS with_text,
        count(*) FILTER (WHERE ${LOW_RATING_SQL})::int AS low_rated
      FROM customer_feedback f`),
    db.query<{ star: number; ease: number; needs: number }>(`SELECT s.star,
        (SELECT count(*)::int FROM customer_feedback WHERE ease_rating = s.star) AS ease,
        (SELECT count(*)::int FROM customer_feedback WHERE needs_rating = s.star) AS needs
      FROM generate_series(1, 5) AS s(star) ORDER BY s.star`),
    db.query(`SELECT count(*) FILTER (WHERE status = 'shown')::int AS shown, count(*) FILTER (WHERE status = 'submitted' AND shown_at IS NOT NULL)::int AS submitted,
        count(*) FILTER (WHERE status = 'declined')::int AS declined FROM customer_feedback_invitations`),
    db.query<{ total: number }>(`SELECT count(*)::int AS total FROM customer_feedback f ${where}`),
    db.query(`SELECT f.id, f.created_at, f.source, f.ease_rating, f.needs_rating, f.unmet_reason, f.improvement, u.id AS user_id, u.display_name, ua.email
      FROM customer_feedback f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN user_accounts ua ON ua.user_id = f.user_id
      ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT $1 OFFSET $2`, [options.limit, options.offset]),
  ]);
  return {
    stats: {
      responses: stats.responses, ratedResponses: stats.rated,
      easeAverage: stats.ease_avg, easeCount: stats.ease_count, needsAverage: stats.needs_avg, needsCount: stats.needs_count,
      easeDistribution: dist.map(d => d.ease), needsDistribution: dist.map(d => d.needs),
      withText: stats.with_text, lowRated: stats.low_rated,
      invitations: { shown: inv.shown, submitted: inv.submitted, declined: inv.declined },
    },
    items: rows.map(row => ({
      id: row.id, createdAt: new Date(row.created_at).toISOString(), source: row.source,
      easeRating: row.ease_rating, needsRating: row.needs_rating, unmetReason: row.unmet_reason, improvement: row.improvement,
      user: row.user_id ? { id: row.user_id, displayName: row.display_name, email: row.email ?? null } : null,
    })),
    total: count?.total ?? 0, limit: options.limit, offset: options.offset, filter: options.filter,
  };
}
