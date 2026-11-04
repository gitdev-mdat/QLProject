import 'server-only';
import type { FirstScan, FirstScanState } from '../first-scan';
import { planEarlyFollowup } from '../../../src/search-plan';
import { db } from './db';

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/**
 * The first scan of this user's earliest search profile (null when they have no profile). Read from the database
 * on every request, so the state survives refresh, logout and other devices. Ownership: every row is reached
 * through agent_connections.user_id = the session user.
 */
export async function getFirstScanForUser(userId: string, now = Date.now()): Promise<FirstScan | null> {
  const { rows: [row] } = await db().query(`SELECT ac.id, ac.name, ac.created_at AS profile_created_at, sc.version AS current_configuration_version, sc.description, sc.keywords, sc.location, sc.frequency_minutes, sc.enabled, u.lead_monitoring_status,
      run.scanned_at AS run_at, run.status AS run_status, run.total_found, run.new_posts,
      job.status AS job_status, job.created_at AS job_created_at, job.lease_expires_at, job.attempts,
      (SELECT claimed_at FROM search_job_attempts WHERE id = job.current_attempt_id) AS claimed_at,
      initial_job.configuration_version AS initial_configuration_version, initial_job.status AS initial_status, initial_job.attempts AS initial_attempts, initial_job.created_at AS initial_created_at,
      initial_job.completed_at AS initial_completed_at, initial_job.last_error AS initial_error,
      initial_run.status AS initial_run_status, initial_run.usable_new_posts AS initial_usable,
      (initial_run.received_posts - initial_run.new_posts) AS initial_duplicates, initial_run.keywords_used AS initial_keywords,
      initial_run.received_at AS initial_received_at,
      (SELECT min(claimed_at) FROM search_job_attempts WHERE job_id = initial_job.id) AS initial_claimed_at,
      (SELECT sum(extract(epoch FROM coalesce(finished_at, now()) - claimed_at) * 1000)::bigint FROM search_job_attempts WHERE job_id = initial_job.id) AS initial_active_ms,
      followup.status AS followup_status, followup.attempts AS followup_attempts, followup.created_at AS followup_created_at,
      followup.available_at AS followup_available_at, followup.completed_at AS followup_completed_at, followup.last_error AS followup_error,
      followup_run.usable_new_posts AS followup_usable,
      (followup_run.received_posts - followup_run.new_posts) AS followup_duplicates, followup_run.keywords_used AS followup_keywords,
      followup_run.received_at AS followup_received_at,
      (SELECT min(claimed_at) FROM search_job_attempts WHERE job_id = followup.id) AS followup_claimed_at,
      (SELECT sum(extract(epoch FROM coalesce(finished_at, now()) - claimed_at) * 1000)::bigint FROM search_job_attempts WHERE job_id = followup.id) AS followup_active_ms,
      EXISTS (SELECT 1 FROM search_jobs other_job WHERE other_job.search_profile_id = ac.id
        AND other_job.status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization')
        AND other_job.kind <> 'followup') AS another_job_open
    FROM agent_connections ac JOIN users u ON u.id = ac.user_id
    JOIN LATERAL (SELECT * FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
    LEFT JOIN LATERAL (SELECT scanned_at, status, total_found, new_posts FROM scan_runs WHERE agent_connection_id = ac.id ORDER BY scanned_at, received_at LIMIT 1) run ON true
    LEFT JOIN LATERAL (SELECT * FROM search_jobs WHERE search_profile_id = ac.id AND status <> 'cancelled' ORDER BY (kind = 'initial') DESC, created_at LIMIT 1) job ON true
    LEFT JOIN LATERAL (SELECT * FROM search_jobs WHERE search_profile_id = ac.id AND kind = 'initial' ORDER BY created_at DESC LIMIT 1) initial_job ON true
    LEFT JOIN scan_runs initial_run ON initial_run.search_job_id = initial_job.id
    LEFT JOIN LATERAL (SELECT * FROM search_jobs WHERE search_profile_id = ac.id AND kind = 'followup'
      AND configuration_version = initial_job.configuration_version ORDER BY created_at DESC LIMIT 1) followup ON true
    LEFT JOIN scan_runs followup_run ON followup_run.search_job_id = followup.id
    WHERE ac.user_id = $1 AND ac.kind = 'search_profile' AND ac.status = 'active'
    ORDER BY ac.created_at LIMIT 1`, [userId]);
  if (!row) return null;
  // Pending work is retained for a future reactivation, but is not presented as an active wait while suspended.
  if (row.lead_monitoring_status === 'suspended' && !row.run_at && row.job_status !== 'claimed') return null;

  let state: FirstScanState;
  const graceMs = row.frequency_minutes * 60_000;
  if (row.run_at) state = row.run_status === 'failed' ? 'failed' : row.new_posts > 0 ? 'results' : 'no_results';
  else if (!row.enabled) state = 'paused';
  else if (row.job_status === 'claimed') state = row.lease_expires_at && new Date(row.lease_expires_at).getTime() < now ? 'delayed' : 'running';
  else if (row.job_status === 'failed') state = 'failed';
  else if (row.job_status === 'blocked' || row.job_status === 'needs_reauthorization') state = 'delayed';
  else {
    // Queued (or not yet queued for a profile saved before first scans existed). A working schedule picks it up
    // within one monitoring interval; beyond that the wait is reported as a delay, never as searching.
    const queued = row.job_created_at ? new Date(row.job_created_at).getTime() : now;
    state = now - queued > graceMs || (row.attempts ?? 0) > 0 ? 'delayed' : 'waiting';
  }

  return {
    state,
    profile: { id: row.id, name: row.name, description: row.description, keywords: row.keywords, location: row.location, frequencyMinutes: row.frequency_minutes, createdAt: iso(row.profile_created_at)! },
    queuedAt: iso(row.job_created_at), startedAt: iso(row.claimed_at), finishedAt: iso(row.run_at),
    totalFound: row.run_at ? row.total_found : null, newPosts: row.run_at ? row.new_posts : null,
    discovery: discoveryContract(row, now),
  };
}

function discoveryContract(row: any, now: number): FirstScan['discovery'] {
  const initialUsable = row.initial_usable === null || row.initial_usable === undefined ? null : Number(row.initial_usable);
  const followupUsable = row.followup_usable === null || row.followup_usable === undefined ? null : Number(row.followup_usable);
  const followupStatus = row.followup_status as string | null;
  let status: FirstScan['discovery']['status'];
  let initialStatus: FirstScan['discovery']['initialStatus'];
  let followupSkipReason: FirstScan['discovery']['followupSkipReason'] = null;
  if (row.lead_monitoring_status === 'suspended') status = 'suspended';
  else if (!row.enabled) status = 'paused';
  else if (row.initial_run_status === 'failed' || row.initial_status === 'failed' || followupStatus === 'failed') status = 'failed';
  else if (row.initial_status === 'claimed' && !row.initial_run_status) status = 'initial_running';
  else if (!row.initial_run_status) status = row.initial_attempts > 0 ? 'retrying' : 'initial_waiting';
  else if (followupStatus === 'claimed') status = 'followup_running';
  else if (followupStatus === 'pending') {
    if (row.followup_attempts > 0) status = 'retrying';
    else if (new Date(row.followup_available_at).getTime() > now) status = 'followup_planned';
    else status = 'followup_waiting';
  } else if (followupStatus === 'completed') status = 'completed';
  else if (followupStatus === 'cancelled') {
    status = 'no_additional_coverage';
    followupSkipReason = row.followup_error === 'superseded_by_edit' ? 'configuration_changed' : 'no_complementary_strategies';
  } else if (initialUsable !== null && initialUsable > 1) {
    status = 'completed';
    followupSkipReason = 'threshold_met';
  } else {
    status = 'no_additional_coverage';
    if (initialUsable === null) followupSkipReason = 'historical_metric_unavailable';
    else if (row.current_configuration_version !== row.initial_configuration_version) followupSkipReason = 'configuration_changed';
    else if (row.another_job_open) followupSkipReason = 'another_job_queued';
    else if (!row.description || !planEarlyFollowup(row.description, row.keywords ?? []).length) followupSkipReason = 'no_complementary_strategies';
    else if (row.initial_usable === null) followupSkipReason = 'historical_metric_unavailable';
  }
  if (row.lead_monitoring_status === 'suspended') initialStatus = 'suspended';
  else if (!row.enabled) initialStatus = 'paused';
  else if (row.initial_run_status === 'failed' || row.initial_status === 'failed') initialStatus = 'failed';
  else if (row.initial_run_status) initialStatus = 'completed';
  else if (row.initial_status === 'claimed') initialStatus = 'running';
  else if (row.initial_attempts > 0) initialStatus = 'retrying';
  else initialStatus = 'waiting';
  const totalUsable = initialUsable === null ? null : initialUsable + (followupUsable ?? 0);
  const finishedFollowup = ['completed', 'failed', 'cancelled'].includes(followupStatus ?? '') || !followupStatus;
  const profileCreatedAt = iso(row.profile_created_at);
  const initialQueuedAt = iso(row.initial_created_at);
  const firstClaimedAt = iso(row.initial_claimed_at);
  const initialCompletedAt = iso(row.initial_completed_at ?? row.initial_received_at);
  const followupQueuedAt = iso(row.followup_created_at);
  const followupClaimedAt = iso(row.followup_claimed_at);
  const followupCompletedAt = iso(row.followup_completed_at ?? row.followup_received_at);
  const elapsed = (from: string | null, to: string | null) => from && to ? Math.max(0, new Date(to).getTime() - new Date(from).getTime()) : null;
  const nowIso = new Date(now).toISOString();
  return {
    status,
    initialUsablePosts: initialUsable,
    followupUsablePosts: followupUsable,
    totalUsablePosts: totalUsable,
    initialDuplicatePosts: row.initial_duplicates === null ? null : Number(row.initial_duplicates),
    followupDuplicatePosts: row.followup_duplicates === null ? null : Number(row.followup_duplicates),
    followupSkipReason,
    monitoringResumed: Boolean(row.initial_run_status && row.initial_run_status !== 'failed' && finishedFollowup && row.enabled && row.lead_monitoring_status === 'active'),
    initialStatus,
    initialQueuedAt,
    firstClaimedAt,
    initialCompletedAt,
    followupQueuedAt,
    followupClaimedAt,
    followupCompletedAt,
    initialStrategiesReported: row.initial_keywords ?? [],
    followupStrategiesReported: row.followup_keywords ?? [],
    profileToFirstClaimMs: elapsed(profileCreatedAt, firstClaimedAt),
    initialQueuedMs: elapsed(initialQueuedAt, firstClaimedAt ?? (initialCompletedAt ? initialCompletedAt : nowIso)),
    initialActiveMs: row.initial_active_ms === null || row.initial_active_ms === undefined ? null : Number(row.initial_active_ms),
    initialClaimToCompleteMs: elapsed(firstClaimedAt, initialCompletedAt),
    followupQueuedMs: elapsed(followupQueuedAt, followupClaimedAt ?? (followupStatus === 'pending' ? nowIso : followupCompletedAt)),
    followupActiveMs: row.followup_active_ms === null || row.followup_active_ms === undefined ? null : Number(row.followup_active_ms),
    followupClaimToCompleteMs: elapsed(followupClaimedAt, followupCompletedAt),
  };
}

/** Whether the Today page should lead with the first-scan view: the user has a profile but no finished scan yet. */
export function isFirstRun(scan: FirstScan | null): boolean {
  return Boolean(scan && ['waiting', 'running', 'delayed', 'paused'].includes(scan.state));
}
