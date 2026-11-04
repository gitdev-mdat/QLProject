# Natural-language search, edit sync and manual re-scan

Date: 2026-11-02. Status: implemented and verified against isolated test databases with a synthetic worker. **Not yet verified with a real Muse run** (see Limitations).

## 1. Root cause of the redundant keyword field

`/app/bo-loc` was built on the original Muse contract: a job carried only `search: { keywords, location, sources }` (`src/jobs.ts`, `claimJobs`, `RETURNING ... sc.keywords, sc.location, sc.sources`). The description existed only as display text (`scan_configs.description`, migration 009). Because Muse could not see the description, the form had to make the customer maintain the executable phrases themselves: `profileInput` required `keywords: min(1)` and `location: min(1)` (`web/lib/server/profiles.ts`), and the "Gợi ý điều kiện" button copied suggestions into an editable "Cụm tìm kiếm" textarea. The same intent had to be kept in two places.

## 2. Did Muse previously receive the description?

No. Evidence before this change:

| Question | Finding |
|---|---|
| Description in job payload? | No. `ClaimedJob.search` = keywords, location, sources only. |
| Does editing the description change keywords? | No. `changeProfile` stored the description but kept whatever keywords the form sent. |
| Version increments? | Yes, every change appended `scan_configs.version + 1`. |
| Old pending jobs stale? | Yes. A pending job kept its `configuration_version`; `claimJobs` joins `sc.version = j.configuration_version`, so it would run the old keywords. |
| Edit enqueues a search? | No (only first enable/resume of a never-scanned profile queued an `initial` job). |
| Hook can detect new work? | Yes for pending jobs (`src/wake-signal.ts` reports due pending jobs), but editing created none. |
| Customer can see whether the update ran? | No; only "Lượt quét gần nhất" and the first-scan page. |

## 3. Job contract change (additive, backward compatible)

```jsonc
"search": {
  "keywords": ["khách sạn mới khai trương", "homestay mới khai trương"], // phrases to run as written (unchanged meaning)
  "location": "Đà Lạt",            // "" = no geographic limit (new: may be empty)
  "sources": ["social.search"],
  "intent": {                       // new
    "description": "Khách sạn, homestay mới khai trương ở Đà Lạt", // A. the customer's own words for this version
    "keywords_source": "description" // B. "description" = QLead generated the phrases; "manual" = customer wrote them
  }
}
```

Evidence (C) is still only what the worker submits as posts; sales interpretation (D) stays in the web UI. The generated Muse prompt (`web/lib/admin-prompts.ts`, `runPrompt`) now says: run `keywords` as written, add no location when `location` is empty, use `intent.description` only to judge whether a post plausibly fits, and never imply the author asked for the customer's product. **The live Hook/agent prompt was not changed.** An agent using the old prompt ignores `intent` and still runs the new keywords, which are now generated from the latest description.

Migration `012_natural_language_search.sql`: `scan_configs.keywords_source` ('description' | 'manual', existing rows 'manual'), `search_jobs.kind` gains `'manual'`, `search_jobs.requested_by_user_id`. Applied to `muse_bridge_test`, `muse_bridge_wake_test` and the local live DB (additive only).

## 4. How the description becomes executable searches

`src/search-plan.ts` `planFromDescription(description)` — pure and deterministic, used by both the server (what is stored) and the form preview (what the customer sees):

- Recognises business types (F&B and its venues, hotel/homestay, spa, salon, gym, pharmacy, clinic, grocery, fashion, education, karaoke, shops) and stage signals (sắp khai trương, mới khai trương, đang tuyển người, mở chi nhánh, sang nhượng). Phrases = type × signal, at most 6, e.g. "nhà hàng sắp khai trương", "tuyển nhân viên nhà hàng sắp khai trương".
- Places only when named (Unicode word boundaries, so "Đà Nẵng", "Cần Thơ" match). No match means **no** region; "Miền Nam" is never inferred.
- Unrecognised wording falls back to the description's main idea and the form says so; nothing is presented as understood when it is not.
- This is keyword generation, not semantic search. Muse is not asked to invent queries.

Unless the customer explicitly opts into "Tự đặt cụm tìm kiếm" under Tùy chọn nâng cao, the server regenerates phrases from the description on every save (`resolveSearch`). Editing the description of a profile with older manual phrases switches it back to generated phrases with a visible note, so stale phrases never silently override the new intent.

## 5. Configuration versioning and stale-job handling

- Every search-relevant change (description, phrases, keyword source, location) appends a version. Name-only edits do not.
- `supersedeQueuedJobs`: not-yet-claimed (`pending`/`blocked`) jobs of older versions are cancelled with `last_error = 'superseded_by_edit'` and kept as history. A first scan or customer-requested scan that was waiting is re-queued immediately on the new version; a routine slot is recreated from the latest version on the next claim (a cancelled slot does not count as done).
- A job already claimed keeps its version and finishes against it. `worker-api` still requires the result's `configuration_version` to equal the job's; posts are attributed to that version (`facebook_post_search_configs`). It never overwrites the newer configuration. The card says "Lượt này dùng điều kiện trước khi bạn sửa".
- Stale writes: the form sends `base_version`. If the search conditions changed since that version (another tab/device), the PATCH returns 409 `stale`. An identical retry is a no-op success. Ownership: every query filters `agent_connections.user_id = session user`; foreign ids return 404.

## 6. Save / edit / re-scan behaviour

| Action | Effect |
|---|---|
| **Lưu thay đổi** | Saves a new version. No scan is requested. |
| **Lưu và tìm lại** | Same transaction: save, then `requestManualJob`. |
| **Tìm lại ngay** (card) | `POST /api/profiles/:id/scan` → `requestManualJob` with the latest saved version. |

`requestManualJob` (`src/jobs.ts`) runs under the profile row lock, so concurrent clicks serialise:
- an open job (pending/claimed/blocked) → returns it (`existing`), no new work;
- the same configuration finished < 15 min ago → `cooldown` with the remaining time;
- ≥ 10 customer-requested scans by this user in 24 h → `daily_limit` (routine monitoring is not counted);
- paused profile → `paused`;
- otherwise inserts one `manual` job (`ON CONFLICT DO NOTHING` + the one-open-job index as a backstop).

Manual jobs share initial jobs' priority in `claimJobs` and hold off the routine slot for half an interval (in `enqueueDueJobs` and the wake detector alike), so a profile is not scanned twice back-to-back. There is no plan/entitlement system in QLead yet; the daily limit is the usage control.

## 7. Wake-signal integration

Nothing calls Muse. A manual job is an ordinary pending row with `scheduled_for = now()`, which `GET /api/public/worker-wake` already reports as eligible work; its job id is part of the fingerprint, so it is a new generation. Replacing a job after an edit produces another new generation. While the sole worker holds a lease the signal stays false. Verified in `test/manual-scan.test.ts` and the browser E2E with a synthetic worker.

## 8. UI progress states and GOAT animation

State comes only from PostgreSQL (`getProfileScan`, `GET /api/profiles/:id/scan`, server-rendered into each card and polled every 5 s while open, 30 s while delayed), so it survives refresh, navigation and other devices.

| State | Source | Copy |
|---|---|---|
| saving | request in flight | "Đang lưu thay đổi…" |
| saved | PATCH 200 | "Đã cập nhật nhu cầu tìm kiếm." |
| queued | pending, < 20 min, no attempts | "Đã thêm lượt tìm mới vào hàng chờ." + indeterminate bar |
| running | claimed with a valid lease | "QLead đã nhận lượt tìm và đang xử lý." |
| results | scan_run with new posts | "Đã tìm thấy cơ hội phù hợp." + real counts + Xem lead |
| no_results | scan_run, 0 new posts | "Đã hoàn tất lượt tìm, chưa có bài phù hợp." + Chỉnh mô tả |
| delayed / failed | waiting > 20 min, retries, expired lease, blocked / failed run | honest text, no need to click again |

No percentages or fake steps. The goat is static while queued, animated only while running or celebrating real results; `prefers-reduced-motion` disables the ring, bar, panel and Lottie animation. Customers never see Muse/worker wording.

## 9. Files changed

Backend: `migrations/012_natural_language_search.sql`, `src/search-plan.ts` (new), `src/jobs.ts`, `src/wake-signal.ts`. Web: `web/lib/server/profiles.ts`, `web/app/api/profiles/[id]/route.ts`, `web/app/api/profiles/[id]/scan/route.ts` (new), `web/lib/profile-scan.ts` (new), `web/lib/profile-state.ts`, `web/lib/profile-draft.ts`, `web/components/profiles-page.tsx`, `web/components/onboarding.tsx`, `web/components/first-scan.tsx`, `web/lib/admin-prompts.ts`, `web/app/globals.css`. Tests: `test/search-plan.test.ts`, `test/manual-scan.test.ts`, `web/e2e/nl-search-e2e.mts` (new); `profiles-e2e.mts`, `first-scan-e2e.mts`, `accounts-e2e.mts` adapted to the new form (accounts A5 also had a stale expectation from the first-scan change).

## 10. Tests and screenshots

- `npm test` on `muse_bridge_wake_test`: **86 passed, 0 failed** (15 new). `npm run build`: passed. `next build --webpack`: passed.
- Browser E2E on `muse_bridge_test` (next dev :3005): `nl-search-e2e` **14/14**, `profiles-e2e` 17/17, `first-scan-e2e` 12/12, `accounts-e2e` 16/16.
- `nl-search-e2e` covers spec steps 1–23: description-only edit, reload, generated phrases, old manual phrases replaced, category change, name/region consistency, one scoped job, wake signal, simulated claim → running, result → results with provenance, cooldown, three concurrent clicks → one job reusing v3, zero results, history/notes preserved, stale 409, User B 404 on edit/scan/read, reduced motion, 768 and 390 px without horizontal overflow.
- Screenshots: `docs/nl-search-screenshots/` (edit form, saved, queued, running, results, no results, cooldown at 1440; profiles and edit form at 768 and 390).

The worker in these tests is a synthetic test double driven through the real worker API. **This is not a real Muse test.**

## 11. Remaining limitations requiring real Muse verification

1. The live Muse agent/Hook prompt still has the old wording. To use `intent.description` and empty-location handling, an operator must update it from `runPrompt` as a controlled change. Until then Muse runs the generated keywords and ignores `intent`.
2. Whether Muse's `social.search` handles an empty `location` well, and the result quality of generated phrases, needs a real, explicitly approved search.
3. Latency from "queued" to "running" equals how fast the Hook (if enabled) or the scheduled Muse task polls. No Hook is enabled per `WAKE_SIGNAL_POC.md`; without it, a manual scan waits for the next scheduled run and shows "delayed" after 20 minutes.
4. The wake detector requires exactly one active credentialed worker (unchanged).
5. The catalogue in `search-plan.ts` is finite; unusual industries fall back to the description's main idea and are labelled as such.
