# Search delivery and latency audit

## Findings from the current backend

- **First job scheduling:** saving an enabled profile calls `enqueueInitialJob` in the profile transaction (`web/lib/server/profiles.ts`). It creates an immediately due `initial` row. `claimJobs` has an idempotent repair path if that enqueue was missed. Job creation does not wait for a recurring scan slot.
- **Worker pickup:** Muse sees jobs through the existing public polling Hook. `src/wake-signal.ts` can report work; it cannot call or start Muse. The checked-in Hook runbook records a 30-second polling interval in a real test. That interval is the shortest known pickup opportunity; it is not a backend wake guarantee.
- **Observed end-to-end timing:** `HOOK_OPERATIONS.md` reports one real run with job created/claimed at `2026-11-02T11:34:50.171Z`, search timestamp `11:35:35Z`, and result accepted `11:35:36.666Z`. This observed run took about 46 seconds from claim to accepted results and about 55 seconds from Hook detection to acceptance. It is one sample, not a P95 benchmark. No reliable production P95 is available here.
- **Fairness:** the claim query gives `initial`/`manual` work a 30-minute ordering boost, then sorts by age and deterministic profile/job keys. `SKIP LOCKED`, a per-worker row lock, live lease capacity, and account/profile suspension checks bound duplicate claims and keep routine work in the same queue.
- **Worker state:** `ACTIVE` and a one-time `/api/worker/status` verification do not prove that a Muse Hook is currently polling. `GET /api/first-scan.searchReady` now reports `false` if no verified active worker is configured, `true` only for a live claim on that job, and `null` when Hook health is not observable. The leads contract separately includes authenticated-contact and claim timestamps.
- **Retries and stuck work:** claims create persisted attempt rows and leases. Expired leases are recovered by the next claim; retryable failures return to pending with backoff. A worker can remain marked `ACTIVE` while not polling, so operator evidence must use last authenticated contact/claim timestamps and Muse-side Hook state.
- **Result shape:** the current Muse worker posts one completed results payload. QLead stores all posts and scan metrics in the result transaction. There is no partial-results callback or safe incremental result ID in this contract, so the backend cannot expose partial scan results without a Muse protocol change.
- **Backlog delivery:** `GET /api/leads` (and the existing server-rendered list path) can deliver stored pending leads without a new Muse scan. A unique per-profile interval key and account/profile locks make page retries idempotent.

## Chosen delivery design

Migration `021_lead_distribution.sql` adds three additive tables: per-profile limits/expiry, distribution cycles, and per-profile post delivery states. Existing source-linked profile leads are backfilled as delivered. New source-linked posts enter the persistent `queued` state the next time the user's lead list is read. Posts remain stored when expired, and history reads filter only by delivered state.

Each configured search frequency interval is one delivery cycle. The database selects up to the stored `max_leads_per_scan` (default 10) across the entire queue, ordered in SQL by exact profile keyword matches, Facebook publication freshness, active opportunity signals, and available metadata. The SQL query returns only the selected IDs to the application. Account locking prevents the same Facebook URL being issued by two profiles of one account at once; tenant filters still allow another account to receive the same public post independently.

The default expiry is 30 days. For a missing Facebook post timestamp, the expiration clock uses the QLead discovery timestamp. Expired records retain their source post and history row. Neither cap nor expiry controls how many posts Muse searches or how many QLead stores.

## Verification

- Root TypeScript build: passed.
- Web TypeScript check: passed.
- Distribution unit tests: passed (3).
- Isolated PostgreSQL delivery test: passed. It verified 60 queued leads → 10 delivered/50 queued, repeated concurrent calls sharing the same cycle, a higher-ranked newer candidate, a second batch from backlog with no new scan, configurable cap increase to 20, one-item delivery, tenant isolation, suspension, and expiry retention.
- Migration upgrade check: all migrations 001–020 applied to a new local test database, a historical linked post was inserted, migration 021 was applied, and the history row was `delivered` afterward.
- Synthetic delivery integration execution completed in under one second on the local Docker database for its multi-cycle fixture. This is a small local correctness run, not a representative latency benchmark.

## Remaining limits

- The product cap is implemented in the lead-list delivery path. Search execution volume is unchanged; Muse still scans according to its own current task instructions.
- Muse polling is the external start boundary. QLead has no push/wake API into Muse, and the real Hook polling interval/cost must be measured in Muse if it changes.
- Progressive results are unsupported until Muse sends safe incremental result batches. Current result ingest is atomic at final submission.
- The per-cycle limit currently follows each profile's configured monitoring frequency. It is configurable per profile in the database; no subscription or billing behavior exists.
- The existing anonymous landing-page preview limit remains on its independent code path and is not modified by customer delivery.
- No production migration, data write, merge, or deployment was performed.
