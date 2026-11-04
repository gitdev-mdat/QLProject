import type { PoolClient } from 'pg';
import { enqueueDueJobs, expireLeases, reconcileSourceAuthorization, releaseWorkerJobs } from './jobs.js';

/**
 * Admin-controlled worker handoff. One implementation serves every direction (Muse 01 -> 02 and back).
 * PostgreSQL holds all operational context; a destination worker receives work only through the job queue.
 * QLead never contacts Muse: readiness is judged from recorded evidence, and success requires the destination
 * to actually call QLead after cutover.
 *
 *   preparing -> draining -> awaiting_worker_start -> verifying -> completed
 *   preparing | draining -> cancelled          (source restored to active if this handoff drained it)
 *   any open status -> failed                  (Admin intervention; workers are left as they are)
 *
 * Every function runs inside the caller's transaction.
 */
export const WORKER_STATUSES = ['active', 'draining', 'paused', 'unavailable'] as const;
export type WorkerStatus = typeof WORKER_STATUSES[number];
export const OPEN_HANDOFF = ['preparing', 'draining', 'awaiting_worker_start', 'verifying'] as const;

export class HandoffError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

type WorkerRow = { id: string; name: string; status: WorkerStatus; credential_status: string; authorized_sources: string[]; connection_verified_at: Date | null; last_seen_at: Date | null; last_claim_at: Date | null; last_success_at: Date | null; status_changed_at: Date };
export type HandoffRow = { id: string; source_worker_id: string; destination_worker_id: string; mode: 'normal' | 'emergency'; status: string; cutover_at: Date | null; destination_first_contact_at: Date | null; destination_first_claim_at: Date | null; destination_first_success_at: Date | null; events: unknown[] };

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const vnFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** Admin-facing messages use Vietnam time. */
const vnTime = (d: Date | string) => vnFmt.format(new Date(d));

async function lockWorker(client: PoolClient, id: string): Promise<WorkerRow> {
  const { rows: [w] } = await client.query<WorkerRow>(`SELECT id, name, status, credential_status, authorized_sources, connection_verified_at, last_seen_at, last_claim_at, last_success_at, status_changed_at
    FROM muse_workers WHERE id = $1 FOR UPDATE`, [id]);
  if (!w) throw new HandoffError('worker_not_found', 'Không tìm thấy tài khoản Muse này.');
  return w;
}

export async function setWorkerStatus(client: PoolClient, workerId: string, status: WorkerStatus): Promise<void> {
  await client.query(`UPDATE muse_workers SET status = $2, status_changed_at = CASE WHEN status = $2 THEN status_changed_at ELSE now() END WHERE id = $1`, [workerId, status]);
}

async function lockHandoff(client: PoolClient, id: string): Promise<HandoffRow> {
  const { rows: [h] } = await client.query<HandoffRow>(`SELECT id, source_worker_id, destination_worker_id, mode, status, cutover_at, destination_first_contact_at, destination_first_claim_at, destination_first_success_at, events
    FROM worker_handoffs WHERE id = $1 FOR UPDATE`, [id]);
  if (!h) throw new HandoffError('handoff_not_found', 'Không tìm thấy lượt chuyển đổi này.');
  return h;
}

async function addEvent(client: PoolClient, id: string, type: string, detail: Record<string, unknown> = {}): Promise<void> {
  await client.query(`UPDATE worker_handoffs SET events = events || jsonb_build_array(jsonb_build_object('at', now(), 'type', $2::text, 'detail', $3::jsonb)) WHERE id = $1`, [id, type, JSON.stringify(detail)]);
}

export type HandoffSummary = Awaited<ReturnType<typeof buildSummary>>;

/** The complete operational context of a switch, computed from PostgreSQL only. Contains no customer credentials or post content. */
export async function buildSummary(client: PoolClient, sourceId: string, destinationId: string) {
  const { rows: workers } = await client.query<WorkerRow>(`SELECT id, name, status, credential_status, authorized_sources, connection_verified_at, last_seen_at, last_claim_at, last_success_at, status_changed_at
    FROM muse_workers WHERE id = ANY($1::uuid[])`, [[sourceId, destinationId]]);
  const source = workers.find(w => w.id === sourceId); const destination = workers.find(w => w.id === destinationId);
  if (!source || !destination) throw new HandoffError('worker_not_found', 'Không tìm thấy tài khoản Muse này.');
  const { rows: [jobs] } = await client.query(`SELECT
      count(*) FILTER (WHERE status = 'completed')::int AS completed_total,
      count(*) FILTER (WHERE status = 'completed' AND EXISTS (SELECT 1 FROM search_job_attempts a WHERE a.job_id = j.id AND a.worker_id = $1 AND a.outcome = 'completed'))::int AS completed_by_source,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'pending' AND attempts > 0)::int AS retryable,
      count(*) FILTER (WHERE status = 'pending' AND last_error = 'released_by_admin')::int AS released_waiting,
      count(*) FILTER (WHERE status = 'claimed' AND claimed_by_worker_id = $1)::int AS in_flight_source,
      count(*) FILTER (WHERE status = 'claimed' AND claimed_by_worker_id = $1 AND lease_expires_at < now())::int AS expired_leases_source,
      count(*) FILTER (WHERE status = 'claimed' AND claimed_by_worker_id IS DISTINCT FROM $1)::int AS in_flight_other,
      count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
      count(*) FILTER (WHERE status = 'needs_reauthorization')::int AS needs_reauthorization,
      count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '24 hours')::int AS failed_24h,
      min(scheduled_for) FILTER (WHERE status = 'pending') AS oldest_pending_slot
    FROM search_jobs j`, [sourceId]);
  const { rows: inFlight } = await client.query(`SELECT j.id AS job_id, j.lease_expires_at, a.attempt_no, a.claimed_at FROM search_jobs j
    LEFT JOIN search_job_attempts a ON a.id = j.current_attempt_id WHERE j.status = 'claimed' AND j.claimed_by_worker_id = $1 ORDER BY j.lease_expires_at`, [sourceId]);
  const { rows: profiles } = await client.query<{ id: string; sources: string[]; frequency_minutes: number; last_success: Date | null; has_open_job: boolean }>(`SELECT ac.id, sc.sources, sc.frequency_minutes,
      (SELECT max(received_at) FROM scan_runs WHERE agent_connection_id = ac.id AND status IN ('success', 'partial')) AS last_success,
      EXISTS (SELECT 1 FROM search_jobs WHERE search_profile_id = ac.id AND status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization')) AS has_open_job
    FROM agent_connections ac
    JOIN LATERAL (SELECT sources, frequency_minutes, enabled FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    WHERE ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled`);
  const covered = (sources: string[]) => sources.every(s => destination.authorized_sources.includes(s));
  const now = Date.now();
  const { rows: nextJobs } = await client.query(`SELECT j.id AS job_id, j.status, j.scheduled_for, j.available_at, j.attempts, j.required_sources, j.last_error
    FROM search_jobs j WHERE j.status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization') ORDER BY (j.status = 'pending') DESC, j.scheduled_for, j.created_at LIMIT 10`);
  const uncovered = profiles.filter(p => !covered(p.sources)).map(p => ({ profile_id: p.id, sources: p.sources }));
  const gaps = profiles.filter(p => !p.last_success || now - new Date(p.last_success).getTime() > 2 * p.frequency_minutes * 60_000).length;
  const checks = [
    { key: 'destination_credential', ok: destination.credential_status === 'active', blocking: true, message: destination.credential_status === 'active' ? 'Credential của tài khoản mới còn hiệu lực.' : 'Credential của tài khoản mới đã bị thu hồi. Hãy tạo lại credential trước.' },
    { key: 'destination_verified', ok: Boolean(destination.connection_verified_at), blocking: false, message: destination.connection_verified_at ? `Đã xác minh kết nối lúc ${vnTime(destination.connection_verified_at)}. Đây là dữ liệu cũ, không chứng minh Muse đang trực tuyến.` : 'Tài khoản mới chưa từng xác minh kết nối với QLead.' },
    { key: 'destination_sources', ok: uncovered.length === 0, blocking: false, message: uncovered.length ? `${uncovered.length} nhu cầu theo dõi cần nguồn mà tài khoản mới chưa được cấp quyền. Các job này sẽ chuyển sang trạng thái bị chặn.` : 'Tài khoản mới có đủ quyền nguồn cho mọi nhu cầu đang bật.' },
    { key: 'source_in_flight', ok: inFlight.length === 0, blocking: false, message: inFlight.length ? `Tài khoản cũ đang xử lý ${inFlight.length} job. Chuyển bình thường sẽ chờ các job này xong hoặc hết lease.` : 'Tài khoản cũ không còn job đang xử lý.' },
  ];
  return {
    generated_at: new Date().toISOString(),
    source: { id: source.id, name: source.name, status: source.status, last_success_at: iso(source.last_success_at), last_seen_at: iso(source.last_seen_at) },
    destination: { id: destination.id, name: destination.name, status: destination.status, credential_status: destination.credential_status, authorized_sources: destination.authorized_sources, connection_verified_at: iso(destination.connection_verified_at), last_seen_at: iso(destination.last_seen_at) },
    jobs: { ...jobs, oldest_pending_slot: iso(jobs.oldest_pending_slot) },
    in_flight_source: inFlight.map(j => ({ job_id: j.job_id, attempt_no: j.attempt_no, claimed_at: iso(j.claimed_at), lease_expires_at: iso(j.lease_expires_at) })),
    profiles: { active: profiles.length, due_without_job: profiles.filter(p => !p.has_open_job).length, monitoring_gaps: gaps, uncovered_by_destination: uncovered },
    next_jobs: nextJobs.map(j => ({ job_id: j.job_id, status: j.status, scheduled_for: iso(j.scheduled_for), available_at: iso(j.available_at), attempts: j.attempts, required_sources: j.required_sources, last_error: j.last_error })),
    checks,
  };
}

export async function prepareHandoff(client: PoolClient, input: { sourceId: string; destinationId: string; userId?: string | null }): Promise<string> {
  if (input.sourceId === input.destinationId) throw new HandoffError('same_worker', 'Tài khoản nguồn và tài khoản đích phải khác nhau.');
  const { rows: [open] } = await client.query(`SELECT id FROM worker_handoffs WHERE status = ANY($1::text[]) LIMIT 1`, [[...OPEN_HANDOFF]]);
  if (open) throw new HandoffError('handoff_in_progress', 'Đang có một lượt chuyển đổi chưa kết thúc. Hãy hoàn tất hoặc huỷ lượt đó trước.', { handoff_id: open.id });
  // Lock both workers in id order so concurrent handoffs cannot deadlock.
  for (const workerId of [input.sourceId, input.destinationId].sort()) await lockWorker(client, workerId);
  const summary = await buildSummary(client, input.sourceId, input.destinationId);
  const blocking = summary.checks.filter(c => c.blocking && !c.ok);
  if (blocking.length) throw new HandoffError('precheck_failed', blocking.map(c => c.message).join(' '), { checks: blocking });
  const { rows: [h] } = await client.query(`INSERT INTO worker_handoffs (source_worker_id, destination_worker_id, created_by_user_id, prepared_summary)
    VALUES ($1, $2, $3, $4) RETURNING id`, [input.sourceId, input.destinationId, input.userId ?? null, JSON.stringify(summary)]);
  await addEvent(client, h.id, 'prepared', { pending: summary.jobs.pending, in_flight_source: summary.jobs.in_flight_source });
  return h.id;
}

/** Source stops taking new jobs; jobs it already holds may finish normally. */
export async function startDrain(client: PoolClient, id: string): Promise<void> {
  const h = await lockHandoff(client, id);
  if (h.status !== 'preparing') throw new HandoffError('invalid_state', 'Chỉ có thể bắt đầu ngừng nhận việc khi đang ở bước chuẩn bị.');
  const source = await lockWorker(client, h.source_worker_id);
  if (source.status === 'active') await setWorkerStatus(client, source.id, 'draining');
  await client.query(`UPDATE worker_handoffs SET status = 'draining', drain_started_at = now() WHERE id = $1`, [id]);
  await addEvent(client, id, 'drain_started', { source_previous_status: source.status });
}

/**
 * Cutover. Normal mode refuses while the source still holds unexpired leases, so valid in-progress work is not
 * thrown away. Emergency mode marks the source unavailable and releases its jobs; a late result from it is then
 * rejected (lease_lost) and the destination re-runs the search as a new attempt of the same job.
 */
export async function cutover(client: PoolClient, id: string, options: { emergency: boolean }): Promise<{ released: number }> {
  const h = await lockHandoff(client, id);
  if (h.status !== 'preparing' && h.status !== 'draining') throw new HandoffError('invalid_state', 'Lượt chuyển đổi này không còn ở bước có thể chuyển.');
  // Lock both workers in id order so concurrent handoffs cannot deadlock.
  for (const workerId of [h.source_worker_id, h.destination_worker_id].sort()) await lockWorker(client, workerId);
  const destination = await lockWorker(client, h.destination_worker_id);
  if (destination.credential_status !== 'active') throw new HandoffError('precheck_failed', 'Credential của tài khoản mới đã bị thu hồi.');
  await expireLeases(client);
  const { rows: inFlight } = await client.query(`SELECT id, lease_expires_at FROM search_jobs WHERE status = 'claimed' AND claimed_by_worker_id = $1`, [h.source_worker_id]);
  if (inFlight.length && !options.emergency) {
    throw new HandoffError('source_has_in_flight_jobs', `Tài khoản cũ vẫn đang giữ ${inFlight.length} job. Hãy chờ xong hoặc dùng chuyển khẩn cấp.`, { jobs: inFlight.map(j => ({ job_id: j.id, lease_expires_at: iso(j.lease_expires_at) })) });
  }
  let released = 0;
  if (options.emergency) {
    await setWorkerStatus(client, h.source_worker_id, 'unavailable');
    released = await releaseWorkerJobs(client, h.source_worker_id);
  } else {
    await setWorkerStatus(client, h.source_worker_id, 'paused');
  }
  await setWorkerStatus(client, h.destination_worker_id, 'active');
  // Make the current slot's work visible now, and block anything the destination is not authorized to run.
  await enqueueDueJobs(client);
  await reconcileSourceAuthorization(client);
  const summary = await buildSummary(client, h.source_worker_id, h.destination_worker_id);
  await client.query(`UPDATE worker_handoffs SET status = 'awaiting_worker_start', cutover_at = now(), mode = $2, released_jobs = $3, cutover_summary = $4 WHERE id = $1`,
    [id, options.emergency ? 'emergency' : 'normal', released, JSON.stringify(summary)]);
  await addEvent(client, id, 'cutover', { emergency: options.emergency, released, pending: summary.jobs.pending });
  return { released };
}

/** Advances an open handoff from recorded evidence of the destination contacting, claiming and completing work. */
export async function refreshHandoff(client: PoolClient, id: string): Promise<string> {
  const h = await lockHandoff(client, id);
  if (h.status !== 'awaiting_worker_start' && h.status !== 'verifying') return h.status;
  const { rows: [evidence] } = await client.query(`SELECT
      (SELECT last_seen_at FROM muse_workers WHERE id = $1 AND last_seen_at >= $2) AS contact,
      (SELECT min(claimed_at) FROM search_job_attempts WHERE worker_id = $1 AND claimed_at >= $2) AS first_claim,
      (SELECT min(finished_at) FROM search_job_attempts WHERE worker_id = $1 AND claimed_at >= $2 AND outcome = 'completed') AS first_success`,
  [h.destination_worker_id, h.cutover_at]);
  const contact = h.destination_first_contact_at ?? evidence.contact ?? evidence.first_claim;
  const status = evidence.first_success ? 'completed' : contact ? 'verifying' : 'awaiting_worker_start';
  await client.query(`UPDATE worker_handoffs SET status = $2, destination_first_contact_at = coalesce(destination_first_contact_at, $3),
      destination_first_claim_at = coalesce(destination_first_claim_at, $4), destination_first_success_at = coalesce(destination_first_success_at, $5),
      finished_at = CASE WHEN $2 = 'completed' THEN coalesce(finished_at, now()) ELSE finished_at END WHERE id = $1`,
  [id, status, contact, evidence.first_claim, evidence.first_success]);
  if (status !== h.status) await addEvent(client, id, status === 'completed' ? 'destination_completed_job' : 'destination_contacted');
  return status;
}

/**
 * Completes a handoff whose destination has called claim after cutover but found nothing to run. Requires real
 * contact evidence, so a handoff is never marked complete just because the database status changed.
 */
export async function confirmWithoutWork(client: PoolClient, id: string): Promise<void> {
  const h = await lockHandoff(client, id);
  if (h.status !== 'verifying') throw new HandoffError('invalid_state', 'Chỉ xác nhận được khi Muse mới đã liên hệ QLead.');
  const { rows: [w] } = await client.query(`SELECT last_claim_at FROM muse_workers WHERE id = $1`, [h.destination_worker_id]);
  if (!w.last_claim_at || !h.cutover_at || new Date(w.last_claim_at) < new Date(h.cutover_at)) throw new HandoffError('no_claim_evidence', 'Muse mới chưa gọi nhận việc sau thời điểm chuyển.');
  const { rows: [q] } = await client.query(`SELECT count(*)::int AS n FROM search_jobs WHERE status = 'pending' AND available_at <= now()`);
  if (q.n > 0) throw new HandoffError('work_waiting', `Còn ${q.n} job đang chờ. Hãy để Muse mới chạy xong ít nhất một job.`);
  await client.query(`UPDATE worker_handoffs SET status = 'completed', finished_at = now() WHERE id = $1`, [id]);
  await addEvent(client, id, 'confirmed_without_work', { last_claim_at: iso(w.last_claim_at) });
}

export async function cancelHandoff(client: PoolClient, id: string): Promise<void> {
  const h = await lockHandoff(client, id);
  if (h.status !== 'preparing' && h.status !== 'draining') throw new HandoffError('invalid_state', 'Sau khi đã chuyển thì không huỷ được. Hãy tạo lượt chuyển ngược lại.');
  const source = await lockWorker(client, h.source_worker_id);
  if (h.status === 'draining' && source.status === 'draining') await setWorkerStatus(client, source.id, 'active');
  await client.query(`UPDATE worker_handoffs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [id]);
  await addEvent(client, id, 'cancelled', { source_restored: h.status === 'draining' && source.status === 'draining' });
}

/** Records that the destination did not start (or another problem). Workers are not changed automatically. */
export async function failHandoff(client: PoolClient, id: string, reason: string): Promise<void> {
  const h = await lockHandoff(client, id);
  if (!(OPEN_HANDOFF as readonly string[]).includes(h.status)) throw new HandoffError('invalid_state', 'Lượt chuyển đổi này đã kết thúc.');
  await client.query(`UPDATE worker_handoffs SET status = 'failed', failure_reason = $2, finished_at = now() WHERE id = $1`, [id, reason]);
  await addEvent(client, id, 'failed', { reason, previous_status: h.status });
}

/** Admin-facing state, separating what the database allows from what Muse has evidently done. */
export function displayState(w: { status: string; credential_status: string; connection_verified_at: Date | string | null; last_claim_at: Date | string | null; status_changed_at: Date | string }) {
  const connected = Boolean(w.connection_verified_at) && w.credential_status === 'active';
  const state = w.credential_status !== 'active' ? 'unavailable' : w.status === 'paused' && connected ? 'ready' : w.status;
  const standbyContact = (w.status === 'paused' || w.status === 'unavailable') && Boolean(w.last_claim_at) && new Date(w.last_claim_at!) > new Date(w.status_changed_at);
  return { state, connected, standbyContact };
}
