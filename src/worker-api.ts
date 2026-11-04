import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { resultSchema } from './validation.js';
import { preparePosts, upsertPosts, type PreparedPost } from './ingest.js';
import { claimJobs, enqueueInitialFollowup, lockJob, markCompleted, markFailed, type Worker } from './jobs.js';

/**
 * Shared Muse worker API. A worker authenticates with its own credential (muse_workers), which never grants access to
 * the legacy /api/agent/* routes and vice versa. Job payloads carry only the search to run: no customer identity.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claimSchema = z.object({
  max_jobs: z.number().int().min(1).max(10).optional(),
  // An optional scope is useful for controlled runs; it cannot expand the worker's existing authorization.
  search_profile_id: z.string().regex(UUID).optional(),
}).strict();
// Same shape as the legacy results payload, except a worker cannot state any customer identity at all.
const jobResultSchema = resultSchema.omit({ user_id: true }).extend({ attempt_no: z.number().int().positive().optional() });
const failureSchema = z.object({
  scan_id: z.string().min(1).max(200),
  attempt_no: z.number().int().positive().optional(),
  code: z.enum(['execution_error', 'rate_limited', 'source_unavailable', 'needs_reauthorization']),
  message: z.string().max(2000).optional().default(''),
  retryable: z.boolean().optional().default(true),
}).strict();

const err = (error: string, message: string) => ({ error, message });

function attemptIdentityError(job: { attempt_no: number | null }, attemptNo: number | undefined): { code: string; message: string } | undefined {
  if (attemptNo === undefined && (job.attempt_no ?? 0) > 1) return { code: 'attempt_identity_required', message: 'Include the attempt_no returned by the current claim; this job has been retried or released.' };
  if (attemptNo !== undefined && attemptNo !== job.attempt_no) return { code: 'attempt_mismatch', message: 'attempt_no does not match the current job assignment. Discard stale results.' };
}

async function authenticateWorker(req: FastifyRequest, reply: FastifyReply): Promise<Worker | undefined> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(header)?.[1] : undefined;
  if (!token) { reply.code(401).send(err('unauthorized', 'A valid worker credential is required.')); return; }
  const hash = createHash('sha256').update(token).digest('hex');
  const { rows } = await pool.query<Worker>(`UPDATE muse_workers SET last_seen_at = now() WHERE credential_hash = $1 AND credential_status = 'active'
    RETURNING id, name, status, authorized_sources, max_jobs_per_claim, lease_minutes`, [hash]);
  if (!rows[0]) { reply.code(401).send(err('unauthorized', 'A valid worker credential is required.')); return; }
  return rows[0];
}

function jobIdFrom(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const { jobId } = req.params as { jobId: string };
  if (UUID.test(jobId)) return jobId;
  req.log.warn({ identifier_length: jobId.length, identifier_has_job_prefix: jobId.startsWith('job-') }, 'Worker result path rejected: expected job_id UUID');
  reply.code(400).send(err('invalid_job_id', 'Use the job_id returned by /api/worker/jobs/claim in the URL; send scan_id in the request body.'));
}

function ackFrom(jobId: string, run: { external_scan_id: string; received_posts: number; new_posts: number; updated_posts: number; duplicates_skipped: number; received_at: Date; status: string; usable_new_posts?: number | null }, followupQueued = false) {
  return { accepted: true, job_id: jobId, scan_id: run.external_scan_id, scan_status: run.status, received_posts: run.received_posts, inserted_posts: run.new_posts,
    updated_posts: run.updated_posts, duplicates: run.received_posts - run.new_posts, unchanged_posts: run.duplicates_skipped,
    usable_new_posts: run.usable_new_posts ?? null, early_followup_queued: followupQueued, server_received_at: run.received_at };
}

export async function workerRoutes(app: FastifyInstance): Promise<void> {
  // Connection check and operational context for this worker only. It never claims work, so a one-time setup check
  // costs a single request. It is recorded as the latest verified connection.
  app.get('/api/worker/status', async (req, reply) => {
    const worker = await authenticateWorker(req, reply); if (!worker) return;
    await pool.query('UPDATE muse_workers SET connection_verified_at = now() WHERE id = $1', [worker.id]);
    const { rows: [counts] } = await pool.query(`SELECT
        count(*) FILTER (WHERE status = 'claimed' AND claimed_by_worker_id = $1 AND lease_expires_at > now())::int AS claimed_jobs,
        count(*) FILTER (WHERE status = 'claimed' AND claimed_by_worker_id = $1 AND (lease_expires_at IS NULL OR lease_expires_at <= now()))::int AS expired_claims,
        count(*) FILTER (WHERE status = 'pending' AND scheduled_for <= now() AND available_at <= now() AND $2::jsonb @> required_sources
          AND EXISTS (SELECT 1 FROM agent_connections ac JOIN users u ON u.id = ac.user_id WHERE ac.id = search_jobs.search_profile_id AND u.lead_monitoring_status = 'active'))::int AS claimable_jobs,
        count(*) FILTER (WHERE status = 'pending' AND attempts > 0)::int AS retry_jobs,
        min(scheduled_for) FILTER (WHERE status = 'pending') AS oldest_pending_slot
      FROM search_jobs`, [worker.id, JSON.stringify(worker.authorized_sources)]);
    const { rows: [handoff] } = await pool.query(`SELECT status, CASE WHEN destination_worker_id = $1 THEN 'destination' ELSE 'source' END AS role
      FROM worker_handoffs WHERE (source_worker_id = $1 OR destination_worker_id = $1) AND status IN ('preparing', 'draining', 'awaiting_worker_start', 'verifying') LIMIT 1`, [worker.id]);
    return { name: worker.name, status: worker.status, authorized_sources: worker.authorized_sources, max_jobs_per_claim: worker.max_jobs_per_claim, lease_minutes: worker.lease_minutes,
      claimed_jobs: counts.claimed_jobs, expired_claims: counts.expired_claims,
      queue: { claimable_jobs: worker.status === 'active' ? counts.claimable_jobs : 0, retry_jobs: counts.retry_jobs, oldest_pending_slot: counts.oldest_pending_slot },
      handoff: handoff ?? null };
  });

  app.post('/api/worker/jobs/claim', async (req, reply) => {
    const worker = await authenticateWorker(req, reply); if (!worker) return;
    const parsed = claimSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(err('invalid_request', 'Body may only contain max_jobs from 1 to 10 and a valid search_profile_id.'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Recorded even when the worker is not active, so Admin can see a standby account that is still polling.
      await client.query('UPDATE muse_workers SET last_claim_at = now() WHERE id = $1', [worker.id]);
      const jobs = await claimJobs(client, worker, parsed.data.max_jobs ?? worker.max_jobs_per_claim, parsed.data.search_profile_id);
      await client.query('COMMIT');
      req.log.info({ worker_id: worker.id, claimed_jobs: jobs.map(job => ({ job_id: job.job_id, scan_id: job.scan_id, attempt_no: job.attempt_no, configuration_version: job.configuration_version, lease_expires_at: job.lease_expires_at })) }, 'Worker jobs claimed');
      return { worker_status: worker.status, jobs, server_time: new Date().toISOString() };
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err: { code: error?.code, message: error?.message } }, 'Job claim failed');
      return reply.code(503).send(err('temporarily_unavailable', 'No jobs were assigned. Retry later.'));
    } finally { client.release(); }
  });

  app.post('/api/worker/jobs/:jobId/results', async (req, reply) => {
    const worker = await authenticateWorker(req, reply); if (!worker) return;
    const jobId = jobIdFrom(req, reply); if (!jobId) return;
    const parsed = jobResultSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ...err('invalid_request', 'Request body does not match the job results schema.'), details: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) });
    const payload = parsed.data;
    let posts: PreparedPost[];
    try { posts = preparePosts(payload.posts); }
    catch { return reply.code(400).send(err('invalid_request', 'Each post URL must use a supported Facebook host.')); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const job = await lockJob(client, jobId);
      if (!job) { await client.query('ROLLBACK'); return reply.code(404).send(err('job_not_found', 'No such job.')); }
      if (job.status === 'completed') {
        const { rows: [run] } = await client.query('SELECT external_scan_id, received_posts, new_posts, updated_posts, duplicates_skipped, usable_new_posts, received_at, status, executed_by_worker_id FROM scan_runs WHERE search_job_id = $1', [job.id]);
        const { rows: [followup] } = await client.query("SELECT status FROM search_jobs WHERE search_profile_id = $1 AND configuration_version = $2 AND kind = 'followup'", [job.search_profile_id, job.configuration_version]);
        await client.query('COMMIT');
        // Lost-acknowledgement retry: the same worker gets the original acknowledgement and nothing is written again.
        if (run && run.executed_by_worker_id === worker.id && payload.scan_id === job.scan_id) {
          req.log.info({ worker_id: worker.id, job_id: job.id, scan_id: payload.scan_id, attempt_id: job.current_attempt_id, attempt_no: job.attempt_no, configuration_version: job.configuration_version, result_status: 'duplicate_ack', received_posts: run.received_posts }, 'Worker result retry acknowledged idempotently');
          return ackFrom(job.id, run, Boolean(followup));
        }
        return reply.code(409).send(err('job_already_completed', 'This job was completed by another assignment. Discard these results.'));
      }
      if (job.status !== 'claimed' || job.claimed_by_worker_id !== worker.id) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, assigned_worker_id: job.claimed_by_worker_id, job_status: job.status, attempt_id: job.current_attempt_id }, 'Worker result rejected: lease ownership changed');
        return reply.code(409).send(err('lease_lost', 'This worker no longer holds the job. Discard these results and claim again.'));
      }
      const attemptError = attemptIdentityError(job, payload.attempt_no);
      if (attemptError) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, scan_id: payload.scan_id, supplied_attempt_no: payload.attempt_no ?? null, current_attempt_no: job.attempt_no, current_attempt_id: job.current_attempt_id }, 'Worker result rejected: attempt identity mismatch');
        return reply.code(409).send(err(attemptError.code, attemptError.message));
      }
      if (!job.lease_valid) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, scan_id: payload.scan_id, attempt_id: job.current_attempt_id, attempt_no: job.attempt_no }, 'Worker result rejected: lease expired');
        return reply.code(409).send(err('lease_expired', 'The job lease expired. Discard these results; the job must be recovered through the normal claim lifecycle.'));
      }
      if (payload.scan_id !== job.scan_id || payload.configuration_version !== job.configuration_version) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, expected_scan_id: job.scan_id, received_scan_id: payload.scan_id, expected_configuration_version: job.configuration_version, received_configuration_version: payload.configuration_version, attempt_id: job.current_attempt_id }, 'Worker result rejected: job identity mismatch');
        return reply.code(400).send(err('job_mismatch', 'scan_id and configuration_version must be the values issued with this job.'));
      }
      await client.query('SELECT id FROM agent_connections WHERE id = $1 FOR UPDATE', [job.search_profile_id]);
      const { inserted, updated } = await upsertPosts(client, job.search_profile_id, job.configuration_version, posts);
      const insertedUrls = inserted;
      const usableNewPosts = new Set(posts.filter(post => insertedUrls.has(post.normalized)
        && Boolean(post.author?.trim()) && Boolean((post.content ?? post.title ?? '').trim())
        && post.collected_via !== 'integration_test').map(post => post.normalized)).size;
      const duplicateCount = payload.posts.length - inserted.size;
      const unchangedCount = Math.max(0, duplicateCount - updated.size);
      const status = payload.errors.length ? (payload.posts.length ? 'partial' : 'failed') : 'success';
      const { rows: [run] } = await client.query(`INSERT INTO scan_runs (agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, updated_posts, usable_new_posts, keywords_used, duplicates_skipped, status, errors, search_job_id, executed_by_worker_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING external_scan_id, received_posts, new_posts, updated_posts, usable_new_posts, duplicates_skipped, received_at, status`,
      [job.search_profile_id, job.scan_id, job.configuration_version, payload.scanned_at, payload.stats.total_found, payload.posts.length, inserted.size, updated.size, usableNewPosts, JSON.stringify(payload.keywords_used), unchangedCount, status, JSON.stringify(payload.errors), job.id, worker.id]);
      await markCompleted(client, job, worker.id);
      const followupQueued = job.kind === 'initial' && status !== 'failed' && usableNewPosts <= 1
        ? await enqueueInitialFollowup(client, job.search_profile_id, job.configuration_version, payload.keywords_used) : false;
      await client.query('COMMIT');
      req.log.info({ worker_id: worker.id, job_id: job.id, scan_id: payload.scan_id, attempt_id: job.current_attempt_id, attempt_no: job.attempt_no, configuration_version: job.configuration_version, result_status: status, received_posts: payload.posts.length, inserted_posts: inserted.size, updated_posts: updated.size, usable_new_posts: usableNewPosts, early_followup_queued: followupQueued, http_status: 200 }, 'Worker results accepted');
      return ackFrom(job.id, run, followupQueued);
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error?.code === '23505') return reply.code(409).send(err('conflict', 'The scan could not be recorded; retry with the same scan_id.'));
      req.log.error({ err: { code: error?.code, message: error?.message } }, 'Job result transaction failed');
      return reply.code(503).send(err('temporarily_unavailable', 'The results were not acknowledged. Retry with the same job and scan_id.'));
    } finally { client.release(); }
  });

  app.post('/api/worker/jobs/:jobId/failure', async (req, reply) => {
    const worker = await authenticateWorker(req, reply); if (!worker) return;
    const jobId = jobIdFrom(req, reply); if (!jobId) return;
    const parsed = failureSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ...err('invalid_request', 'Request body does not match the job failure schema.'), details: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) });
    const failure = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const job = await lockJob(client, jobId);
      if (!job) { await client.query('ROLLBACK'); return reply.code(404).send(err('job_not_found', 'No such job.')); }
      if (failure.scan_id !== job.scan_id) { await client.query('ROLLBACK'); return reply.code(400).send(err('job_mismatch', 'scan_id must be the value issued with this job.')); }
      if (job.status !== 'claimed' || job.claimed_by_worker_id !== worker.id) {
        // Lost-acknowledgement retry of a failure report this worker already made.
        const { rows: [last] } = await client.query(`SELECT outcome FROM search_job_attempts WHERE job_id = $1 AND worker_id = $2 ORDER BY attempt_no DESC LIMIT 1`, [job.id, worker.id]);
        await client.query('COMMIT');
        if (last && ['failed', 'needs_reauthorization'].includes(last.outcome) && job.status !== 'completed') return { recorded: true, job_id: job.id, job_status: job.status };
        return reply.code(409).send(err('lease_lost', 'This worker no longer holds the job.'));
      }
      const attemptError = attemptIdentityError(job, failure.attempt_no);
      if (attemptError) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, scan_id: failure.scan_id, supplied_attempt_no: failure.attempt_no ?? null, current_attempt_no: job.attempt_no, current_attempt_id: job.current_attempt_id }, 'Worker failure report rejected: attempt identity mismatch');
        return reply.code(409).send(err(attemptError.code, attemptError.message));
      }
      if (!job.lease_valid) {
        await client.query('ROLLBACK');
        req.log.warn({ worker_id: worker.id, job_id: job.id, scan_id: failure.scan_id, attempt_id: job.current_attempt_id, attempt_no: job.attempt_no }, 'Worker failure report rejected: lease expired');
        return reply.code(409).send(err('lease_expired', 'The job lease expired. The job must be recovered through the normal claim lifecycle.'));
      }
      const status = await markFailed(client, job, worker.id, failure.code, failure.message, failure.retryable);
      await client.query('COMMIT');
      req.log.info({ worker_id: worker.id, job_id: job.id, scan_id: failure.scan_id, attempt_id: job.current_attempt_id, attempt_no: job.attempt_no, failure_code: failure.code, retryable: failure.retryable, job_status: status }, 'Worker failure report recorded');
      return { recorded: true, job_id: job.id, job_status: status };
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      req.log.error({ err: { code: error?.code, message: error?.message } }, 'Job failure transaction failed');
      return reply.code(503).send(err('temporarily_unavailable', 'The failure was not recorded. Retry with the same job and scan_id.'));
    } finally { client.release(); }
  });
}
// Register on the root instance (what fastify-plugin does) so the app-wide error handler covers these routes.
(workerRoutes as any)[Symbol.for('skip-override')] = true;
