# Engagement gate — customer + admin UX (2026-11-11)

Backend contract: `docs/lead-engagement-gate-contract.md` (Codex, PR #26). This branch only words what the server
returns; it never counts reviews or decides eligibility in the browser.

## What the customer sees

| Where | When | What |
|---|---|---|
| /app/bo-loc card | `policyActive && !mayStartNewScan` | Gold panel replaces the scan headline (a held third scan must not read "Tìm thấy N khách hàng mới"): "QLead đang giữ N khách hàng mới cho bạn" (or "Xử lý khách hàng đã nhận để QLead tìm tiếp" when nothing is held), "Xử lý thêm X khách hàng nữa…", progress `reviewed/required`, "Thế nào là đã xử lý?", CTA "Xử lý khách hàng". "Tìm lại ngay" hidden. A running search keeps its stage. |
| /app/bai-viet?nhu-cau= | same | Same panel above the list; the "sẽ gửi tiếp lúc HH:MM" held-back promise is suppressed while held. |
| /app (Today) | same | One compact line per held need with a "Xử lý" link (Thi: Today must stay uncluttered). |
| After a review | server delivered more / reopened | Page refreshes once; "Cảm ơn bạn! QLead đã gửi thêm N khách hàng[ và sẽ tìm tiếp theo lịch]." |
| Tìm lại / Lưu và tìm lại | `usage_gated` | "Hãy xử lý các khách hàng đã nhận trước. QLead sẽ tìm tiếp ngay khi đủ." |

Review counting copy matches the backend: "Xem bài Facebook" or Đã liên hệ / Quan tâm / Không quan tâm / Không phù hợp;
opening the detail ("Đã xem") does not count. The browser re-reads `GET /api/profiles/:id/scan` ~0.9 s after a
source-open (keepalive) or one of those statuses is accepted, and when the tab becomes visible again.

Admin /admin/users detail: per-need line "N lượt tìm từ khi áp dụng · đã xử lý r/d lead (p%, cần k) · đang giữ h" and
pill "Chờ khách xử lý lead" when `searchingPausedByUsagePolicy`. Percent is floored so 79.9% never shows as 80%.

## Files
`web/lib/engagement-gate.ts`, `web/components/engagement-gate.tsx|.css` (new); small hooks in profiles-page.tsx,
lead-results.tsx, dashboard.tsx, admin-users.tsx, lib/admin-users.ts, lib/lead-state.ts, lib/feedback-client.ts,
lib/profile-status.ts, lib/profile-scan.ts. No Codex backend file changed.

## Verification
`web/e2e/engagement-gate-e2e.mts` on DB `muse_bridge_test_gate` (= muse_bridge_test_hot + 026), dev on 3081: **8/8**.
Real `distributeProfileLeads` for 3 scans (20 delivered, 36 held, 0/16), real PATCH statuses and a real
"Xem bài Facebook" click (Facebook answered locally) → 10 released in place, panel moves to 16/24; a need in its first
two scans shows nothing; 390 px without horizontal scroll. Admin view checked by typecheck only (no admin session in E2E).
