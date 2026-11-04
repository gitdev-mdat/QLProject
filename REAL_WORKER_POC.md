# POC thật: 1 tài khoản Muse (Worker 01) phục vụ 2 user QLead

Trạng thái lúc chuẩn bị (2026-11-02): **chưa chạy với Muse**, nên chưa có kết quả pass hay fail.

## Hiện trạng đã kiểm tra

- PostgreSQL chạy trong Docker, migration mới nhất là `006_shared_workers.sql`.
- API `http://127.0.0.1:8787/health` trả về `{"status":"ok","database":"connected"}`. Các route của worker đã được nạp: gọi `/api/worker/status` khi không có token trả về 401.
- URL công khai: `https://thrill-snowdrop-primer.ngrok-free.dev`. Gọi `/health` từ client không phải trình duyệt (curl) trả về 200 JSON. Client có User-Agent giống trình duyệt sẽ gặp trang cảnh báo của ngrok (`ERR_NGROK_6024`) nếu thiếu header `ngrok-skip-browser-warning: true`. Prompt bên dưới đã có sẵn header này.

| | User A | User B |
|---|---|---|
| user_id | `502e453f-5ce3-4196-810a-debeb751697f` (Test User A, dùng cho dev quick login) | `e9ef48ca-c063-4c38-b405-f47025a6aa64` (Test User B) |
| search profile | `f206ffd6-0cc8-4027-92f5-ab9ff671610e` | `6479e12b-09ee-4a55-9053-a0616f5204c8` |
| config v1 | quán ăn / nhà hàng / quán cafe sắp khai trương, khu vực "Miền Nam" | khách sạn sắp khai trương / chuẩn bị khai trương, khu vực "Hà Nội" |
| tần suất, nguồn | 30 phút, `social.search` | 30 phút, `social.search` |

Agent cũ Muse A và Muse B không bị đụng tới, credential không bị rotate. Checksum dữ liệu cũ (agent, post, lead_states) trùng với lần kiểm tra ngày 2026-11-01.

## Bước 1: bạn tạo Worker 01 trong cửa sổ PowerShell của bạn

```powershell
cd C:\WorkspaceLead\muse-local-bridge
npm run cli -- create-worker --name "Muse Worker 01" --sources "social.search" --max-jobs 2 --lease 45
```

Lệnh in ra `credential` đúng một lần. Copy giá trị đó thẳng vào Muse, không dán vào chat hay file nào:

1. Mở Muse → Connectors → tạo connector **mới** tên `QLead Worker` (không sửa connector `Local Lead Bridge`).
2. Đặt Base URL là `https://thrill-snowdrop-primer.ngrok-free.dev`.
3. Lưu credential vào Secure Credentials Store của connector, dùng làm Bearer token.
4. Sau khi đã lưu credential vào Muse, bật worker (thay `<WORKER_ID>` bằng `id` mà lệnh trên in ra):

```powershell
npm run cli -- worker-set --worker <WORKER_ID> --status active
```

5. Nhắn mình "xong". Mình sẽ kiểm tra worker và tunnel trong DB rồi báo bạn dán prompt vào Muse.

`--lease 45` cho Muse 45 phút để làm xong cả 2 job đã nhận cùng lúc. Worker được tạo ở trạng thái `paused` nên chưa nhận job nào cho tới bước 4.

## Bước 2: prompt chạy một lần trong Muse (dán sau khi mình báo worker đã active)

```text
You are QLead Muse Worker 01. Run this task exactly once, now, manually.
Do not create, change, or delete any schedule or automation. Do not use or modify the "Local Lead Bridge" connector or its credential.

Connection: use the "QLead Worker" connector with your direct HTTP client (not the Browser tool).
Base URL: https://thrill-snowdrop-primer.ngrok-free.dev
On every request send:
  Authorization: Bearer <the credential stored in the QLead Worker connector>
  ngrok-skip-browser-warning: true
  Content-Type: application/json
Never print, copy, summarize, or report the credential.

Step 0. GET /api/worker/status. Report the HTTP status and body. If it is not 200 with "status":"active", stop and report.

Step 1. POST /api/worker/jobs/claim with body {"max_jobs": 2}. Record the time. Report the HTTP status and the full response body. If "jobs" is empty, stop and report.

Step 2. Process each job in the "jobs" array separately, one after another. For each job:
  a. Note the start time.
  b. Search Facebook with your social search capability using ONLY this job's search.keywords and search.location, and ONLY the sources in search.sources. Treat this job as a fresh, independent task. Do not reuse posts, notes, memory, or results from the other job, from earlier runs, or from earlier conversations.
  c. Keep only real posts you actually found in this run that match this job's keywords and location. Never invent or guess posts, authors, dates, phone numbers, or URLs. Use only facebook.com or fb.watch post URLs. Leave a field null if you do not know it.
  d. POST /api/worker/jobs/<job_id>/results with this JSON (no other top-level fields; never add user_id or any customer field):
     {
       "event": "facebook_scan_completed",
       "source": "muse",
       "configuration_version": <this job's configuration_version>,
       "scan_id": "<this job's scan_id, exactly as issued>",
       "scanned_at": "<current time, ISO-8601 with timezone offset>",
       "keywords_used": [<the keywords you actually searched>],
       "sources_used": [<the sources you actually used>],
       "posts": [
         {"url": "<post URL>", "author": "<name or null>", "title": "<short title or null>", "content": "<post text or null>",
          "published_at": "<ISO-8601 with offset, or null>", "platform": "facebook", "collected_via": "qlead_shared_worker"}
       ],
       "stats": {"total_found": <number of results seen before your filtering>},
       "errors": []
     }
     An empty "posts" array is valid if nothing matched.
  e. If the search itself fails, do not submit results. Instead POST /api/worker/jobs/<job_id>/failure with
     {"scan_id": "<this job's scan_id>", "code": "<execution_error | rate_limited | source_unavailable | needs_reauthorization>", "message": "<short reason>", "retryable": <true, or false for needs_reauthorization>}
     Use rate_limited for any usage, credit, or quota limit. Use needs_reauthorization if Facebook access is missing or expired.
  f. If a POST times out, has a network error, or returns HTTP 5xx, resend the identical request (same body) up to 2 more times, 10 seconds apart. If it returns 409, stop working on that job and do not resend. If it returns 400, report the full error body and do not change scan_id or configuration_version.
  g. Note the end time.

Step 3. Report, for each job separately:
  - job_id, scan_id, attempt_no
  - keywords and location used, and whether you searched each keyword separately or combined
  - start time, end time, duration
  - total results seen, number of posts submitted
  - every HTTP request made (method, path, status) and the response body of the results/failure request
  - any errors, retries, or limits encountered
Then report any usage, credit, or quota information Muse shows you for this run. If Muse shows none, say "not shown". Do not estimate anything you cannot see.
```

## Bước 3: kiểm tra sau khi Muse báo cáo (mình chạy)

```powershell
npm run cli -- jobs --limit 10
npm run cli -- workers
npm run cli -- job-attempts --job <JOB_ID>
npm run cli -- scans --limit 10
npm run cli -- posts --user 502e453f-5ce3-4196-810a-debeb751697f
npm run cli -- posts --user e9ef48ca-c063-4c38-b405-f47025a6aa64
```

Những điểm mình sẽ kiểm trong PostgreSQL:
- Có 2 job `completed`, mỗi job nằm đúng profile, với `executed_by_worker_id` là Worker 01.
- `scan_runs.external_scan_id` khớp với scan_id do server cấp.
- Post của A chỉ nằm dưới profile A, post của B chỉ nằm dưới profile B. Truy vấn theo `ac.user_id` (cách web đang dùng) không thấy chéo dữ liệu. Có thể đăng nhập web bằng A rồi B để xem tận mắt.
- Gửi lại kết quả cùng job thì nhận lại đúng ack cũ và không có dòng mới. Bước này kiểm bằng một POST lặp lại do bạn chạy, hoặc qua báo cáo retry của Muse.
- Checksum dữ liệu cũ (scan và post của các agent cũ, lead_states) không đổi.
- Thời lượng mỗi job lấy từ báo cáo của Muse, đối chiếu với `search_job_attempts.claimed_at` và `scan_runs.received_at`.

## Rào cản còn lại

- Đây chỉ là xác minh kỹ thuật với 1 tài khoản. Muse có cho dùng chung tài khoản cho nhiều khách trả phí không thì vẫn chưa xác minh.
- API và ngrok chạy trên máy bạn. Máy ngủ hoặc tắt hai cửa sổ PowerShell thì Muse không gọi được.
- `test/shared-workers.test.ts` giờ sẽ tự bỏ qua vì DB đã có search profile thật. Muốn chạy lại test này thì cần một database test riêng.
- Năng lực ở tần suất 30 phút chỉ ước lượng được sau khi có thời lượng thật từ lần chạy này.

## Kết quả lần chạy thật (2026-11-02, 10:33–10:35 +07:00)

Kết luận: **PASS cho phạm vi đã thử.** Một tài khoản Muse thật (Worker 01, chạy thủ công bằng prompt) đã nhận và hoàn tất 2 job độc lập cho 2 user QLead. Kết quả nằm đúng chủ sở hữu.

| | Job A (User A) | Job B (User B) |
|---|---|---|
| job_id | `90686101-…` → profile `f206ffd6-…` | `af0f6f36-…` → profile `6479e12b-…` |
| scan_id do server cấp | `job-b5746191-…` | `job-2f409624-…` |
| Thời gian Muse tự báo | ~54 giây | ~12 giây |
| Server ghi nhận (từ claim tới lúc nhận kết quả) | 62 giây | 81 giây (gồm thời gian chờ job A, vì 2 job chạy nối tiếp) |
| Kết quả Muse thấy / post đã gửi | 60 / 1 | 4 / 0 |
| Trạng thái | completed, scan `success` | completed, scan `success` |

Đã kiểm trong PostgreSQL:
- Cả 2 job `completed`, mỗi job chỉ có 1 attempt, `executed_by_worker_id` là Worker 01, mỗi job có đúng 1 scan_run.
- Post Haidilao AEON Tân Phú chỉ nằm dưới profile A, tức user `502e453f`. Truy vấn theo `user_id` của B không thấy post này.
- Kiểm idempotency trên dữ liệu thật (gửi lại tới API local bằng credential của worker):
  - Gửi lại job A: nhận đúng ack cũ, không ghi gì thêm.
  - Gửi lại job B kèm một post mới: nhận ack cũ, post mới không được lưu.
  - Nộp scan_id của B vào job A: `409`.
  - Thêm `user_id` vào payload: `400`.
  - Claim lại: 0 job.
- Checksum dữ liệu cũ (scan và post của agent cũ, credential, lead_states) không đổi.

Giới hạn và phát hiện:
- Post của A có `content = null` (Muse không lấy được caption nguyên văn). Web lọc ẩn các lead thiếu nội dung, nên **User A chưa thấy lead này trên web**, dù dữ liệu đã nằm đúng chủ sở hữu.
- Muse gộp tất cả keyword vào 1 lần `social.search`, không tìm riêng từng keyword.
- `scanned_at` của job A bị Muse đặt sau thời điểm gửi khoảng 70 giây. Backend vẫn nhận, vì hiện chưa kiểm `scanned_at`.
- Muse không hiển thị thông tin usage/credit, nên chưa đánh giá được giới hạn sử dụng.
- Đây là lần chạy **thủ công**. Chưa xác minh được việc Muse tự chạy theo lịch 30 phút, ổn định qua nhiều lần chạy, hay với nhiều hơn 2 job.
