# Muse Personal Agent Hook wake signal POC

Date: 2026-11-02. The backend POC is implemented. The operator reports both the Hook detection test and the first complete Hook → Muse Agent → scoped Worker claim → Facebook search → QLead result E2E passed. The first detection test observed 6 calls at 30-second intervals, 1 wake, about 12 seconds to agent start, and 5 later polls suppressed as `already_seen`. The controlled E2E then made 1 claim, completed 1 search over 60 Facebook results, inserted 2 posts, and received HTTP 200 in about 55 seconds from detection. The Hook was manually disabled and removed by the Muse main agent. The database-confirmed E2E and permanent operations model are recorded in [HOOK_OPERATIONS.md](HOOK_OPERATIONS.md). No Hook is currently enabled according to the operator; QLead cannot read Muse Hook status.

## Audit and root cause

- A new enabled search profile and a resumed never-scanned profile get an `initial` row immediately from `enqueueInitialJob` (`web/lib/server/profiles.ts` → `src/jobs.ts`). The insert is idempotent and pausing cancels pending initial work.
- Recurring jobs are **not** created when a profile is saved or when time passes. They are inserted by `enqueueDueJobs` inside `claimJobs`, so they do not exist before a worker calls `POST /api/worker/jobs/claim`. That means a signal looking only at `search_jobs` would miss recurring work until the scheduled Muse task had already run.
- Only `active` workers can claim. `draining`, `paused`, and `unavailable` workers claim zero. Credentials also need to remain active. The admin handoff changes the source to draining (then paused/unavailable) and activates the destination at cutover; emergency handoff releases old leases. There is no database uniqueness constraint against multiple active workers, so this endpoint fails closed unless exactly one credentialed active worker exists.
- Claims expire old leases, reconcile source permissions, and atomically select due pending jobs with `FOR UPDATE SKIP LOCKED`. Retryable failures return to pending with `available_at = now + 5 minutes × attempts`; expired leases are requeued unless attempts are exhausted. Blocked, failed, needs-reauthorization, future scheduled and backoff jobs are not claimable.
- A profile has at most one open job. When jobs are pending while the worker is already running, a second task would be wasteful; the wake signal is suppressed while the active worker has a non-expired lease. If a lease expires, the read-only detector treats it as claimable when attempts remain, matching what the next claim would do after lease cleanup.
- Switching workers does not move customer data. The queue is shared; only an active authorized worker can claim. A paused standby is inert if it is the only worker. Because this public endpoint has no caller identity, it cannot distinguish which Muse account is polling: configure the Hook only on the designated active account and disable it on the source account during handoff. The backend itself never wakes Muse.

## Endpoint

`GET /api/public/worker-wake`

Responses are only `{ "wake": false }` or `{ "wake": true, "generation": "<opaque SHA-256 marker>" }`; all include `Cache-Control: no-store`. It returns no user, profile, query, post, job, worker, credential, or internal error fields. The marker hashes internal identifiers and state; those identifiers are not returned. There are no URL secrets, parameters, or mutations. A per-source-IP in-memory limit allows 30 requests per minute and returns an inert 429 after that.

The query looks for (a) due, available, authorized pending jobs, (b) expired leases with attempts remaining, and (c) recurring slots whose config is enabled and whose job has not been materialized yet, using the same slot and duplicate-suppression conditions as `enqueueDueJobs`. It suppresses the signal unless exactly one credentialed active worker exists and that worker has no unexpired job in flight.

The generation marker stays stable for unchanged eligible work and changes when the eligible set, attempt state, worker epoch, recurring slot, or bounded recovery phase changes. Recovery age is anchored to the item's own eligibility (or expired lease), config/slot time, and worker status epoch; an unrelated successful search does not restart an older item's recovery budget. A new job after a completed job has a different fingerprint and therefore a distinguishable generation. The Hook's persistent `already_seen` state deduplicates each marker.

Because the endpoint is read-only and anonymous, it cannot know whether a Hook observed a marker or whether its agent failed before claiming. For one unchanged eligible item, the backend now exposes at most three distinct generations: immediately, at 5 minutes, and at 15 minutes after that item's eligibility anchor. The marker then stays stable, so the detector does not enter an infinite wake loop. A retryable job remains quiet throughout `available_at` backoff; when it becomes available again, its updated job state starts a new recovery sequence. Worker pause/handoff changes the worker epoch and therefore the fingerprint; unrelated successful work does not reset another item's recovery budget.

This is bounded recovery, not an acknowledgement protocol. If a job is already older than 15 minutes the first time the Hook sees it, its first marker may already be in the final phase and will not get two later recovery markers. After the recovery budget is spent, the pending job remains visible to QLead operators and requires intervention; this endpoint does not mutate or terminally fail it. Exact Hook behavior for changed retry-phase markers remains to be verified in a controlled real Hook test.

There is an unavoidable identity boundary: a public no-credential URL cannot prove which Muse account made the request. Therefore only the active worker's Hook should poll it. On handoff, disable the old account's Hook and enable the new account's Hook as a controlled configuration change. The endpoint itself returns inert when no unique active worker exists.

## Safeguards and ownership

- **Backend:** only reports currently eligible work; checks worker status/credential, source authorization, due time, retry backoff, lease state, handoff status as represented by worker status, and in-flight work; returns stable phase markers with a cap of three per unchanged event; rate limits; does not enqueue, claim, or mutate.
- **Persistent Hook detector:** records the last observed generation and suppresses repeated observations of that same marker after one trigger. It must treat a changed marker as new, while honoring the three-event cap. A detector with no durable state can launch duplicate executions even though the response is stable. The backend cannot persist which public Hook has observed or acted on a marker without adding a write/acknowledgement API, which this POC intentionally avoids.
- **Quota/unavailable conditions:** quota and Facebook availability are only known after Muse runs; the backend cannot read Muse quota. Worker `unavailable`/paused status produces no eligible worker. A retryable job is quiet until its backoff expires. The Hook should stop on quota/error, report it, and avoid creating its own retries.
- **Handoff:** only one active worker is accepted. A paused Muse 02 does not qualify. The Hook must be enabled only for the account that Admin has designated active; because requests are anonymous, a mistakenly retained old Hook can observe the new active worker's signal even though its own claim will be rejected.
- **Controlled claim scope:** `POST /api/worker/jobs/claim` now accepts optional `search_profile_id`. With this filter, expired-lease recovery, due-job insertion, authorization reconciliation, and selection are scoped to that profile. This allows the first E2E run to leave other customer jobs untouched. It does not change the public wake response or grant additional worker access.

## Verification

The isolated PostgreSQL database `muse_bridge_wake_test` is used for synthetic backend tests. The suite covers empty work, initial work, unchanged generations, claim/in-flight clearing, completion, new events, bounded recovery, retry backoff, pause, handoff, scoped claims, response privacy, scan/post history preservation, and bounded initial/manual priority without starving older recurring work. The latest backend run passed **90/90** tests with no skips; backend TypeScript build passed. Tests remain isolated from the live database.

The endpoint has only process-local rate limiting; multiple API replicas would each have a separate bucket. The current app is a single local API process. The generation hash is deterministic across restarts, but the Hook still needs persistent generation state.

The real one-shot Hook result supplied by the operator verifies the unchanged-marker `already_seen` path and one complete search. It does not yet prove a persistent Hook wakes again for a genuinely new generation, handles 5/15-minute recovery markers, or preserves deduplication state across disable/re-enable. No permanent Hook is enabled by this backend.

## Current live workload boundary

The workload details from the original one-shot run are historical, not a current queue snapshot. That profile completed its test. Do not reuse its profile ID, conditions, or old queue snapshot as authorization for another search. Before any future live search, inspect the current eligible workload read-only and obtain explicit approval for the exact profile and conditions. The public wake signal is global; authenticated claims can be scoped with `search_profile_id`.

The public base URL is deployment-specific. Read `QLEAD_WORKER_PUBLIC_URL` from the web environment or copy the generated prompt on `/admin/workers`. Do not reuse a historical ngrok URL without verifying it.

## Muse Hook activation boundary

No permanent Muse Personal Agent Hook is enabled by this backend. After explicit approval, use the generated Vietnamese activation prompt on `/admin/workers` from the Muse MAIN account. It requires persistent `hook_state_get` / `hook_state_set` deduplication and preserves state across disable/re-enable. QLead cannot observe or control Muse Hook state. Muse-side persistent-generation and quota verification remain required.

## Completed one-time test

The real one-shot Hook → worker → Facebook search → result submission test has already completed. Do not run its former one-shot prompt again. The detection-only setup prompt is also historical; use a current `QLEAD_WORKER_PUBLIC_URL` if a future test is separately approved.
## E2E observations and customer states

| Milestone | Evidence source |
|---|---|
| Job eligible | `search_jobs.scheduled_for`, `available_at`, `created_at`; for a not-yet-materialized recurring slot, the slot time from the reviewed config |
| First Hook detection and poll count | Muse Hook run history plus Fastify's timestamped `/api/public/worker-wake` request logs |
| Agent start | Muse run history |
| Worker claim | `search_job_attempts.claimed_at` and the claim HTTP acknowledgment |
| Facebook search start/end | ISO timestamps recorded by Muse immediately before/after its actual search |
| Result accepted | `scan_runs.received_at` plus the result HTTP acknowledgment |
| Lead visibility | `facebook_posts.first_seen_at` and a timestamped customer-dashboard check; empty successful scans have no lead row |
| Retries/completion | `search_job_attempts`, `search_jobs.status`, and `scan_runs.status` |
| Usage/quota | Muse UI readings before/after, if available; do not infer polling cost |

Expected customer states: an unclaimed first scan shows **waiting**; an active valid lease shows **running**; a stale/blocked/retried job shows **delayed**; a completed scan with new posts shows **results** and tenant-owned leads; a successful empty scan shows **no results** without creating a lead. A terminal error shows **failed**. The dashboard remains tenant-scoped through the profile's `user_id` ownership.

## Disable/remove safely

1. In Muse Personal Agent Hook settings, disable the detector first; verify its next scheduled/queued run is cancelled.
2. Remove the Hook if it is no longer needed. Also remove any separate scheduled task that invokes it.
3. If a job was ever claimed during a separately approved test, inspect its lease/status in QLead Admin. Let a valid lease finish, or mark the worker unavailable and use the existing admin release path; do not delete job or scan history.
4. During worker handoff, disable the old account's Hook before it can observe the new active worker's signal. Leave the standby account without an enabled Hook.

## Remaining evidence before permanent operation

The one-time Hook-to-lead E2E is verified by the operator and read-only database audit. Before enabling permanent monitoring, verify in Muse that generation A is deduplicated, a genuinely new generation B wakes once, changed 5/15-minute recovery generations are each processed once, and disabling/re-enabling preserves detector state. Measure actual Muse usage/quota for the polling interval; do not infer it from call or wake counts. Migration `012_natural_language_search.sql` was applied to the confirmed local `muse_bridge` database on 2026-11-02 after a custom-format backup was created and verified; existing data fingerprints matched. See [HOOK_OPERATIONS.md](HOOK_OPERATIONS.md) for the reusable configuration and handoff runbook.
