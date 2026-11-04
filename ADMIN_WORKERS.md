# QLead Admin: quản lý Muse worker và chuyển đổi không tốn quota dự phòng

Ngày: 2026-11-02. Phạm vi: phát triển dựa trên kiến trúc worker dùng chung đã có (SHARED_WORKERS.md, REAL_WORKER_POC.md), không viết lại.

## 1. Audit hiện trạng

| Thành phần | Đã có | Bổ sung lần này |
|---|---|---|
| Danh tính worker, credential dạng hash, trạng thái active/draining/paused/unavailable | `muse_workers` (006) | Thêm cột bằng chứng: `status_changed_at`, `connection_verified_at`, `last_claim_at` |
| Hàng đợi job, lease, retry, release, idempotency, từ chối kết quả cũ | `src/jobs.ts`, `src/worker-api.ts` | Không đổi logic |
| Lịch sử gán job | `search_job_attempts` | Không đổi |
| Bản ghi một lượt chuyển đổi | Chưa có | Bảng `worker_handoffs` (007) |
| Quản trị | Chỉ có CLI | Trang `/admin/workers` và các route `/api/admin/*` |
| Quyền admin trên web | Chưa có (web chỉ có session của khách) | Danh sách user admin `QLEAD_ADMIN_USER_IDS`, kiểm tra ở server cho từng page và API |

Muse: repo không có tài liệu nào về API của Muse để tạo connector, bật/tắt lịch hay kích hoạt task, và mình không tự tạo ra một API như vậy. Vì thế việc kết nối, bật lịch hay tắt lịch đều là **thao tác thủ công trong Muse**, có prompt và hướng dẫn soạn sẵn. Trạng thái `active` trong QLead chỉ có nghĩa worker *được phép* nhận việc, chứ không tự làm Muse chạy.

## 2. State machine

Worker (giữ nguyên, có thêm trạng thái hiển thị):
- **ACTIVE**: được nhận việc mới.
- **DRAINING**: không nhận việc mới, nhưng vẫn được nộp kết quả cho job đang giữ.
- **PAUSED**: không nhận việc. Hiển thị **READY** (dự phòng sẵn sàng) khi credential còn hiệu lực và đã có lần xác minh kết nối.
- **UNAVAILABLE**: không nhận việc. Thường dùng khi chuyển khẩn cấp; job của worker này được trả về hàng chờ.
- **CONNECTED**: đã từng gọi `GET /api/worker/status` thành công. Đây là **dữ liệu cũ**, không chứng minh Muse đang trực tuyến.

Lượt chuyển đổi (`worker_handoffs.status`). Một dịch vụ duy nhất (`src/handoff.ts`) dùng cho cả hai chiều 01→02 và 02→01:

```
preparing ──drain──▶ draining ──cutover──▶ awaiting_worker_start ──(Muse mới gọi QLead)──▶ verifying ──(job đầu tiên xong)──▶ completed
    │                    │                          │                                       │
    └──cancel──▶ cancelled (nguồn được active lại)   └──────────── fail ─────────▶ failed ◀───┘   (không tự đổi worker)
```

- `preparing`: chụp lại bản tóm tắt hiện trạng. Chưa đổi gì.
- `draining`: nguồn chuyển sang DRAINING.
- `cutover` có hai chế độ:
  - **Bình thường**: QLead *từ chối* nếu nguồn còn lease chưa hết hạn, để không bỏ dở việc hợp lệ.
  - **Khẩn cấp**: nguồn → UNAVAILABLE, job của nguồn được trả về hàng chờ, kết quả nộp muộn từ nguồn bị `409 lease_lost`.

  Sau cutover: đích → ACTIVE, tạo job cho lượt hiện tại, chặn các job mà đích không có quyền nguồn.
- `awaiting_worker_start` → `verifying` → `completed`: chỉ chuyển khi có **bằng chứng thật** trong DB:
  - Muse mới gọi QLead sau thời điểm cutover → `verifying`.
  - Có attempt `completed` → `completed`.
- "Xác nhận hoàn tất (không có việc)": chỉ được phép khi đích đã gọi claim sau cutover và hàng chờ thật sự trống.
- `failed`: admin ghi nhận Muse mới không khởi động được. Cách khôi phục là tạo một lượt chuyển mới bằng cùng dịch vụ đó.
- Tại mọi thời điểm chỉ có tối đa 1 lượt mở (unique index). Mọi chuyển trạng thái chạy trong transaction và được ghi vào `events`.

## 3. Trang Admin `/admin/workers`

- **Danh sách tài khoản**: tên, trạng thái (tiếng Việt), kết nối kèm cảnh báo "không chứng minh đang trực tuyến", liên hệ gần nhất, job thành công gần nhất, đang xử lý, đã hoàn tất, thời gian trung bình (từ lúc nhận tới lúc nộp), lỗi trong 24 giờ, nguồn được phép, lỗi gần đây.
  - Có cảnh báo khi một tài khoản đang PAUSED/UNAVAILABLE mà vẫn gọi claim (khả năng cao là lịch Muse chưa tắt và đang tốn quota).
  - Không hiển thị quota còn lại, vì không có nguồn số liệu được hỗ trợ.
- **Thao tác**:
  - Thêm tài khoản (bắt đầu ở PAUSED, credential chỉ hiện một lần).
  - Hướng dẫn kết nối.
  - Tạm dừng.
  - Kích hoạt (chỉ khi chưa có tài khoản nào khác đang hoạt động).
  - Đánh dấu không khả dụng (kèm trả job về hàng chờ).
  - Tạo lại credential.
  - Chuẩn bị chuyển đổi.
- **Luồng chuyển đổi**: chọn nguồn → chọn đích → "Xem lại công việc" (bản tóm tắt chỉ đọc) → xác nhận → Ngừng nhận việc → Chuyển (bình thường hoặc khẩn cấp, mỗi bước có hộp thoại xác nhận ghi số job thật) → "Chờ Muse mới bắt đầu" (kèm prompt, các bước bật lịch Muse mới và tắt lịch Muse cũ) → Kiểm tra → Hoàn tất.
  - Trạng thái lưu trong PostgreSQL, nên tải lại trang không làm mất tiến trình. Trang tự cập nhật mỗi 10 giây khi đang có lượt mở.
- **Công việc cần tiếp tục**: số job đang chờ, đang xử lý, cần chạy lại, bị chặn hoặc cần cấp lại quyền, thất bại trong 24 giờ, số nhu cầu đang bật, và số nhu cầu đang bị gián đoạn theo dõi.
- **Lịch sử chuyển đổi**: 10 lượt gần nhất.
- **Phân quyền ở server**:
  - Trang trả 404 cho user không phải admin.
  - API trả 401 khi chưa đăng nhập, 404 khi không phải admin, 403 khi thiếu Origin cùng nguồn hoặc thiếu header `x-qlead-admin` (chống CSRF).

## 4. Kết nối Muse một lần

1. Admin bấm "Thêm tài khoản Muse": QLead tạo worker ở PAUSED và hiện credential **một lần** trong hộp thoại (response gắn `no-store`, không ghi log).
2. Trong Muse, tạo Custom Connector **"QLead Worker"** với base URL `QLEAD_WORKER_PUBLIC_URL`, rồi dán credential vào Secure Credentials Store.
3. Dán **prompt kiểm tra kết nối**. Muse gửi đúng một request `GET /api/worker/status`: không claim, không tìm Facebook, không tạo lịch.
4. QLead ghi lại `connection_verified_at` và thẻ chuyển sang "Tài khoản dự phòng · sẵn sàng". Worker vẫn ở PAUSED.
5. Lưu sẵn **prompt một chu kỳ làm việc** trong Muse, nhưng **không bật lịch**.

Không prompt nào chứa credential. Nếu credential bị lộ: bấm "Tạo lại credential" (credential cũ hết hiệu lực ngay, kết nối phải xác minh lại).

## 5. Không tốn quota khi dự phòng

- QLead không bao giờ gọi Muse. Không có heartbeat, không có polling, không có claim rỗng.
- Tài khoản dự phòng không có lịch chạy trong Muse. Mức sẵn sàng được đánh giá dựa trên lần xác minh trước đó.
- Nếu tài khoản dự phòng vẫn gọi claim, nó nhận 0 job và trang Admin hiện cảnh báo, vì nhiều khả năng lịch Muse chưa được tắt.
- Đã kiểm bằng test: trong lúc Muse 01 làm việc, `last_seen_at` và `last_claim_at` của Muse 02 không đổi.

## 6. Quy trình chuyển lúc nửa đêm (Asia/Ho_Chi_Minh)

1. **23:30, chuẩn bị**: mở `/admin/workers`, chọn Muse 01 → Muse 02, bấm "Xem lại công việc".
   - Kiểm tra: credential còn hiệu lực, lần xác minh kết nối, quyền nguồn, số job đang xử lý, đang chờ, cần chạy lại, bị chặn, việc chờ lâu nhất, các nhu cầu bị ảnh hưởng.
   - Bấm "Tạo bản chuẩn bị".
2. **Khoảng 23:45, ngừng nhận việc**: bấm "Ngừng nhận việc ở Muse 01". Muse 01 vẫn được nộp các job đang giữ.
3. **00:00, chuyển**:
   - Nếu không còn job đang xử lý: bấm "Chuyển sang tài khoản mới".
   - Nếu Muse 01 còn giữ job mà bạn không muốn chờ (lease kéo dài tới 45 phút): bấm "Chuyển khẩn cấp".
4. **Bật Muse 02**: bật lịch 30 phút cho tác vụ dùng prompt một chu kỳ làm việc rồi bấm chạy ngay. Trong Muse 01, tắt lịch nhưng giữ connector.
5. **Kiểm tra**: trang hiện "Chờ Muse mới bắt đầu" cho tới khi Muse 02 gọi QLead, sau đó "Đang kiểm tra Muse mới", rồi "Chuyển đổi hoàn tất" khi job đầu tiên xong.
   - Nếu Muse 02 không gọi: trang cảnh báo sau 15 phút, và bạn bấm "Muse mới không khởi động được".

**Chưa thể chuyển hoàn toàn tự động lúc nửa đêm**: phía QLead chuyển được trong một transaction, nhưng việc bật hay tắt lịch Muse là thao tác thủ công.

## 7–8. Job đang chờ, job bị ngắt, và cách Muse mới nhận việc

- Mọi trạng thái nằm trong PostgreSQL: nhu cầu theo dõi, phiên bản config, job, attempt, scan, post, trạng thái lead, khóa dedup.
- Muse mới **không** nhận lịch sử chat hay bộ nhớ. Nó chỉ gọi `POST /api/worker/jobs/claim` và nhận payload do server tạo cho từng job (keywords, location, sources, scan_id); payload không có thông tin khách hàng.
- `GET /api/worker/status` cho worker biết đúng phần ngữ cảnh nó cần: trạng thái của nó, số job nhận được ngay, số job cần chạy lại, việc chờ lâu nhất, và vai trò trong lượt chuyển đổi.
- Job Muse 01 đã tìm dở nhưng chưa nộp **không thể tiếp tục từ giữa chừng**. Job đó giữ nguyên `job_id` và `scan_id`, attempt cũ được đánh dấu released/expired, và Muse 02 chạy lại thành attempt mới. Việc lưu kết quả là idempotent nên không có kết quả trùng.
- Lượt 30 phút bị lỡ **không được chạy bù**. Mỗi nhu cầu giữ tối đa một job mở, nên job quá hạn được giữ lại và chạy khi có worker. Trong lúc không có worker, trang ghi rõ "gián đoạn theo dõi".

## 9. Chuyển về Muse 01

Sau khi nâng cấp Muse 01, chọn Muse 02 → Muse 01 trong cùng màn hình và đi qua đúng các bước trên. Không có code riêng cho chiều về. QLead không tự xoay tài khoản để né giới hạn của nhà cung cấp.

## 10. Giới hạn thật của Muse

- Không có API được tài liệu hóa để tạo connector, bật/tắt lịch hay kích hoạt task.
- QLead không đọc được quota hay credit.
- Kết nối "đã xác minh" chỉ là bằng chứng trong quá khứ.
- Điều khoản cho phép dùng chung tài khoản cho nhiều khách trả phí vẫn chưa được xác minh (xem SHARED_WORKERS.md §12).

## 11–12. File thay đổi và migration

- `migrations/007_worker_handoffs.sql` (chỉ thêm; DB thật được backup bằng `pg_dump` trước khi áp dụng).
- `src/handoff.ts` (mới): dịch vụ chuyển đổi dùng chung.
- `src/worker-api.ts`: status ghi lại lần xác minh và trả về ngữ cảnh vận hành; claim ghi `last_claim_at`.
- `src/cli.ts`: thêm 007 vào danh sách migrate; `worker-set` và `revoke-worker` cập nhật `status_changed_at`.
- `test/handoff.test.ts` (mới); `package.json`: chạy test tuần tự (`--test-concurrency=1`), vì các test dùng chung một database.
- Web:
  - `app/admin/layout.tsx`, `page.tsx`, `admin.css`, `workers/page.tsx`
  - `app/api/admin/workers/route.ts`, `workers/[id]/route.ts`, `handoffs/route.ts`, `handoffs/preview/route.ts`, `handoffs/[id]/route.ts`
  - `components/admin-workers.tsx`, `lib/admin-prompts.ts`, `lib/server/admin.ts`, `e2e/admin-workers-e2e.mts`
  - `next.config.ts`: `experimental.extensionAlias`, để web import được các module backend dùng đuôi `.js`
  - `.env.example`
- Không sửa giao diện của khách, crawler, metadata enrichment hay lịch Muse cũ.

## 13. Kết quả build và test

- Database test riêng: `muse_bridge_test` (cùng container, không đụng DB thật).
  - Backend: `DATABASE_URL=…/muse_bridge_test npm test` cho **56/56 pass** (14 test chuyển đổi mới, cộng các test shared-worker trước đây đã bị bỏ qua trên DB thật).
- Web: `npm run build` (QLEAD_DIST_DIR=.next-verify) **pass**; `tsc` không có lỗi trong code mới.
- E2E trình duyệt (Chrome headless, worker giả lập qua Fastify worker API thật): **25/25 pass**, bao gồm các kịch bản 1–18 trong yêu cầu, thêm kiểm tra credential chỉ hiện một lần và không có lỗi console. Kết quả lưu ở `docs/admin-screenshots/results.json`.

## 14. Ảnh chụp

`docs/admin-screenshots/`:
- `admin-overview-1440`, `admin-prepare-modal-1440`, `admin-awaiting-1440`, `admin-failed-history-1440`
- `admin-workers-{390,768,1440}`, `admin-modal-{390,768,1440}`

Không có ảnh nào chứa credential.

## 15. Việc thủ công còn lại cho một lần chuyển thật 01 → 02

1. **Cấp quyền admin** (chưa làm, vì cần bạn tạo user và chỉnh file env trên máy):
   - `docker exec muse-local-bridge-postgres-1 psql -U muse -d muse_bridge -At -c "INSERT INTO users(display_name) VALUES ('QLead Admin') RETURNING id"`
   - Trong `web/.env.development.local`:
     - thêm `,admin:QLead Admin:<ID>` vào cuối `DEV_QUICK_LOGIN_USERS`
     - thêm `QLEAD_ADMIN_USER_IDS=<ID>`
     - thêm `QLEAD_WORKER_PUBLIC_URL=https://thrill-snowdrop-primer.ngrok-free.dev`
2. Khởi động lại web để nạp code và env mới: port 3000 đang chạy bản build cũ.
3. Đăng nhập "QLead Admin" → `/admin/workers` → "Thêm tài khoản Muse" cho Muse 02 → làm các bước kết nối ở §4 trong tài khoản Muse 02.
4. Worker 01 thật (`b7e3c6be…`) chưa có `connection_verified_at` vì lần gọi status trước đó xảy ra trước migration 007. Chạy prompt kiểm tra kết nối một lần trong Muse 01 nếu muốn thẻ hiện "đã xác minh".
5. Lúc chuyển thật: làm theo §6. Đổi credential của Worker 01 (đã lộ trong chat) bằng "Tạo lại credential" rồi cập nhật lại trong Muse 01.
