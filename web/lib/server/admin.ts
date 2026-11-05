import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { notFound } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';
import type { PoolClient } from 'pg';
import { displayState, HandoffError, OPEN_HANDOFF, refreshHandoff } from '../../../src/handoff';
import { db } from './db';
import { isSameOrigin } from './request-guard';
import { getSession, requireSession, type SessionUser } from './session';

/**
 * Admin access is a server-side allowlist of QLead user ids (QLEAD_ADMIN_USER_IDS, comma separated).
 * Customers never reach these pages or APIs, whatever the browser sends.
 */
export const ADMIN_HEADER = 'x-qlead-admin';

export function isAdmin(userId: string): boolean {
  return (process.env.QLEAD_ADMIN_USER_IDS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(userId.toLowerCase());
}

/** For admin pages: unauthenticated users go to login, non-admins get a plain 404. */
export async function requireAdmin(): Promise<SessionUser> {
  const session = await requireSession();
  if (!isAdmin(session.userId)) notFound();
  return session;
}

/** For admin API routes. State-changing calls also need a same-origin Origin and the custom header (CSRF). */
export async function adminApiGuard(request: NextRequest, mutating: boolean): Promise<SessionUser | NextResponse> {
  if (mutating && (!isSameOrigin(request) || request.headers.get(ADMIN_HEADER) !== '1')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isAdmin(session.userId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return session;
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HandoffError) return NextResponse.json({ error: error.code, message: error.message, details: error.details ?? null }, { status: 409 });
  console.error('Admin request failed:', error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'internal_error', message: 'Không thực hiện được. Thử lại sau.' }, { status: 500 });
}

/** A fresh worker credential. Only the hash is stored; the caller shows the value once and never logs it. */
export function newCredential(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

export function workerPublicUrl(): string | null {
  const url = process.env.QLEAD_WORKER_PUBLIC_URL?.trim();
  return url && /^https:\/\/[^\s/]+$/.test(url) ? url : null;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export type AdminWorker = {
  id: string; name: string; status: string; state: string; connected: boolean; standbyContact: boolean; credentialStatus: string;
  authorizedSources: string[]; maxJobsPerClaim: number; leaseMinutes: number;
  connectionVerifiedAt: string | null; lastSeenAt: string | null; lastClaimAt: string | null; lastSuccessfulClaimAt: string | null; lastSuccessAt: string | null; statusChangedAt: string;
  inFlight: number; completedAttempts: number; failedAttempts24h: number; avgSeconds: number | null;
  recentErrors: Array<{ at: string; outcome: string; code: string | null; message: string | null }>;
};
export type AdminHandoff = {
  id: string; status: string; mode: string; sourceId: string; sourceName: string; destinationId: string; destinationName: string;
  createdAt: string; drainStartedAt: string | null; cutoverAt: string | null; firstContactAt: string | null; firstClaimAt: string | null; firstSuccessAt: string | null;
  finishedAt: string | null; releasedJobs: number; failureReason: string | null; preparedSummary: any; cutoverSummary: any; events: Array<{ at: string; type: string; detail: any }>;
};
export type AdminOverview = {
  generatedAt: string; workers: AdminWorker[]; openHandoff: AdminHandoff | null; history: AdminHandoff[];
  queue: { pending: number; claimed: number; retry: number; blocked: number; needsReauth: number; failed24h: number; oldestPendingSlot: string | null };
  profiles: { active: number; withGap: number }; publicUrl: string | null;
  /** Which QLead this page manages. */
  environment: 'local' | 'production';
};

const currentEnvironment = (): 'local' | 'production' => (process.env.QLEAD_ENVIRONMENT?.trim().toLowerCase() === 'production' ? 'production' : 'local');

function toHandoff(row: any): AdminHandoff {
  return {
    id: row.id, status: row.status, mode: row.mode, sourceId: row.source_worker_id, sourceName: row.source_name, destinationId: row.destination_worker_id, destinationName: row.destination_name,
    createdAt: iso(row.created_at)!, drainStartedAt: iso(row.drain_started_at), cutoverAt: iso(row.cutover_at), firstContactAt: iso(row.destination_first_contact_at),
    firstClaimAt: iso(row.destination_first_claim_at), firstSuccessAt: iso(row.destination_first_success_at), finishedAt: iso(row.finished_at),
    releasedJobs: row.released_jobs, failureReason: row.failure_reason, preparedSummary: row.prepared_summary, cutoverSummary: row.cutover_summary, events: row.events,
  };
}

/** Everything the admin page shows, read from PostgreSQL. Advances an open handoff from recorded evidence first. */
export async function getAdminOverview(): Promise<AdminOverview> {
  return withTx(async client => {
    const { rows: [open] } = await client.query(`SELECT id FROM worker_handoffs WHERE status = ANY($1::text[]) LIMIT 1`, [[...OPEN_HANDOFF]]);
    if (open) await refreshHandoff(client, open.id);
    const { rows: workers } = await client.query(`SELECT w.*,
        (SELECT max(claimed_at) FROM search_job_attempts WHERE worker_id = w.id) AS last_successful_claim_at,
        (SELECT count(*)::int FROM search_jobs WHERE claimed_by_worker_id = w.id AND status = 'claimed' AND lease_expires_at > now()) AS in_flight,
        (SELECT count(*)::int FROM search_job_attempts WHERE worker_id = w.id AND outcome = 'completed') AS completed_attempts,
        (SELECT count(*)::int FROM search_job_attempts WHERE worker_id = w.id AND outcome IN ('failed', 'needs_reauthorization', 'expired') AND claimed_at > now() - interval '24 hours') AS failed_24h,
        (SELECT round(avg(extract(epoch FROM finished_at - claimed_at)))::int FROM (SELECT finished_at, claimed_at FROM search_job_attempts WHERE worker_id = w.id AND outcome = 'completed' ORDER BY finished_at DESC LIMIT 20) x) AS avg_seconds,
        (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (SELECT coalesce(a.finished_at, a.claimed_at) AS at, a.outcome, a.error->>'code' AS code, a.error->>'message' AS message FROM search_job_attempts a
          WHERE a.worker_id = w.id AND a.outcome IN ('failed', 'needs_reauthorization', 'expired') ORDER BY a.claimed_at DESC LIMIT 3) x) AS recent_errors
      FROM muse_workers w ORDER BY w.created_at`);
    const { rows: handoffs } = await client.query(`SELECT h.*, s.name AS source_name, d.name AS destination_name FROM worker_handoffs h
      JOIN muse_workers s ON s.id = h.source_worker_id JOIN muse_workers d ON d.id = h.destination_worker_id ORDER BY h.created_at DESC LIMIT 10`);
    const { rows: [queue] } = await client.query(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at > now())::int AS claimed,
        count(*) FILTER (WHERE status = 'pending' AND attempts > 0)::int AS retry, count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
        count(*) FILTER (WHERE status = 'needs_reauthorization')::int AS needs_reauth, count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '24 hours')::int AS failed_24h,
        min(scheduled_for) FILTER (WHERE status = 'pending') AS oldest FROM search_jobs`);
    const { rows: [profiles] } = await client.query(`SELECT count(*)::int AS active,
        count(*) FILTER (WHERE last_success IS NULL OR last_success < now() - make_interval(mins => 2 * frequency_minutes))::int AS with_gap
      FROM (SELECT sc.frequency_minutes, (SELECT max(received_at) FROM scan_runs WHERE agent_connection_id = ac.id AND status IN ('success', 'partial')) AS last_success
        FROM agent_connections ac JOIN LATERAL (SELECT frequency_minutes, enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
        WHERE ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled) p`);
    const mapped = handoffs.map(toHandoff);
    return {
      generatedAt: new Date().toISOString(),
      workers: workers.map(w => ({
        id: w.id, name: w.name, status: w.status, ...(({ state, connected, standbyContact }) => ({ state, connected, standbyContact }))(displayState(w)),
        credentialStatus: w.credential_status, authorizedSources: w.authorized_sources, maxJobsPerClaim: w.max_jobs_per_claim, leaseMinutes: w.lease_minutes,
        connectionVerifiedAt: iso(w.connection_verified_at), lastSeenAt: iso(w.last_seen_at), lastClaimAt: iso(w.last_claim_at), lastSuccessfulClaimAt: iso(w.last_successful_claim_at), lastSuccessAt: iso(w.last_success_at), statusChangedAt: iso(w.status_changed_at)!,
        inFlight: w.in_flight, completedAttempts: w.completed_attempts, failedAttempts24h: w.failed_24h, avgSeconds: w.avg_seconds,
        recentErrors: w.recent_errors.map((e: any) => ({ at: iso(e.at)!, outcome: e.outcome, code: e.code, message: e.message })),
      })),
      openHandoff: mapped.find(h => (OPEN_HANDOFF as readonly string[]).includes(h.status)) ?? null,
      history: mapped,
      queue: { pending: queue.pending, claimed: queue.claimed, retry: queue.retry, blocked: queue.blocked, needsReauth: queue.needs_reauth, failed24h: queue.failed_24h, oldestPendingSlot: iso(queue.oldest) },
      profiles: { active: profiles.active, withGap: profiles.with_gap },
      publicUrl: workerPublicUrl(),
      environment: currentEnvironment(),
    };
  });
}
