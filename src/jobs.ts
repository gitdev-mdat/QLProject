import type { PoolClient } from 'pg';
import { planEarlyFollowup } from './search-plan.js';

/**
 * Shared-worker job lifecycle. PostgreSQL is the source of truth: ownership comes from search_jobs.search_profile_id,
 * never from anything a worker sends. Every function here runs inside the caller's transaction.
 *
 * pending -> claimed -> completed
 *                    -> pending (retryable failure, expired lease, admin release) -> ... -> failed (attempts exhausted)
 *                    -> needs_reauthorization (worker reports lost source access; admin must unblock)
 * pending -> blocked (active workers exist but none is authorized for the job's sources; auto-unblocks)
 */
export type Worker = { id: string; name: string; status: string; authorized_sources: string[]; max_jobs_per_claim: number; lease_minutes: number };
/**
 * What a worker receives. `keywords` are the exact phrases to search and `location` is '' when the customer set no
 * geographic limit. `intent.description` is the customer's own words for this configuration version, for judging
 * which posts fit; `intent.keywords_source` says whether QLead generated the phrases from it or the customer wrote them.
 */
export type JobSearch = { keywords: string[]; location: string; sources: string[]; intent: { description: string | null; keywords_source: 'description' | 'manual' } };
export type ClaimedJob = { job_id: string; scan_id: string; attempt_no: number; lease_expires_at: string; configuration_version: number; kind: 'scheduled' | 'initial' | 'manual' | 'followup'; search: JobSearch };

export const RETRY_DELAY_MINUTES = 5;
/** Initial and customer-requested scans get a short head start, then rejoin the same age-ordered queue as recurring work. */
export const PRIORITY_SCAN_BOOST_MINUTES = 30;
export const FOLLOWUP_SCAN_BOOST_MINUTES = 5;

/**
 * Creates at most one job per enabled profile for the current schedule slot, skipping profiles with an open job and
 * profiles that already had a job in this slot. A first scan or a customer-requested scan also holds off the routine
 * slot for half an interval, so a profile is not scanned twice within seconds around a slot boundary.
 */
export async function enqueueDueJobs(client: PoolClient, profileId?: string): Promise<number> {
  const { rowCount } = await client.query(`INSERT INTO search_jobs (search_profile_id, configuration_version, scan_id, scheduled_for, required_sources)
    SELECT ac.id, sc.version, 'job-' || gen_random_uuid(), slot.start, sc.sources
    FROM agent_connections ac
    JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
    JOIN LATERAL (SELECT version, enabled, sources, frequency_minutes FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    CROSS JOIN LATERAL (SELECT to_timestamp(floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60)) * sc.frequency_minutes * 60) AS start) slot
    WHERE ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled
      AND ($1::uuid IS NULL OR ac.id = $1)
      AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.search_profile_id = ac.id AND j.status <> 'cancelled'
        AND (j.scheduled_for >= slot.start OR (j.kind IN ('initial', 'manual') AND j.scheduled_for > now() - make_interval(secs => sc.frequency_minutes * 30))))
    ON CONFLICT DO NOTHING`, [profileId ?? null]);
  return rowCount ?? 0;
}

/**
 * Queues the first scan of a profile that was just saved or resumed enabled and has never been scanned. Idempotent:
 * the open-job and one-initial-job indexes turn repeats into no-ops. Workers claim initial jobs before routine
 * slots; each profile gets at most one, so they cannot starve the recurring queue.
 */
export async function enqueueInitialJob(client: PoolClient, profileId: string): Promise<boolean> {
  const { rowCount } = await client.query(`INSERT INTO search_jobs (search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind)
    SELECT ac.id, sc.version, 'job-' || gen_random_uuid(), now(), sc.sources, 'initial'
    FROM agent_connections ac
    JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
    JOIN LATERAL (SELECT version, enabled, sources FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    WHERE ac.id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled
      AND NOT EXISTS (SELECT 1 FROM scan_runs WHERE agent_connection_id = ac.id)
    ON CONFLICT DO NOTHING`, [profileId]);
  return (rowCount ?? 0) > 0;
}

/** Queues at most one complementary follow-up for a successful, sparse initial scan. Caller holds profile lock. */
export async function enqueueInitialFollowup(client: PoolClient, profileId: string, version: number, exploredQueries: string[] = []): Promise<boolean> {
  const { rows: [config] } = await client.query<{ description: string | null; keywords: string[]; keywords_source: string; sources: string[]; enabled: boolean; monitoring_status: string }>(`SELECT sc.description, sc.keywords, sc.keywords_source, sc.sources, sc.enabled, u.lead_monitoring_status AS monitoring_status
    FROM scan_configs sc JOIN agent_connections ac ON ac.id = sc.agent_connection_id JOIN users u ON u.id = ac.user_id
    WHERE sc.agent_connection_id = $1 AND sc.version = $2 AND ac.status = 'active' AND ac.kind = 'search_profile'
      AND sc.version = (SELECT max(latest.version) FROM scan_configs latest WHERE latest.agent_connection_id = sc.agent_connection_id)`, [profileId, version]);
  if (!config || !config.enabled || config.monitoring_status !== 'active' || !config.description) return false;
  const keywords = planEarlyFollowup(config.description, exploredQueries.length ? exploredQueries : config.keywords ?? []);
  if (!keywords.length) return false;
  const { rowCount } = await client.query(`INSERT INTO search_jobs (search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind)
    SELECT $1, $2, 'job-' || gen_random_uuid(), now() + interval '3 minutes', $3, 'followup'
    WHERE NOT EXISTS (SELECT 1 FROM search_jobs WHERE search_profile_id = $1 AND status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization'))
    ON CONFLICT DO NOTHING`, [profileId, version, JSON.stringify(config.sources)]);
  return (rowCount ?? 0) > 0;
}

/** Records a terminal failure in the customer's scan history so delayed or missed monitoring is visible. */
async function recordFailedScan(client: PoolClient, jobId: string, workerId: string | null, errors: unknown[]): Promise<void> {
  await client.query(`INSERT INTO scan_runs (agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped, status, errors, search_job_id, executed_by_worker_id)
    SELECT search_profile_id, scan_id, configuration_version, now(), 0, 0, 0, 0, 'failed', $3, id, $2 FROM search_jobs WHERE id = $1
    ON CONFLICT DO NOTHING`, [jobId, workerId, JSON.stringify(errors)]);
}

/** Returns jobs whose lease ran out to the queue, or fails them when no attempts remain. */
export async function expireLeases(client: PoolClient, profileId?: string): Promise<number> {
  const { rows } = await client.query<{ id: string; current_attempt_id: string | null; claimed_by_worker_id: string | null; exhausted: boolean }>(`SELECT id, current_attempt_id, claimed_by_worker_id, attempts >= max_attempts AS exhausted
    FROM search_jobs WHERE status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      AND ($1::uuid IS NULL OR search_profile_id = $1) FOR UPDATE SKIP LOCKED`, [profileId ?? null]);
  for (const job of rows) {
    await client.query(`UPDATE search_job_attempts SET outcome = 'expired', finished_at = now() WHERE id = $1 AND outcome = 'running'`, [job.current_attempt_id]);
    await client.query(`UPDATE search_jobs SET status = $2, claimed_by_worker_id = NULL, current_attempt_id = NULL, lease_expires_at = NULL,
      last_error = 'lease_expired', available_at = now(), updated_at = now(), completed_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
    [job.id, job.exhausted ? 'failed' : 'pending']);
    if (job.exhausted) await recordFailedScan(client, job.id, job.claimed_by_worker_id, [{ code: 'lease_expired', message: 'No worker finished the scan in time.' }]);
  }
  return rows.length;
}

/**
 * Blocks pending jobs that no active worker is authorized to run, and unblocks them once one is. With no active
 * worker at all, jobs stay pending: that is lost capacity (delay), not lost authorization.
 */
export async function reconcileSourceAuthorization(client: PoolClient, profileId?: string): Promise<void> {
  await client.query(`UPDATE search_jobs j SET status = 'blocked', last_error = 'no_authorized_worker', updated_at = now()
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    WHERE j.status = 'pending'
      AND j.search_profile_id = ac.id AND u.lead_monitoring_status = 'active'
      AND ($1::uuid IS NULL OR j.search_profile_id = $1)
      AND EXISTS (SELECT 1 FROM muse_workers WHERE status = 'active' AND credential_status = 'active')
      AND NOT EXISTS (SELECT 1 FROM muse_workers w WHERE w.status = 'active' AND w.credential_status = 'active' AND w.authorized_sources @> j.required_sources)`, [profileId ?? null]);
  await client.query(`UPDATE search_jobs j SET status = 'pending', last_error = NULL, available_at = now(), updated_at = now()
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    WHERE j.status = 'blocked' AND j.last_error = 'no_authorized_worker'
      AND j.search_profile_id = ac.id AND u.lead_monitoring_status = 'active'
      AND ($1::uuid IS NULL OR j.search_profile_id = $1)
      AND EXISTS (SELECT 1 FROM muse_workers w WHERE w.status = 'active' AND w.credential_status = 'active' AND w.authorized_sources @> j.required_sources)`, [profileId ?? null]);
}

/** Atomically assigns due work, bounded by both the request size and this worker's live-lease capacity. */
export async function claimJobs(client: PoolClient, worker: Worker, requested: number, profileId?: string): Promise<ClaimedJob[]> {
  // Serialize claims for one worker so simultaneous polls cannot exceed its live lease capacity.
  const { rows: [currentWorker] } = await client.query<Worker>(`SELECT id, name, status, authorized_sources, max_jobs_per_claim, lease_minutes
    FROM muse_workers WHERE id = $1 FOR UPDATE`, [worker.id]);
  if (!currentWorker) return [];
  worker = currentWorker;
  await expireLeases(client, profileId);
  // A deliberately scoped claim can safely repair a never-scanned profile whose initial enqueue was missed.
  if (profileId && worker.status === 'active') await enqueueInitialJob(client, profileId);
  await enqueueDueJobs(client, profileId);
  await reconcileSourceAuthorization(client, profileId);
  if (worker.status !== 'active') return [];
  const { rows: [active] } = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM search_jobs
    WHERE status = 'claimed' AND claimed_by_worker_id = $1 AND lease_expires_at > now()`, [worker.id]);
  const availableSlots = Math.max(0, worker.max_jobs_per_claim - (active?.count ?? 0));
  const limit = Math.min(Math.max(1, Math.min(requested, worker.max_jobs_per_claim)), availableSlots);
  if (limit === 0) return [];
  const { rows: jobs } = await client.query<{ id: string; attempts: number; kind: ClaimedJob['kind'] }>(`SELECT j.id, j.attempts, j.kind FROM search_jobs j
    JOIN agent_connections ac ON ac.id = j.search_profile_id
    JOIN users u ON u.id = ac.user_id
    WHERE j.status = 'pending' AND j.scheduled_for <= now() AND j.available_at <= now() AND $1::jsonb @> j.required_sources
      AND u.lead_monitoring_status = 'active'
      AND ($3::uuid IS NULL OR j.search_profile_id = $3)
    ORDER BY (j.scheduled_for - CASE WHEN j.kind IN ('initial', 'manual') THEN make_interval(mins => ${PRIORITY_SCAN_BOOST_MINUTES}) WHEN j.kind = 'followup' THEN make_interval(mins => ${FOLLOWUP_SCAN_BOOST_MINUTES}) ELSE interval '0 minutes' END),
      j.scheduled_for, j.created_at, j.search_profile_id, j.id LIMIT $2 FOR UPDATE OF j, u SKIP LOCKED`, [JSON.stringify(worker.authorized_sources), limit, profileId ?? null]);
  const claimed: ClaimedJob[] = [];
  for (const job of jobs) {
    // attempt_no numbers every assignment; `attempts` counts only those that may end in failure (released ones are refunded).
    const { rows: [attempt] } = await client.query<{ id: string; attempt_no: number; lease_expires_at: Date }>(`INSERT INTO search_job_attempts (job_id, worker_id, attempt_no, lease_expires_at)
      SELECT $1, $2, coalesce(max(attempt_no), 0) + 1, now() + make_interval(mins => $3) FROM search_job_attempts WHERE job_id = $1
      RETURNING id, attempt_no, lease_expires_at`, [job.id, worker.id, worker.lease_minutes]);
    if (!attempt) throw new Error('attempt insert returned no row');
    const attemptNo = attempt.attempt_no;
    const { rows: [row] } = await client.query(`UPDATE search_jobs j SET status = 'claimed', attempts = $3, claimed_by_worker_id = $2, current_attempt_id = $4,
        lease_expires_at = $5, updated_at = now()
      FROM scan_configs sc WHERE j.id = $1 AND sc.agent_connection_id = j.search_profile_id AND sc.version = j.configuration_version
      RETURNING j.id, j.scan_id, j.configuration_version, j.kind, sc.keywords, sc.location, sc.sources, sc.description, sc.keywords_source,
        (SELECT sr.keywords_used FROM scan_runs sr JOIN search_jobs ij ON ij.id = sr.search_job_id
          WHERE ij.search_profile_id = j.search_profile_id AND ij.configuration_version = j.configuration_version AND ij.kind = 'initial'
            AND sr.status IN ('success', 'partial') ORDER BY sr.received_at DESC LIMIT 1) AS initial_keywords_used`, [job.id, worker.id, job.attempts + 1, attempt.id, attempt.lease_expires_at]);
    const keywords = job.kind === 'followup'
      ? planEarlyFollowup(row.description ?? '', row.initial_keywords_used?.length ? row.initial_keywords_used : row.keywords ?? [])
      : row.keywords;
    claimed.push({
      job_id: row.id, scan_id: row.scan_id, attempt_no: attemptNo, lease_expires_at: attempt.lease_expires_at.toISOString(),
      configuration_version: row.configuration_version, kind: row.kind,
      search: { keywords, location: row.location, sources: row.sources, intent: { description: row.description, keywords_source: row.keywords_source } },
    });
  }
  return claimed;
}

/**
 * After a search-relevant edit, a profile's not-yet-claimed work must not run the old conditions. Queued jobs from an
 * older version are cancelled (kept as history), and a scan the customer was waiting for (first scan or a requested
 * one) is queued again under the new version straight away. Routine slots need nothing: a cancelled slot does not
 * count as done, so the next claim recreates it from the latest version. A job already claimed keeps its version and
 * finishes against it; its results never touch the newer configuration.
 */
export async function supersedeQueuedJobs(client: PoolClient, profileId: string, version: number): Promise<number> {
  const { rows } = await client.query<{ kind: string; requested_by_user_id: string | null }>(`UPDATE search_jobs SET status = 'cancelled', last_error = 'superseded_by_edit',
      updated_at = now(), completed_at = now()
    WHERE search_profile_id = $1 AND status IN ('pending', 'blocked') AND configuration_version < $2 RETURNING kind, requested_by_user_id`, [profileId, version]);
  for (const job of rows) {
    if (job.kind === 'initial') await enqueueInitialJob(client, profileId);
    if (job.kind === 'manual') await insertManualJob(client, profileId, job.requested_by_user_id);
  }
  return rows.length;
}

async function insertManualJob(client: PoolClient, profileId: string, userId: string | null): Promise<string | undefined> {
  const { rows: [job] } = await client.query<{ id: string }>(`INSERT INTO search_jobs (search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind, requested_by_user_id)
    SELECT ac.id, sc.version, 'job-' || gen_random_uuid(), now(), sc.sources, 'manual', $2
    FROM agent_connections ac
    JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
    JOIN LATERAL (SELECT version, enabled, sources FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    WHERE ac.id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled
    ON CONFLICT DO NOTHING RETURNING id`, [profileId, userId]);
  return job?.id;
}

/** A finished scan of the same configuration this recent makes another request wasteful. */
export const MANUAL_SCAN_COOLDOWN_MINUTES = 15;
/** Customer-requested scans per user per rolling 24 hours, across all their profiles. Routine monitoring is not counted. */
export const MANUAL_SCAN_DAILY_LIMIT = 10;

export type ScanRequest =
  | { outcome: 'queued' | 'existing'; jobId: string }
  | { outcome: 'cooldown'; retryAfterSeconds: number; lastFinishedAt: string }
  | { outcome: 'daily_limit' | 'paused' | 'suspended' | 'not_found' };

/**
 * Queues a scan the customer asked for, with the profile's latest configuration. The caller must hold the profile
 * row lock (SELECT ... FOR UPDATE), so concurrent clicks are serialised: when any job for the profile is already open
 * the request returns that job instead of adding work, and the open-job index backs this up. Nothing here contacts a
 * worker: the new pending job is what the public wake signal reports as eligible work.
 */
export async function requestManualJob(client: PoolClient, profileId: string, userId: string): Promise<ScanRequest> {
  const { rows: [config] } = await client.query<{ version: number; enabled: boolean; monitoring_status: string }>(`SELECT sc.version, sc.enabled, u.lead_monitoring_status AS monitoring_status FROM agent_connections ac
    JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT version, enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    WHERE ac.id = $1 AND ac.user_id = $2 AND ac.kind = 'search_profile' AND ac.status = 'active'`, [profileId, userId]);
  if (!config) return { outcome: 'not_found' };
  if (config.monitoring_status !== 'active') return { outcome: 'suspended' };
  if (!config.enabled) return { outcome: 'paused' };
  const open = async () => (await client.query<{ id: string }>(`SELECT id FROM search_jobs WHERE search_profile_id = $1
    AND status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization') LIMIT 1`, [profileId])).rows[0];
  const existing = await open();
  if (existing) return { outcome: 'existing', jobId: existing.id };
  const { rows: [recent] } = await client.query<{ finished_at: Date; wait: number }>(`SELECT completed_at AS finished_at,
      ceil(extract(epoch FROM completed_at + make_interval(mins => $3) - now()))::int AS wait
    FROM search_jobs WHERE search_profile_id = $1 AND configuration_version = $2 AND status IN ('completed', 'failed')
      AND completed_at > now() - make_interval(mins => $3)
    ORDER BY completed_at DESC LIMIT 1`, [profileId, config.version, MANUAL_SCAN_COOLDOWN_MINUTES]);
  if (recent) return { outcome: 'cooldown', retryAfterSeconds: Math.max(1, recent.wait), lastFinishedAt: recent.finished_at.toISOString() };
  const { rows: [usage] } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_jobs
    WHERE kind = 'manual' AND requested_by_user_id = $1 AND status <> 'cancelled' AND created_at > now() - interval '24 hours'`, [userId]);
  if (usage!.n >= MANUAL_SCAN_DAILY_LIMIT) return { outcome: 'daily_limit' };
  const jobId = await insertManualJob(client, profileId, userId);
  if (jobId) return { outcome: 'queued', jobId };
  const raced = await open();
  return raced ? { outcome: 'existing', jobId: raced.id } : { outcome: 'not_found' };
}

export type JobRow = { id: string; search_profile_id: string; configuration_version: number; scan_id: string; kind: ClaimedJob['kind']; status: string; attempts: number; max_attempts: number; claimed_by_worker_id: string | null; current_attempt_id: string | null; attempt_no: number | null; lease_valid: boolean };

export async function lockJob(client: PoolClient, jobId: string): Promise<JobRow | undefined> {
  const { rows } = await client.query<JobRow>(`SELECT j.id, j.search_profile_id, j.configuration_version, j.scan_id, j.kind, j.status, j.attempts, j.max_attempts, j.claimed_by_worker_id, j.current_attempt_id,
      a.attempt_no, coalesce(j.lease_expires_at > now(), false) AS lease_valid
    FROM search_jobs j LEFT JOIN search_job_attempts a ON a.id = j.current_attempt_id WHERE j.id = $1 FOR UPDATE OF j`, [jobId]);
  return rows[0];
}

export async function markCompleted(client: PoolClient, job: JobRow, workerId: string): Promise<void> {
  await client.query(`UPDATE search_job_attempts SET outcome = 'completed', finished_at = now() WHERE id = $1`, [job.current_attempt_id]);
  await client.query(`UPDATE search_jobs SET status = 'completed', lease_expires_at = NULL, last_error = NULL, completed_at = now(), updated_at = now() WHERE id = $1`, [job.id]);
  await client.query('UPDATE muse_workers SET last_success_at = now() WHERE id = $1', [workerId]);
}

export type FailureCode = 'execution_error' | 'rate_limited' | 'source_unavailable' | 'needs_reauthorization';

/** Applies a worker-reported failure. Returns the job's resulting status. */
export async function markFailed(client: PoolClient, job: JobRow, workerId: string, code: FailureCode, message: string, retryable: boolean): Promise<string> {
  const error = { code, message };
  const reauth = code === 'needs_reauthorization';
  const terminal = !reauth && (!retryable || job.attempts >= job.max_attempts);
  const status = reauth ? 'needs_reauthorization' : terminal ? 'failed' : 'pending';
  await client.query(`UPDATE search_job_attempts SET outcome = $2, finished_at = now(), error = $3 WHERE id = $1`,
    [job.current_attempt_id, reauth ? 'needs_reauthorization' : 'failed', JSON.stringify(error)]);
  await client.query(`UPDATE search_jobs SET status = $2, claimed_by_worker_id = CASE WHEN $2 = 'pending' THEN NULL ELSE claimed_by_worker_id END,
      current_attempt_id = CASE WHEN $2 = 'pending' THEN NULL ELSE current_attempt_id END, lease_expires_at = NULL, last_error = $3,
      available_at = now() + make_interval(mins => $4), updated_at = now(), completed_at = CASE WHEN $2 = 'failed' THEN now() END
    WHERE id = $1`, [job.id, status, code, RETRY_DELAY_MINUTES * job.attempts]);
  if (terminal) await recordFailedScan(client, job.id, workerId, [error]);
  return status;
}

/** Admin: return a worker's in-flight jobs to the queue. A late result from that worker is then rejected (lease_lost). */
export async function releaseWorkerJobs(client: PoolClient, workerId: string): Promise<number> {
  const { rows } = await client.query<{ id: string; current_attempt_id: string }>(`SELECT id, current_attempt_id FROM search_jobs WHERE status = 'claimed' AND claimed_by_worker_id = $1 FOR UPDATE`, [workerId]);
  for (const job of rows) {
    await client.query(`UPDATE search_job_attempts SET outcome = 'released', finished_at = now() WHERE id = $1 AND outcome = 'running'`, [job.current_attempt_id]);
    // A released attempt was not the job's fault, so it does not consume one of the job's attempts.
    await client.query(`UPDATE search_jobs SET status = 'pending', attempts = greatest(attempts - 1, 0), claimed_by_worker_id = NULL, current_attempt_id = NULL,
      lease_expires_at = NULL, last_error = 'released_by_admin', available_at = now(), updated_at = now() WHERE id = $1`, [job.id]);
  }
  return rows.length;
}
