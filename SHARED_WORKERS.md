# QLead: Muse worker dùng chung (audit + POC backend)

Ngày: 2026-11-01. Phạm vi: backend Fastify + PostgreSQL. Không đổi web, không đổi Muse schedule, không reset/reseed DB.

## 1. Verdict

**PARTIALLY_SUPPORTED.**

| Phần | Verdict | Căn cứ |
|---|---|---|
| Backend multi-tenant với worker dùng chung | SUPPORTED | Đã làm và test (mục 6, 7, 10). |
| Muse chạy 2 job độc lập trong một lần chạy | UNVERIFIED | Repo chỉ có 2 lần scan thật, đều từ Muse A, mỗi lần một config. Chưa có bằng chứng Muse chạy nhiều lệnh tìm theo danh sách từ API. |
| Gọi Muse theo lập trình (push/trigger) | UNVERIFIED, coi như KHÔNG | Repo không có Muse API nào. Mô hình duy nhất đã thấy: Muse tự chạy theo lịch hoặc theo prompt, rồi gọi HTTP tới QLead. POC vì vậy dùng mô hình **Muse kéo job (polling)**. |
| Dùng một tài khoản Muse phục vụ nhiều khách trả phí | UNVERIFIED, có thể là BLOCKER | Mình không tìm thấy điều khoản của nhà cung cấp Muse trong repo và không thể tự xác nhận. Cần xác nhận bằng văn bản trước khi bán. |
| Quyền Facebook khi đổi worker | Cố ý không giả định | Tài khoản Muse mới **không** kế thừa kết nối Facebook, nhóm đã tham gia hay bộ nhớ chat của tài khoản cũ. POC xử lý bằng `authorized_sources` cho từng worker cùng trạng thái `blocked` và `needs_reauthorization`. |

## 2. Audit hiện trạng (trả lời 10 câu hỏi)

1. **Dùng lại được:** pipeline lưu post (chuẩn hóa URL, dedup, chỉ điền metadata còn trống, liên kết config) đã được tách sang `src/ingest.ts` và dùng chung cho cả hai luồng; `scan_configs` có version; `scan_runs`; transaction; CLI admin; cách xác thực bằng hash token.
2. **agent_connections đang trộn hai danh tính:** đúng vậy. Một dòng vừa là "kênh dữ liệu của khách" (`user_id` sở hữu post, config, scan) vừa là "credential của một tài khoản Muse". Đổi Muse thì phải đổi credential trên chính dòng sở hữu dữ liệu.
3. **Config được đọc** qua `GET /api/agent/config`: bản mới nhất theo `agent_connection_id` của token.
4. **Scan được ghi** qua `POST /api/agent/results`, idempotent theo `(agent_connection_id, scan_id)`, và `scan_id` do Muse tự đặt.
5. **Phạm vi kết quả:** `facebook_posts.agent_connection_id`; web lọc theo `agent_connections.user_id` (`web/lib/server/leads.ts`).
6. **Dedup:** `UNIQUE (agent_connection_id, normalized_url)`, nên cùng một URL được lưu riêng cho từng khách.
7. **Nhiều job trong một lần chạy:** chưa xác minh (xem mục 1).
8. **Trigger theo lập trình:** không có bằng chứng. Chỉ thấy lịch hoặc prompt phía Muse.
9. **Điều khoản thương mại:** chưa xác minh.
10. **Quyền Facebook:** gắn với từng tài khoản Muse. Thay worker có thể làm thay đổi phạm vi nguồn mà worker nhìn thấy.

Bằng chứng về Muse thật trong DB: `scan-20261029-151835` (`total_found` 38, Muse chỉ gửi 5 post) và `scan-20261030-114408` (5 post). DB không lưu thời gian thực thi, nên **chưa đo được thời lượng một job**.

## 3. Mô hình dữ liệu

```
users (khách QLead) 1──n agent_connections(kind='search_profile')   ← "Search Profile", KHÔNG có credential
                                   │ 1──n scan_configs (version)
                                   │ 1──n search_jobs ──n── search_job_attempts n──1 muse_workers
                                   │ 1──n scan_runs (+ search_job_id, executed_by_worker_id: chỉ admin xem)
                                   │ 1──n facebook_posts ── lead_states / lead_notes (theo user)
users 1──n agent_connections(kind='legacy_agent')   ← Agent A/B cũ, giữ nguyên credential và luồng /api/agent/*
```

Vì sao tái dùng `agent_connections` làm Search Profile: mọi bảng dữ liệu khách (`facebook_posts`, `scan_runs`, `facebook_post_search_configs`) và mọi truy vấn web đều đã khóa theo `agent_connection_id` → `user_id`. Dùng lại khóa này cho phép kết quả từ worker dùng chung **hiện ngay trong web mà không sửa file web nào**, đồng thời không phải viết lại ownership của dữ liệu cũ. Đổi lại, tên bảng không còn khớp nghĩa. Nếu muốn có bảng `search_profiles` riêng thì làm sau, bằng một migration có kế hoạch.

Muse worker là tài nguyên thực thi: không có `user_id` và không sở hữu dữ liệu nào. Thay worker chỉ đổi người chạy các job **tương lai**.

## 4. Thay đổi DB: `migrations/006_shared_workers.sql` (forward-only, đã áp dụng)

- `agent_connections.kind` (`legacy_agent` mặc định cho mọi dòng cũ, hoặc `search_profile`). `credential_hash` được bỏ NOT NULL, kèm CHECK: legacy bắt buộc có hash, profile bắt buộc không có.
- `muse_workers`: status `active | draining | paused | unavailable`, `credential_status`, `authorized_sources`, `max_jobs_per_claim` (1–10), `lease_minutes`, `last_seen_at`, `last_success_at`.
- `search_jobs`: một job cho mỗi profile mỗi slot lịch; `scan_id` do server cấp; lease; attempts; backoff qua `available_at`. Mỗi profile có tối đa 1 job mở (unique index một phần), nên khi thiếu năng lực thì lịch quét **trễ đi** chứ không dồn job trùng.
- `search_job_attempts`: lịch sử gán job (worker nào, lần thứ mấy, kết quả `completed/failed/needs_reauthorization/expired/released`, lỗi).
- `scan_runs.search_job_id` (unique) và `scan_runs.executed_by_worker_id`: cột mới, cho phép null.

Bằng chứng giữ dữ liệu cũ: backup `pg_dump` được chụp trước khi migrate. Checksum MD5 của `agent_connections` (id, user_id, name, credential_hash, status), `scan_runs` (các cột cũ), `facebook_posts` và `lead_states` **trùng khớp trước và sau** migrate cộng toàn bộ test. Toàn bộ 14 agent_connections hiện có đều là `legacy_agent`, và không còn dữ liệu test sót lại.

## 5. API cho worker (`src/worker-api.ts`, `src/jobs.ts`)

Header `Authorization: Bearer <WORKER_CREDENTIAL>`. Token worker không mở được `/api/agent/*` và token agent cũ không mở được `/api/worker/*`.

| Endpoint | Việc |
|---|---|
| `GET /api/worker/status` | Trạng thái của chính worker. |
| `POST /api/worker/jobs/claim` `{max_jobs?, search_profile_id?}` | Trong một transaction: hết hạn lease cũ → tạo job đến hạn (chỉ cho profile được chọn nếu có) → chặn/mở chặn theo nguồn → `FOR UPDATE SKIP LOCKED` lấy tối đa `min(max_jobs, max_jobs_per_claim)` job. Chỉ worker `active` nhận được job. `search_profile_id` là bộ lọc giới hạn claim cho lượt chạy có kiểm soát; nó không mở rộng quyền của worker. Thứ tự hòa được phân định bằng profile/job ID. |
| `POST /api/worker/jobs/:id/results` | Payload giống `/api/agent/results` nhưng **cấm `user_id`**. `scan_id` và `configuration_version` phải đúng giá trị server đã cấp. Chỉ worker đang giữ job mới được nộp. Chủ sở hữu lấy từ `search_jobs.search_profile_id`. |
| `POST /api/worker/jobs/:id/failure` `{scan_id, code, message, retryable}` | `execution_error`/`rate_limited`/`source_unavailable` → thử lại có backoff (5 phút × số lần), hết lượt thì `failed` và ghi một scan_run `failed` vào lịch sử của khách. `needs_reauthorization` → job dừng ở trạng thái đó, chờ admin. |

Payload job chỉ gồm: `job_id`, `scan_id`, `attempt_no`, `lease_expires_at`, `configuration_version`, `search {keywords, location, sources}`. Không có user id, tên khách hay profile id.

Xử lý mạng và POST không chắc chắn: nộp lại cùng job thì nhận lại đúng ack cũ và không ghi gì thêm. Worker khác nộp sẽ nhận `409 job_already_completed`. Worker đã mất lease nhận `409 lease_lost`. Báo lỗi lặp lại cũng idempotent.

CLI admin: `create-profile`, `create-worker` (mặc định `paused`), `workers` (kèm số job đang giữ, lần thành công gần nhất, 3 lỗi gần nhất, hàng đợi), `worker-set`, `release-jobs` (từ chối nếu worker còn `active`; lượt bị release được hoàn lại), `jobs`, `job-attempts`, `unblock-jobs`, `enqueue-jobs`, `rotate-worker`, `revoke-worker`. Xem `npm run cli`.

## 6–8. Kết quả test (`test/shared-workers.test.ts`, dữ liệu tổng hợp)

`npm test`: **42/42 pass** (27 test cũ cộng 15 test mới). `npm run build` OK. Các test mới kiểm:

- User A (F&B miền Nam) và User B (khách sạn Hà Nội) dùng chung Worker 01. Worker claim được đúng 2 job, payload không lộ id hay tên khách, claim lần nữa ra 0.
- Worker không thể gửi `user_id`, tự đặt `scan_id`, nộp kết quả B vào job A, hay nộp job của worker khác.
- Kết quả lưu đúng chủ sở hữu. Cùng một URL được lưu riêng cho A và B. Theo đúng truy vấn web, A không thấy dữ liệu của B và ngược lại.
- Gửi trùng thì nhận cùng ack, không có scan hay lead mới.
- Job A lỗi trong khi B vẫn thành công, dữ liệu A không đổi, có backoff và attempt được ghi lại.
- Lease hết hạn → job quay về hàng đợi. Worker 01 `draining` không nhận job mới. Worker 02 nhận job; kết quả trễ của Worker 01 bị từ chối; mỗi job commit đúng một lần. Lịch sử attempt: 01 failed, 01 expired, 02 completed.
- Toàn bộ scan và post có trước khi thay worker giữ nguyên, ownership không đổi.
- Admin release một worker `unavailable` → job về hàng đợi, không tốn lượt thử, worker cũ nộp trễ bị `lease_lost`.
- Không còn worker active → job ở lại `pending` (trễ, không mất).
- Job cần nguồn mà không worker nào được phép → `blocked`; cấp quyền thì tự mở. Khi gặp `needs_reauthorization`, profile không sinh job mới và không có kết quả thiếu nào bị ghi vào tài khoản khách.
- Hết lượt thử → `failed` và hiện trong lịch sử scan của khách.
- Ba worker claim đồng thời: 2 job, mỗi job được giao đúng một lần.
- Agent A/B cũ (credential, scan, post) giữ nguyên.

**Đây chỉ là bằng chứng cho backend, không phải bằng chứng về năng lực của Muse.**

Giới hạn của test: test chạy trên DB dev và tự bỏ qua nếu DB đã có search profile thật hoặc worker active, để không bao giờ nhận job thật. Khi đã tạo profile thật, cần chuyển test sang một database test riêng.

## 9. Năng lực và giới hạn sử dụng

Chưa có số đo thật nên chưa thể hứa con số. Công thức để lập kế hoạch:

- Mỗi worker xử lý tối đa `N = max_jobs_per_claim` job mỗi lần Muse chạy. Nếu Muse chạy mỗi 30 phút thì năng lực là `N × W` profile mỗi 30 phút (W là số worker).
- Với P profile cùng tần suất 30 phút: khi `P ≤ N × W` thì không trễ; khi vượt, mỗi profile thực tế được quét khoảng mỗi `ceil(P / (N×W)) × 30` phút.
- Số request mỗi job: 1 claim (dùng chung cho cả batch), ít nhất 1 lần tìm Facebook (nhiều hơn nếu Muse tìm từng keyword riêng, điều này chưa xác minh), và 1 POST. Retry tăng thêm khoảng `tỉ lệ lỗi × số lần thử`.
- Chưa biết: thời gian một lần tìm, giới hạn credit hay số lần chạy của gói Muse, giới hạn tốc độ tìm kiếm Facebook trên mỗi tài khoản, và việc Muse có cho chạy song song không. Hai scan thật cho thấy Muse có thể **lọc bớt** kết quả (38 tìm thấy, 5 được gửi), nên chất lượng mỗi job cũng cần đo.
- Khi thiếu năng lực: job ở lại hàng đợi, `workers` hiển thị `oldest_pending_slot`. Không có tự động xoay tài khoản. Mở rộng hợp lệ: thêm tài khoản hoặc gói Muse được nhà cung cấp cho phép, giảm tần suất, hoặc gộp keyword.
- Không hiển thị số dư token, vì không có cách được hỗ trợ để đọc nó.

## 11. Bước tiếp theo để xác minh với Muse thật

API phải được khởi động lại để nạp route mới (`.\start-dev.ps1` hoặc `npm run dev`). Không đụng tới connector "Local Lead Bridge" và các lịch POC hiện có.

Thiết lập (admin, chạy local):

```powershell
npm run cli -- create-profile --user <USER_A_ID> --name "Tìm kiếm của tôi"
npm run cli -- set-config --agent <PROFILE_A_ID> --keywords "quán ăn sắp khai trương|quán cafe sắp khai trương" --location "Miền Nam" --frequency 30
npm run cli -- create-profile --user <USER_B_ID> --name "Tìm kiếm của tôi"
npm run cli -- set-config --agent <PROFILE_B_ID> --keywords "khách sạn sắp khai trương" --location "Hà Nội" --frequency 30
npm run cli -- create-worker --name "Muse Worker 01" --sources "social.search" --max-jobs 2
npm run cli -- worker-set --worker <WORKER_01_ID> --status active
```

Lưu credential của worker vào kho bí mật của Muse, tạo một connector **mới** (ví dụ "QLead Worker"), rồi dán prompt sau vào Muse Worker 01 để chạy **một lần thủ công**:

```text
You are QLead Muse Worker 01. Run this task once, manually. Do not create or change any schedule or automation, and do not modify the existing "Local Lead Bridge" connector or its credential.

Connector: "QLead Worker", base URL <BASE_URL>. Send its stored credential as "Authorization: Bearer <credential>" using the direct HTTP client. Never print, copy, or report the credential.

1. POST <BASE_URL>/api/worker/jobs/claim with JSON body {"max_jobs": 2}. Report the HTTP status and the number of jobs. If there are 0 jobs, report that and stop.
2. For each job, in order, one at a time:
   a. Use only that job's search.keywords, search.location and search.sources. Run your Facebook search capability for these keywords (report whether you searched each keyword separately or combined). Do not reuse posts, memory, or results from another job or from earlier conversations.
   b. Keep only real posts you actually found in this run. Never invent posts, authors, dates, phone numbers, or URLs. Use only facebook.com or fb.watch URLs.
   c. POST <BASE_URL>/api/worker/jobs/<job_id>/results with:
      {"event":"facebook_scan_completed","source":"muse","configuration_version":<job.configuration_version>,"scan_id":"<job.scan_id>","scanned_at":"<ISO-8601 time with offset>","keywords_used":[...],"sources_used":[...],"posts":[{"url":"...","author":"...","content":"...","published_at":"<ISO-8601 or null>","platform":"facebook","collected_via":"qlead_shared_worker"}],"stats":{"total_found":<number found before filtering>},"errors":[]}
      Do not include any user_id or customer field. Use exactly the job's scan_id and configuration_version.
   d. If the search fails, POST <BASE_URL>/api/worker/jobs/<job_id>/failure with {"scan_id":"<job.scan_id>","code":"execution_error","message":"<short reason>","retryable":true}. Use "rate_limited" for usage or quota limits, and "needs_reauthorization" with "retryable":false if Facebook access is missing or expired.
   e. If a POST times out or returns 5xx, retry the identical request up to 2 more times. If it returns 409 (lease_lost or job_already_completed), stop working on that job and do not retry.
3. Report for each job: job_id, the keywords and location used, the search method, total found, posts submitted, the HTTP status and response body of the submit, and the time taken. Also report anything about usage limits or credits that Muse shows you. Do not estimate values you cannot see.
```

Kiểm tra sau khi chạy: `npm run cli -- jobs`, `npm run cli -- workers`, `npm run cli -- posts --user <USER_A_ID>` và tương tự cho B. Đăng nhập web bằng A và B để xác nhận mỗi người chỉ thấy lead của mình.

**Worker 02**: chỉ làm khi đã có tài khoản Muse thứ hai được phép sử dụng.
1. Chạy `create-worker --name "Muse Worker 02"`. Worker tạo ra ở trạng thái `paused`. Ghi rõ những nguồn Facebook mà tài khoản này thực sự truy cập được vào `--sources`.
2. Kết nối Facebook trên tài khoản 02 (không kế thừa từ 01).
3. Chuyển Worker 01 sang `draining`. Chờ các job của 01 hoàn tất hoặc hết lease, hoặc chuyển 01 sang `unavailable` rồi chạy `release-jobs`.
4. Chuyển Worker 02 sang `active` và chạy cùng prompt trên (đổi tên thành Worker 02).
5. Xác nhận: lịch sử scan và lead cũ của A và B không đổi, các scan mới có `executed_by_worker_id` là 02, và không job nào commit hai lần.

## 12. Rào cản thương mại hóa

1. **Điều khoản Muse:** phải được nhà cung cấp cho phép dùng một tài khoản để phục vụ nhiều khách trả phí, và cho phép chạy theo lịch hoặc tự động ở quy mô này. Chưa xác minh.
2. **Điều khoản Meta/Facebook:** việc thu thập bài đăng một cách tự động cho mục đích thương mại có rủi ro. Cần ý kiến pháp lý.
3. **Dữ liệu cá nhân:** lead chứa tên, nội dung và có thể cả số điện thoại của người đăng. Cần đánh giá theo Nghị định 13/2023/NĐ-CP (mục đích xử lý, thông báo, lưu trữ, xóa).
4. **Năng lực chưa đo:** chưa có số liệu thật về thời gian, credit và giới hạn tốc độ.
5. **Hạ tầng:** API hiện chạy trên máy cá nhân qua tunnel tạm (ngrok hoặc cloudflared). Máy ngủ thì worker không gọi được.
6. **Web chưa có trạng thái giám sát từ job:** khách mới chỉ thấy lịch sử scan. Trạng thái "đang trễ" hay "cần cấp lại quyền" nằm trong `search_jobs`, nhưng web chưa đọc tới.
