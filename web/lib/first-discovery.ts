import type { FirstScan } from './first-scan';

/**
 * The customer's view of the first-discovery episode (first search plus at most one early "search more"), derived
 * only from GET /api/first-scan. Pure, so the page, Today, the lead list and tests read the same answer.
 *
 * stage 'initial': the first search has not finished; the first-scan phases describe it.
 * stage 'more':    the first search finished and QLead is still looking further (planned, waiting, running, retrying).
 *                  Results of the first search are already in the lead list.
 * stage 'done':    nothing more is open for this episode; regular monitoring takes over.
 *
 * Counts are new source posts that meet the lead criteria (the backend's `usable` posts, the same rule the lead list
 * uses). They are not distinct businesses. Duplicate URLs are already excluded by the backend.
 */
export type DiscoveryStage = 'initial' | 'more' | 'done';
export type MoreState = 'planned' | 'waiting' | 'running' | 'retrying';
/** How the extra search ended: found more, found nothing new, did not complete, or never ran. */
export type MoreOutcome = 'found' | 'none' | 'failed' | 'not_run';

export type DiscoveryView = {
  stage: DiscoveryStage;
  /** Leads from the first search; null while it runs, or for older scans that never recorded the usable count. */
  initialLeads: number | null;
  /** Leads from the extra search; null until it finished (or when it never ran). */
  moreLeads: number | null;
  /** First search + extra search. Null only while the first search is open. */
  totalLeads: number | null;
  more: MoreState | null;
  moreOutcome: MoreOutcome | null;
  /** When the first search finished, from its stored scan; null before. */
  initialFinishedAt: string | null;
  moreStartedAt: string | null;
  moreFinishedAt: string | null;
  moreQueuedAt: string | null;
  /** The customer paused this need, or the account is suspended: QLead does not look further. */
  hold: 'paused' | 'suspended' | null;
  /** The first search did not complete (it is retried by the schedule). */
  initialFailed: boolean;
};

/** An extra search waiting this long without starting is described as slower than usual (never as an error). */
export const MORE_SLOW_MS = 10 * 60_000;

export function discoveryView(scan: FirstScan): DiscoveryView {
  const d = scan.discovery;
  const hold = d?.status === 'suspended' ? 'suspended' : d?.status === 'paused' || scan.state === 'paused' ? 'paused' : null;
  const initialFinished = d ? d.initialStatus === 'completed' || (Boolean(scan.finishedAt) && scan.state !== 'failed') : scan.state === 'results' || scan.state === 'no_results';
  // `usable` is only recorded for scans stored after the backend change; older ones fall back to the stored new-post
  // count. Each count is paired with the time of the same scan, so numbers and times never come from different scans.
  const measured = d?.initialUsablePosts !== null && d?.initialUsablePosts !== undefined;
  const initialLeads = !initialFinished ? null : measured ? d!.initialUsablePosts : scan.newPosts ?? 0;
  const base: DiscoveryView = {
    stage: 'initial', initialLeads, moreLeads: null, totalLeads: null, more: null, moreOutcome: null,
    initialFinishedAt: !initialFinished ? null : measured ? d!.initialCompletedAt ?? scan.finishedAt : scan.finishedAt,
    moreStartedAt: d?.followupClaimedAt ?? null, moreFinishedAt: d?.followupCompletedAt ?? null, moreQueuedAt: d?.followupQueuedAt ?? null,
    hold, initialFailed: scan.state === 'failed' || d?.initialStatus === 'failed',
  };
  if (!initialFinished) return base;

  // The backend reports "failed" and "retrying" for either search; the first search finished here, so they describe the extra one.
  let more: MoreState | null = null;
  if (!hold) switch (d?.status) {
    case 'followup_planned': more = 'planned'; break;
    case 'followup_waiting': more = 'waiting'; break;
    case 'followup_running': more = 'running'; break;
    case 'retrying': more = d.followupQueuedAt ? 'retrying' : null; break;
  }
  const moreRan = Boolean(d?.followupCompletedAt) && d?.followupUsablePosts !== null && d?.followupUsablePosts !== undefined;
  const moreLeads = moreRan ? d!.followupUsablePosts : null;
  const totalLeads = (initialLeads ?? 0) + (moreLeads ?? 0);
  if (more) return { ...base, stage: 'more', more, totalLeads };

  let moreOutcome: MoreOutcome = 'not_run';
  if (moreRan) moreOutcome = moreLeads! > 0 ? 'found' : 'none';
  else if (d?.status === 'failed') moreOutcome = 'failed';
  return { ...base, stage: 'done', moreLeads, totalLeads, moreOutcome };
}

/** Whether something in this episode is still open, so views keep following the stored state. */
export function discoveryOpen(scan: FirstScan): boolean {
  const view = discoveryView(scan);
  return view.stage === 'more' || (view.stage === 'initial' && !view.initialFailed && !view.hold);
}
