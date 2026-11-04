/**
 * Customer-facing state of the first scan of a customer's first search profile, read from search_jobs and
 * scan_runs. `waiting`: queued, nobody has started it. `running`: an authorized search has claimed it and holds a
 * valid lease. There is no reliable "processing results" stage: results are stored in one transaction.
 */
export type FirstScanState = 'waiting' | 'running' | 'delayed' | 'results' | 'no_results' | 'failed' | 'paused';

export type FirstScan = {
  state: FirstScanState;
  profile: { id: string; name: string; description: string | null; keywords: string[]; location: string; frequencyMinutes: number; createdAt: string };
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Posts the scan looked at and posts it newly stored, exactly as recorded; null before the scan finished. */
  totalFound: number | null;
  newPosts: number | null;
  /** Additive backend contract for Claude's discovery progress view; counts are new usable source posts, not businesses. */
  discovery: {
    status: 'initial_waiting' | 'initial_running' | 'initial_completed' | 'followup_planned' | 'followup_waiting' | 'followup_running' | 'completed' | 'no_additional_coverage' | 'failed' | 'retrying' | 'paused' | 'suspended';
    initialUsablePosts: number | null;
    followupUsablePosts: number | null;
    totalUsablePosts: number | null;
    initialDuplicatePosts: number | null;
    followupDuplicatePosts: number | null;
    followupSkipReason: 'threshold_met' | 'no_complementary_strategies' | 'configuration_changed' | 'historical_metric_unavailable' | 'another_job_queued' | null;
    monitoringResumed: boolean;
    initialStatus: 'waiting' | 'running' | 'completed' | 'failed' | 'retrying' | 'paused' | 'suspended';
    initialQueuedAt: string | null;
    firstClaimedAt: string | null;
    initialCompletedAt: string | null;
    followupQueuedAt: string | null;
    followupClaimedAt: string | null;
    followupCompletedAt: string | null;
    initialStrategiesReported: string[];
    followupStrategiesReported: string[];
    profileToFirstClaimMs: number | null;
    initialQueuedMs: number | null;
    initialActiveMs: number | null;
    initialClaimToCompleteMs: number | null;
    followupQueuedMs: number | null;
    followupActiveMs: number | null;
    followupClaimToCompleteMs: number | null;
  };
};

export const FIRST_SCAN_ACTIVE: FirstScanState[] = ['waiting', 'running', 'delayed'];
