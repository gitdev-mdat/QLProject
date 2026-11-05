# QLead — Điều hướng toàn ứng dụng: nguyên nhân, thay đổi, số đo trước/sau

Ngày: 2026-11-05 · Nhánh: `perf/instant-app-navigation` (từ `origin/main` 9a2746b)

## 1. Nguyên nhân gốc (đã đo)

**Function của Vercel chạy ở `iad1` (Washington, Mỹ), còn Supabase ở `ap-northeast-1` (Tokyo).** Header `x-vercel-id` của production: `sin1::iad1::…` (edge Singapore → function Mỹ).

Đo từ máy ở VN tới https://qlead.vercel.app (8 lần mỗi loại, warm):

| Request | Thời gian | Ý nghĩa |
|---|---|---|
| File tĩnh ở edge (`/brand/qlead-goat.svg`) | ~85 ms | VN ↔ edge sin1 |
| `/app` khi chưa đăng nhập (function, **không** truy vấn DB) | ~310 ms | + ~225 ms đi vòng sang iad1 |
| `/health` (function + **1** truy vấn `SELECT 1`) | ~435 ms | + ~125 ms **cho mỗi lượt truy vấn DB** iad1 ↔ Tokyo |

Mỗi trang /app cần 3–5 lượt truy vấn **nối tiếp** (session → dữ liệu trang → workflow…), nên chỉ riêng khoảng cách đã là 0,6–1 s; cộng kết nối pool mới (TLS tới pooler) và cold start là 1–2 s như chủ sản phẩm cảm nhận. Đây là vấn đề **toàn cục**: mọi route có dữ liệu đều chịu.

Vấn đề thứ hai làm nó *cảm giác* tệ hơn: **không có phản hồi nào cho tới khi dữ liệu về**.
- `AppShell` nằm trong từng page → mỗi lần chuyển trang, sidebar/bottom nav bị unmount rồi mount lại (đo: 33/33 lượt chuyển trong /app đều remount shell).
- Không có `loading.tsx` → với route dynamic, Next.js **không prefetch gì** và router giữ nguyên trang cũ cho tới khi RSC payload đầy đủ về. Mục nav đang chọn, URL, nội dung đều đổi cùng lúc ở cuối (feedback = content, 300–1460 ms).
- `getSession()` chạy 2 lần mỗi request (layout + page), không dedupe.

Back/forward vốn đã nhanh (router cache, 10–80 ms) — không phải nguồn chậm.

## 2. Thay đổi (frontend + cấu hình deploy, không đụng SQL/Muse)

| File | Thay đổi |
|---|---|
| `web/vercel.json` | `"regions": ["hnd1"]` — function chạy ở Tokyo, cạnh Supabase. Hiệu lực ở lần deploy tới. |
| `web/app/app/layout.tsx` | Render `<AppFrame>` (shell cố định) trong layout. Auth, onboarding redirect, SessionProvider giữ nguyên. |
| `web/components/app-shell.tsx` | `AppFrame`: sidebar, top bar, banner, bottom nav luôn mounted; mục active lấy từ URL và **đổi ngay lúc bấm** (trước khi server trả lời). `AppShell` cũ trong các page thành passthrough khi đã có frame → không phải sửa từng page. |
| `web/lib/server/session.ts` | `getSession` bọc `React.cache()` — dedupe **trong một request**, không chia sẻ giữa request/người dùng. Mỗi page vẫn tự gọi `requireSession()`. |
| `web/app/app/loading.tsx`, `web/app/app/bai-viet/loading.tsx`, `web/app/admin/loading.tsx` | Loading boundary cho mọi route /app và /admin → Next prefetch được phần layout + khung loading, chuyển trang hiện ngay. |
| `web/components/route-loading.tsx` + `.css` | Khung tải nhẹ: tiêu đề thật của trang đích + vài thanh xám theo bố cục. **Ẩn 150 ms đầu** nên trang nhanh không bị nháy skeleton. Không spinner, không %, không animation thêm. |
| `web/e2e/nav-perf*.mts`, `nav-qa.mts`, `latency-proxy.mjs` | Công cụ đo và test hồi quy (DB cô lập `muse_bridge_test_nav`). |

Không thêm dependency, không cache dữ liệu người dùng, không tắt prefetch, không đổi Muse/scan.

Lưu ý hành vi: trang lead không tồn tại / không thuộc tài khoản vẫn hiện "Không tìm thấy lead" trong shell, nhưng vì trang được stream sau loading boundary nên HTTP status là 200 kèm `noindex` thay vì 404 (khu vực đã đăng nhập, không ảnh hưởng SEO). `/admin/*` và `/app/admin` với khách hàng vẫn trả 404 thật.

## 3. Cách đo

Bản build production thật (`next build --webpack` + `next start`), Chrome headless (Playwright), tài khoản seed 260 lead. Đo trong trang, tính từ `pointerdown`:
- **feedback**: lần đầu có thay đổi nhìn thấy (mục nav thành active hoặc `<main>` đổi),
- **content**: URL đích + `h1` của trang đích hiện + không còn khung tải.

Mô phỏng production: proxy TCP thêm **125 ms RTT** giữa server và Postgres (đúng số đo iad1↔Tokyo ở trên) + Chrome thêm **225 ms** độ trễ mạng (VN↔iad1). Mô hình hnd1: DB trực tiếp (cùng vùng) + **150 ms** độ trễ trình duyệt (VN↔Tokyo, ước lượng thận trọng). 3 vòng × 14 lượt chuyển (vòng 1 = cold, vòng 2–3 = warm), 1440 px. Số thô: `before-iad1.json`, `after-code-iad1.json`, `after-hnd1.json`.

## 4. Kết quả trước / sau

### Tổng hợp (ms)

| | Trước (code cũ, iad1) | Sau — chỉ code (vẫn iad1) | Sau — code + hnd1 |
|---|---|---|---|
| Phản hồi nhìn thấy, trung vị | **549** cold / **315** warm | **6** / **7** | **5** / **8** |
| Phản hồi nhìn thấy, P95 | 1380 | 33 | 32 |
| Nội dung sẵn sàng, trung vị | 534 | 520 | **329** |
| Nội dung sẵn sàng, P95 | 1380 | 1329 | **438** |
| Shell bị remount | 33/33 | **0** | **0** |
| Reload toàn trang | 0 | 0 | 0 |

Đọc kết quả: phần code làm phản hồi gần như tức thì (≤ 33 ms P95) nhưng **không** rút ngắn thời gian dữ liệu — đúng như mong đợi, vì thời gian đó là server/DB. Chuyển region mới là thứ cắt thời gian nội dung (~1,4 s → ~0,44 s P95). Cần cả hai.

### Theo route (nội dung sẵn sàng, ms, vòng 1 / 2 / 3)

| Lượt chuyển | Trước (iad1) | Sau (code + hnd1) |
|---|---|---|
| Hôm nay → Danh sách lead | 948 / 687 / 662 | 452 / 329 / 347 |
| Danh sách lead → Hôm nay | 714 / 715 / 709 | 333 / 328 / 327 |
| Hôm nay → Nhu cầu theo dõi | 690 / 421 / 534 | 428 / 339 / 335 |
| Nhu cầu → Đề xuất nhóm | 533 / 305 / 302 | 345 / 322 / 328 |
| Danh sách → Chi tiết lead | 737 / 451 / 447 | 337 / 179 / 190 |
| Danh sách → Lịch sử quét | 1426 / 1117 / 1380 | 648 / 438 / 407 |
| Admin: Khách hàng → Kết nối Muse | 1462 / 1161 / 1137 | 399 / 323 / 332 |
| Back / forward | 10–70 | 9–110 |

Mục tiêu: phản hồi < 100 ms — **đạt** (đo được). Nội dung < 500 ms warm và P95 < 1 s — **đạt trong mô hình hnd1**; con số production thật cần xác nhận sau deploy (mục 8).

## 5. QA trình duyệt (`web/e2e/nav-qa.mts`) — 17/17 PASS

- 390 / 768 / 1440 px: mọi mục nav chính, shell không remount, nav không xê dịch, không cuộn ngang.
- Mạng chậm (900 ms/req): mục active đổi trong 60 ms, khung tải hiện, rồi nội dung.
- Bấm liên tục 5 mục: dừng đúng trang cuối, đúng 1 mục active, không nội dung cũ.
- Danh sách → chi tiết → back → forward (390 px).
- Refresh ở route sâu; bàn phím Tab + Enter (focus giữ trên link).
- Tài khoản rỗng: mọi route có empty state; không lộ lead của tài khoản khác; mở lead của người khác → "Không tìm thấy lead".
- Hai tab độc lập; khách hàng vào /admin → 404, không thấy nút Quản trị; admin đi /app → Quản trị → các trang admin, top bar admin giữ nguyên.
- Session hết hạn giữa chừng → lần bấm tiếp theo về /dang-nhap.
- Không lỗi console / hydration trong cả vòng.
- GOAT: không đổi component mascot; trang Hôm nay / lần tìm đầu vẫn render bên trong frame.

Ảnh: `docs/nav-perf-20261105/screenshots/` (không commit vì `docs/**/*.png` bị gitignore).

## 6. Việc cho Codex (backend/SQL — mình không sửa)

1. **Phân trang danh sách lead**: trang list và Hôm nay đều tải `listLeadsForUser(…, 200)` rồi lọc ở client. Với tài khoản > 200 lead, bộ lọc/sắp xếp chỉ áp dụng trên 200 bài mới nhất. Cần contract server-side (cursor + filter status/nhu cầu/thời gian/tìm kiếm + tổng số) để frontend chuyển sang mà không tự làm thuật toán phân trang thứ hai.
2. **Truy vấn nối tiếp có thể gộp**: Hôm nay chạy `getWorkflowForUser` *sau* 6 truy vấn song song (cần id lead) → thêm 1 lượt; trộn workflow vào truy vấn lead sẽ bớt 1 RTT. `getFirstScanForUser` / `listProfilesForUser` nên kiểm tra số truy vấn nối tiếp bên trong.
3. **Lịch sử quét** là route chậm nhất (≈ 2× route khác): `listScanHistoryPage` + index `scan_runs(agent_connection_id, scanned_at DESC)` đã đề xuất từ trước.
4. **`/admin/workers`** chậm thứ hai (nhiều truy vấn tổng quan).
5. Pool: `poolMax(5)` mỗi instance, Hôm nay mở 6 truy vấn song song → 1 truy vấn chờ kết nối; cân nhắc `DATABASE_POOL_MAX` trên Vercel sau khi đổi region.

## 7. Production readiness

- Build production pass; 17/17 QA; đo trước/sau như trên. Chưa deploy.
- Rủi ro chính: đổi region function (thay đổi hạ tầng). Hobby plan cho phép 1 region; `hnd1` cùng vùng với pooler Supabase `aws-0-ap-northeast-1`. Worker route của Muse (`/api/worker/*`, `/api/public/*`) cũng chạy ở hnd1 — chỉ nhanh hơn với DB, không đổi URL.
- Rollback: xoá dòng `regions` hoặc promote deployment cũ trên Vercel.

## 8. Xác minh sau deploy (cần Thi duyệt deploy)

1. `x-vercel-id` của `/health` phải có `::hnd1::`.
2. `/health` từ VN: kỳ vọng ~150–200 ms (hiện ~435 ms).
3. Chạy `web/e2e/production-smoke.mjs`.
4. Đăng nhập thật và bấm qua các mục nav; nếu Thi đăng nhập trong browser pane, mình chạy lại `nav-perf.mts` trên production để có số thật.
