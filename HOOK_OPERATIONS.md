# QLead permanent Muse Hook operations

## Verified E2E result

The operator reports a real Muse Personal Agent Hook → Muse Agent → QLead Worker claim → Facebook search → result submission run passed:

- Hook polls: 1 wake for the eligible event; the detector was then manually disabled and removed by the Muse main agent.
- QLead recorded one scoped claim and one completed initial job for profile `80b8b9c2-96ef-4105-943d-81346b1aca16` (`Quán cà phê sắp khai trương`).
- Search: 60 results examined; one successful scan, two new posts, zero updates/duplicates skipped; result accepted by QLead.
- Database times: job created/claimed `2026-11-02T11:34:50.171Z`; search timestamp `2026-11-02T11:35:35Z`; result accepted `2026-11-02T11:35:36.666Z`.
- The operator observed HTTP 200 and about 55 seconds from Hook detection to result acceptance.
- Read-only database verification found exactly one non-cancelled job, one claim attempt, and one scan linked to that job for the target profile. Both inserted Facebook posts belong to the profile owner, have a Facebook host and meet the dashboard's completeness filter. Both pass the user-scoped profile lookup used by the dashboard.
- In the run window `2026-11-02T11:34:00Z`–`11:37:00Z`, no other profile was claimed. Two older attempts elsewhere in the database were outside that E2E window.
- The dashboard's result-state logic will resolve this profile to `results`; a customer-authenticated visual browser check was not performed in this audit.

No historical rows were changed during verification. Do not infer Muse quota usage from polling or wake counts; no usage measurement was supplied.

## What each status means

QLead can report these independent facts:

| Fact | QLead evidence | What it does not prove |
|---|---|---|
| Worker database status | `muse_workers.status`: active, draining, paused, unavailable | That a Muse Hook is configured or polling |
| Connector verification | Most recent successful `/api/worker/status` request and active credential | That Muse is online now, or that a Hook is enabled |
| Last `/claim` call | `muse_workers.last_claim_at` | That the call returned a job |
| Last successful claim | Latest `search_job_attempts.claimed_at` for the worker | That the search succeeded |
| Last successful job | `muse_workers.last_success_at` and completed attempt history | That the Hook remains enabled |
| Muse Personal Agent Hook | **Not observable by QLead** | No PostgreSQL worker status is a substitute for checking Muse |

Admin must verify Hook enabled/disabled state in the Muse main account. The `/admin/workers` page labels Hook status as not observed by QLead and never infers it from `ACTIVE`.

## Permanent detector behavior

Keep one reusable Muse **Personal Agent Hook** under the Muse main account, named `QLead Worker Wake`. This is not a Muse Code lifecycle hook. Configure its target to the one worker currently marked `ACTIVE` in QLead. The detector itself only GETs the public endpoint; the awakened worker uses its already-onboarded `QLead Worker` connector for authenticated calls.

- Poll every 30 seconds, the interval exercised in the real Hook test. The polling/quota cost is unknown and must be measured in Muse before deciding on a permanent interval.
- GET `<QLEAD_WORKER_PUBLIC_URL>/api/public/worker-wake` with `ngrok-skip-browser-warning: true`. Send no credential, cookie, authorization header, query string, or tenant information to this public endpoint.
- On `wake:false`, do nothing. On an HTTP error or 429, do not start a worker run; let only the normal next detector poll retry observation.
- On `wake:true`, require a valid generation. Persist/reserve that generation before starting the agent task so overlapping polls cannot start duplicate runs. Do not re-run the same generation.
- Each Hook-triggered agent cycle claims at most one job (`max_jobs: 1`). After its lease ends, the remaining eligible queue changes the generation and can wake the next cycle; repeated polls while that job runs stay silent.
- Persist detector state across restarts, pauses, re-enables and worker handoffs. Do not permanently disable the Hook after a successful run. A later different generation must start another run.
- If an agent run fails before claim, do not retry the same generation. The backend can expose at most two changed recovery generations for the unchanged event, at 5 and 15 minutes after its eligibility anchor. Process each changed marker once; never add an agent-side retry loop. After the third marker, operator intervention is required.
- After a valid claim, the endpoint is quiet while that worker holds a live lease. A completed job changes the eligible set; genuinely new jobs/slots and worker epochs can produce new markers.
- Do not execute when the worker is paused, draining, unavailable, revoked, or not the sole designated active worker. Keep standby polling disabled to avoid detector work and any associated quota use.

The backend is read-only and cannot acknowledge that Muse observed/processed a generation. Persistent Hook detector state is therefore required. The backend's bounded recovery is the fallback when a wake fails before claim; it is not an at-least-once delivery guarantee.

## Reusable activation instructions

From the Muse main account, use the **Hướng dẫn Hook** prompt on `/admin/workers` for the selected active worker. It includes the current public API base URL, the detector rules above, and that worker's existing one-cycle claim/search/result instructions. Before enabling, verify in QLead Admin that the intended worker is `ACTIVE`, its credential is active, and its connector was verified once. The prompt must not alter credentials or schedules.

Confirm the Hook is actually enabled in Muse main account; QLead will continue to show Hook state as manually verified/unknown because Muse exposes no Hook status API here. Do not enable a Hook for a paused standby worker.

## Reusable deactivation instructions

From Muse main account, use the **Tắt Hook** prompt on `/admin/workers`. Pause/disable future polls and confirm the next poll is cancelled. Preserve its saved generation state. Do not delete the worker's persistent connector or credential. Do not terminate an already-running task that holds a valid QLead lease; let it finish and submit its result.

## Admin-controlled worker handoff

Onboarding is one-time per worker: create its persistent `QLead Worker` connector, save that worker's credential in Muse Secure Credentials Store, and run the one-time status check. Keep that worker's Hook disabled while it is standby. Do not copy or rotate credentials just to switch accounts.

Normal switch, including switching back:

1. In QLead Admin, prepare the handoff and review pending, blocked, retry and in-flight jobs.
2. In Muse main account, disable the current Hook before draining. Preserve detector state and the source connector. Do not interrupt an already-running job.
3. In QLead Admin, start draining the source. Wait for valid in-flight work to finish; pending jobs remain in PostgreSQL.
4. Complete the QLead cutover. Only the destination becomes active; the source is paused. Customer profile, lead and scan-history rows remain owned by customers and are not moved.
5. In Muse main account, retarget/re-enable the same persistent Hook for the destination worker. Keep the source/standby polling off. Preserve the detector's last-generation state.
6. Verify a real destination `/api/worker/status` contact and, when work exists, its successful claim/completion in QLead Admin. Finish the handoff after QLead's recorded evidence satisfies the handoff flow.
7. To switch back, repeat these steps in reverse. Reuse each worker's existing connector and credentials.

Emergency handoff uses the existing QLead release path. The source is marked unavailable and its in-flight attempts are released for a later retry; job, scan and lead history remain in PostgreSQL. Late submissions by the old worker are rejected. Use only when waiting for normal drain is unsafe.

## Controlled test coverage and remaining proof

The isolated `muse_bridge_wake_test` suite verifies new generations after completion, stable deduplication for unchanged markers, bounded recovery, retry backoff, pause, handoff and profile-scoped work. Keep it isolated; never relax safety checks because the live database contains customer profiles.

Migration `012_natural_language_search.sql` was applied to the confirmed live local PostgreSQL database `muse_bridge` through the existing migration runner on 2026-11-02. Before applying it, a custom-format backup was created and verified with `pg_restore --list`. Post-migration verification confirmed the expected `scan_configs.keywords_source` definition, the manual-job constraint/FK/index, and unchanged fingerprints for existing data rows (excluding only the newly added columns and migration-history row). A read-only `EXPLAIN` confirmed the claim SELECT can resolve the added fields. The migration mismatch is resolved; it does not constitute approval to activate a Muse Hook or run a search.

Still needed before calling the permanent Hook operationally proven:

1. With no real Facebook search, observe Muse Hook persist generation A, suppress repeated polls, then process genuinely new generation B once without removing/recreating the Hook.
2. Observe changed 5/15-minute recovery markers in the actual Hook and verify it does not loop on one marker.
3. Measure actual Muse usage/quota with Hook polling enabled versus disabled; do not assume a GET poll is free.
4. Confirm manual pause/disable and re-enable preserve state, and verify the Hook remains off for standby during a Worker 01 ↔ Worker 02 handoff.
5. Perform a customer-authenticated dashboard visual check for the real E2E posts; the database audit confirms the records meet the tenant-scoped dashboard query conditions, but that browser check has not been performed here.

Do not enable the permanent Hook until the operator completes/approves the Muse-side checks and is satisfied with measured polling cost.
