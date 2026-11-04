# First scan for new customers

## Audit: why new customers waited

- Jobs were only created inside `claimJobs` → `enqueueDueJobs`, when a worker polled. A new profile had no job until the next poll, and that poll depends on the Muse scheduled task running on its own schedule.
- **Immediate Muse execution is not supported.** Workers pull work (`POST /api/worker/jobs/claim`); there is no documented or tested way to wake a Muse agent, and none was added. On 02/11 the only worker had last polled at 10:40 (VN), so a new profile would have waited indefinitely.
- The old dashboard then showed zero counts, an empty list and a countdown computed from the frequency.

## What changed

**Initial job (migration `011_initial_search_jobs.sql`, additive):**
- New column `search_jobs.kind` (`scheduled` or `initial`), plus a unique index allowing one live initial job per profile (a cancelled one can be replaced).
- `enqueueInitialJob` in `src/jobs.ts` queues a real job (real `scan_id`, current configuration version, `scheduled_for = now()`). It runs when a profile is saved enabled (onboarding or Nhu cầu theo dõi), or resumed, and has never been scanned. It is idempotent: the open-job and one-initial indexes make repeats no-ops.
- `claimJobs` gives initial and explicit manual jobs a bounded 30-minute head start, then orders all eligible work by adjusted due time. An older recurring job therefore overtakes newer urgent work after the boost window; lease, retry and authorization handling stay in the same PostgreSQL queue.
- `enqueueDueJobs` skips a profile that already had a job in the current slot. After a first scan it also waits half an interval, so a profile activated just before a slot boundary is not scanned twice within seconds (found by the E2E). The 30-minute monitoring logic is otherwise unchanged.
- Pausing cancels a not-yet-claimed initial job; resuming queues a new one if the profile still has no scan.

**Status model** (`web/lib/server/first-scan.ts`, read from the DB on every request):

| Customer state | Stored facts |
|---|---|
| Đang chờ bắt đầu lượt tìm đầu tiên | initial job `pending`, queued less than one interval ago |
| QLead đang tìm bài đăng phù hợp | job `claimed` with a valid lease |
| Việc tìm kiếm đang chậm hơn dự kiến | pending longer than one interval, retried, blocked, or lease expired |
| QLead đã tìm thấy cơ hội đầu tiên! | first `scan_runs` row, new posts > 0 (up to 5 real leads shown) |
| Lượt tìm đầu tiên đã hoàn tất | first run successful, 0 new posts (shows "đã xem N bài") |
| Việc tìm kiếm đang chậm hơn dự kiến (failed) | job or run failed |
| Đã tạm dừng theo dõi | latest config disabled, no run yet |

There is no "processing results" state: results are stored in one transaction, so that stage cannot be observed.

**UI:**
- After onboarding the customer lands on `/app/lan-tim-dau`. The page polls `GET /api/first-scan` every 5 seconds while the scan is open and stops once it has finished or is paused.
- It shows the profile name, the customer's own description, the search terms, and step dots (Đã lưu → Chờ bắt đầu → Đang tìm → Có kết quả).
- The goat scene follows the state:
  - Waiting: still goat, a slowly breathing ring and an indeterminate bar.
  - Searching: animated goat, spinning ring and floating post cards.
  - Results: the goat with a spark, and lead cards that rise in.
  - Paused or failed: a muted goat.
- No percentages are shown, and `prefers-reduced-motion` stops all of it.
- Lead cards keep the post evidence (quote), the detected signal and a neutral sales note ("Có thể phù hợp để tiếp cận…") separate.
- On Hôm nay, until the first scan finishes, the first-scan view replaces the zero stat cards and the empty list.

**Not implemented: preview from existing data.** Posts are stored per customer connection, so a preview would mean showing another tenant's records. It is not done.

## Verification

- `web/e2e/first-scan-e2e.mts`: 12/12. It runs on the test DB with real UI registration and a synthetic worker through the real worker API (no Muse or Facebook).
- Scenarios covered:
  - A: queued state survives refresh.
  - B: the initial job is claimed before an hour-old routine job, and the UI shows searching.
  - C: 2 synthetic posts appear without reload, are associated with v1, and create no duplicate slot job.
  - D: an empty result shows the no-result state and the profile stays enabled.
  - E: an unclaimed job shows as delayed.
  - I: pausing cancels the job; resuming re-queues it.
  - F: tenant isolation for the API, URLs and Today.
  - G: 1440/768/390 layouts and reduced motion.
- Also green: `profiles-e2e` 17/17, `accounts-e2e` 16/16, `qlead-e2e` (live DB, read-only) 31/31, backend `npm test` 64/64, type-check and production build.
- Screenshots are in `docs/first-scan-screenshots/`.

## Remaining limits on time to first result

- Enabled first-scan jobs are queued immediately. The public wake signal can detect that job without authentication; actual execution still requires the approved Muse Personal Agent Hook to be enabled on the designated active worker. The one-shot Hook-to-lead E2E passed, but permanent Hook generation/recovery behavior and polling quota have not been verified in Muse. QLead must not claim an ACTIVE database worker means its Muse Hook is enabled.
- Recurring jobs are still materialized by the worker claim path. The read-only wake endpoint detects due recurring work before that insertion, so a working persistent Hook can prompt the claim.
- Customers are told "delayed" when the queued job has not been picked up after 20 minutes; QLead cannot promise an ETA beyond that.
