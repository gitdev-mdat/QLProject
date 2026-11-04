# Search profiles and lead provenance

Audit and fix for: "Nhu cầu theo dõi" looked empty while "Hôm nay" showed real leads and scans.

## 1. Audit (2026-11-02, live DB `muse_bridge`, read-only queries)

| User | Connection | kind | Config (latest) | Posts | Scans | Jobs |
|---|---|---|---|---|---|---|
| Test User A `502e453f` | `a366abd8` "Muse A" | legacy_agent | v1 TP.HCM · quán cafe sắp khai trương | 9 | 4 (29–30/10) | 0 |
| Test User A | `f206ffd6` "Tìm kiếm của tôi" | search_profile | v1 Miền Nam · 3 keywords · enabled | 1 | 1 (02/11 10:36) | 1 completed |
| Test User B `e9ef48ca` | `e84ffff9` "Muse B" | legacy_agent | v1 Hà Nội | 0 | 0 | 0 |
| Test User B | `6479e12b` "Tìm kiếm của tôi" | search_profile | v1 Hà Nội · 2 keywords · enabled | 0 | 1 (02/11, 0 new) | 1 completed |

Findings:

1. **Root cause.** Both users already had an active search profile in PostgreSQL. `/app/bo-loc` rendered `SearchIntentBuilder`, a client-only form that loaded no data, and its "Bắt đầu theo dõi" button only showed a notice; it never saved. The UI could create (in theory) but never list.
2. **Lead sources.** User A's leads came from **both**: 7 visible leads from the legacy agent (older integration) and 1 from the shared-worker profile (that one has `content` NULL and a title, so it was hidden by the "has text" rule; the rule now accepts the title as the post text).
3. **Provenance chain already exists**, no new tables needed: user → `agent_connections` (search_profile) → `scan_configs` (versioned) → `search_jobs` (configuration_version) → `scan_runs` (configuration_version, search_job_id) → `facebook_posts` (per connection) + `facebook_post_search_configs` (post ↔ config version).
4. **Multiple attribution.** Posts are unique per connection, so the same Facebook URL found by two profiles is two rows. No such duplicates exist today (query returned 0 rows).
5. **Unrecoverable provenance.** All 35 legacy-agent posts in the DB have no `facebook_post_search_configs` row and no post→scan link. They are labelled "Dữ liệu từ lượt quét trước" and never attributed to a request.
6. **Dashboard mixing.** "Hôm nay" mixed legacy and profile scans without saying which was which, and its countdown was computed from `frequency_minutes` only.
7. **Scheduling.** `search_jobs` are created lazily (`enqueueDueJobs`) when a worker claims. Nothing schedules Muse itself; the only worker was last seen 02/11 10:40 (VN). A configured 30-minute frequency therefore does not prove scans will happen.

## 2. Data contract

- Migration `009_search_profile_details.sql` (additive, applied to `muse_bridge` and `muse_bridge_test`): `scan_configs.description` (the customer's own words for that version) and `scan_configs.created_by_user_id`. No existing row changed.
- Create: one `agent_connections` row (kind `search_profile`, no credential) plus `scan_configs` v1. Max 10 active profiles per user. Sources fixed to `social.search`; frequency limited to 30/60/360/1440 minutes.
- Edit, pause and resume each **append** a `scan_configs` version. Posts keep the version that found them. Pausing also cancels the profile's not-yet-claimed job (`status = 'cancelled'`, `last_error = 'paused_by_customer'`); a running scan finishes under its own version.
- The profile name lives on `agent_connections.name` (profile-level label); search terms and area are per version.
- Ownership: every query filters on the session's user id; foreign or unknown profile ids return 404. Same-origin check on POST/PATCH.
- APIs: `POST /api/profiles {profile, enabled}`, `PATCH /api/profiles/:id {action: pause|resume}` or `{profile}`.

Profile state (derived server-side, `web/lib/profile-state.ts`):

| State | Rule | Label |
|---|---|---|
| draft | latest version disabled, never enabled | Bản nháp |
| paused | latest version disabled, was enabled before | Tạm dừng |
| attention | enabled, last scan failed or job blocked | Cần kiểm tra |
| pending_first_scan | enabled, no success yet, enabled < 2× frequency ago | Chờ lượt quét đầu |
| active | enabled, success within 2× frequency | Đang theo dõi |
| delayed | enabled, no success within 2× frequency | Đang chậm |

## 3. UX state matrix (all covered by `web/e2e/profiles-e2e.mts`)

| | Hôm nay | Danh sách lead | Nhu cầu theo dõi | Chi tiết |
|---|---|---|---|---|
| A new account | "QLead chưa biết…" + Tạo nhu cầu | empty | onboarding with 3 steps | – |
| B legacy only | "Chưa có nhu cầu nào đang bật", legacy scan rows | legacy filter | "Chưa có nhu cầu nào đang được theo dõi" + legacy card | legacy label |
| C draft | counted as not monitoring | – | Bản nháp, "Bật theo dõi" | – |
| D first scan pending | listed, estimated slot | – | Chờ lượt quét đầu | – |
| E no matches | listed | 0 rows under filter | "Đã quét nhưng chưa tìm thấy…" | – |
| F leads | listed | source line per row | Xem lead (n) | Được tìm thấy qua |
| G several active | "Đang theo dõi n nhu cầu" | filter select | n cards | – |
| H paused with history | "n tạm dừng hoặc nháp" | leads still listed | Tạm dừng, "Lead cũ vẫn được giữ" | – |
| I delayed | warning, **no countdown** | – | Đang chậm | – |
| J legacy lead | "Lượt quét trước" rows | "Dữ liệu từ lượt quét trước" | legacy card | no request claimed |
| K edited | – | – | "Điều kiện đã được sửa…" | shows conditions at discovery time |
| L shared post | – | one row, "+1 nhu cầu" | counted in both | both sources listed |

Next scan: shown as "Lượt quét dự kiến tiếp theo · khoảng HH:MM · theo lịch mỗi N phút" only while at least one enabled profile is on time. Otherwise the panel says when the last scan arrived and that new leads may be late.

Scan rows show "N bài mới" (rows inserted) and "đã xem M bài" (total_found), plus a note that per-scan counts do not add up to the lead count.

## 4. Verification

- `web/e2e/profiles-e2e.mts` on `muse_bridge_test`: 17/17 (screenshots in `docs/profile-screenshots/`, 1440/768/390).
- `web/e2e/qlead-e2e.mjs` on the live DB, read-only for profiles: 31/31.
- Backend `npm test` on the test DB: 64/64. Type-check and production build pass.

## 5. Not done / handoff

- Real Muse scheduling is outside QLead: until a worker polls on a schedule, profiles will drift to "Đang chậm". Enabling the Muse recurring task is manual (see ADMIN_WORKERS.md).
- Legacy-agent leads stay unattributed; no backfill is possible from stored data.
- Archiving/deleting a profile is not offered (pause covers stopping; history stays).
