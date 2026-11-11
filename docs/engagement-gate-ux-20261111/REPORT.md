# Engagement gate — customer + admin UX (2026-11-11)

Backend contract: `docs/lead-engagement-gate-contract.md` (Codex, PR #26). This branch only words what the server
returns (`GET /api/profiles/:id/scan` → `engagement`, `usage_gated`, admin profile fields). No client-side 80% rule,
no schema/scheduling change, no Codex file edited.

## Audit: where the old UI would mislead under the gate
1. Nhu cầu card, held third scan: stage said "Tìm thấy N khách hàng mới" + "Xem khách hàng mới" although nothing was delivered. → replaced by the progress panel while held.
2. "Tìm lại ngay" / "Lưu và tìm lại": the server returns `usage_gated` and creates no job; the old note was empty. → button hidden while held; note "Khám phá thêm các khách hàng hiện có để QLead tìm lượt tiếp theo."
3. Today scan panel: countdown "Lượt quét dự kiến tiếp theo" and the "đang chậm hơn lịch" note for needs that are not searched. → waiting needs no longer drive the countdown; if all needs wait, the block is hidden and one line per need explains instead.
4. Lead list: "QLead giữ thêm N cơ hội khác và sẽ gửi tiếp từ HH:MM" promised a time that the gate does not honour; plus a second stacked band. → while held only the progress panel shows.
5. Push: `new_leads` is enqueued from the delivered count, so a held scan sends nothing (verified in src/worker-api.ts). Unlock batches send no push either (the customer is in the app and sees the in-page thanks).
6. NOT fixed (Codex query, web/lib/server/leads.ts): scan history "Tìm thấy N lead mới" counts stored source-linked posts, not delivered ones, so a held third scan can still read as N new leads in Lịch sử quét / Today's recent rows. Needs a delivered-based count from the backend.
7. NOT available: a per-lead "reviewed" flag. "Xem khách hàng chưa xem" therefore opens the need's "Chưa xem" tab (falls back to all when none are unread); an exact "chưa khám phá" view needs `reviewed` per lead in GET /api/leads.

## Customer experience
- Wording: a counted review is "khám phá" (the status "Đã xem" does not count, so the two words are kept apart). No "khóa / không đủ điều kiện / bắt buộc".
- Card + list panel (calm emerald, one bar with an 80% tick): title "QLead đã lưu thêm cơ hội cho bạn" only when `pendingCount > 0` (chip "N cơ hội đang chờ gửi", no lead details), otherwise "Khám phá thêm cơ hội đang có nhé!"; "Bạn đã khám phá r/d khách hàng. Khám phá thêm X khách hàng để nhận lượt tiếp theo."; "p% / mục tiêu 80%" (floored); disclosure "Thế nào là khám phá?"; card CTA "Xem khách hàng chưa xem" → `/app/bai-viet?nhu-cau=<id>&chua-xem=1`.
- Card pill precedence: own pause/draft → Admin hold ("Đang bật", grey) → "Có cơ hội đang chờ" / "Chờ bạn khám phá thêm" → "Đang theo dõi". Overnight copy stays on the status line for searching needs.
- First two scans, zero leads, paused, suspended: nothing new is shown.
- Release: after a source open or a counted status, the page re-reads progress (~0.9 s, keepalive lands first) and on tab focus. If the server delivered more / reopened, the list refreshes in place and one dismissible line shows the real number: "Cảm ơn bạn đã khám phá thêm! QLead đã gửi thêm N khách hàng cho bạn." (or "Bạn đã khám phá đủ cơ hội để nhận lượt mới!" when searching reopens). Goat hops twice, not with reduced motion; in-memory only, so refresh/navigation never replays. After a batch the cohort grows (16/20 → 16/30) and the panel simply follows the server.

## Admin
Customer detail gets a "Mức khám phá lead" block: Lead toàn thời gian · Đã giao theo chính sách · Đã khám phá (p%) · Đang chờ gửi, plus a sentence: how many needs wait, that only leads after each need's policy baseline count (old leads stay visible), what "khám phá" means, and that this is usage, not lead quality. Each need line adds "N lượt tìm từ khi áp dụng · đã khám phá r/d lead (p%, cần k) · chờ gửi h"; pill "Chờ khách khám phá". The customer table is unchanged. The exact baseline timestamp is not in the admin API (only `policyActive`).

## Verification
`web/e2e/engagement-gate-e2e.mts` on DB `muse_bridge_test_gate` (muse_bridge_test_hot + 026) against a **production build** (`next build --webpack` + `next start`, port 3081): **14/14**. Covers 1440/768/390 (no horizontal scroll), usage_gated without a job, Today line without countdown, CTA lands on the right need + unread tab and survives refresh, statuses count / "seen" does not, the same Facebook source twice counts once (server 15), reaching 16/20 releases the real batch in place with the real number and no replay after refresh, first-two-scans and zero-lead needs show nothing, two needs keep independent progress, pause and suspension win, keyboard + progressbar name, admin block equals the admin API. `tsc --noEmit` 0. Not covered by automation: quiet-hours combination (time-dependent; precedence by code review).

Performance: no server-side work added to page renders. The card/list add one `GET /api/profiles/:id/scan` after hydration; Today adds one per enabled need (≤10), all off the critical path.
