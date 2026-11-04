# QLead: hai môi trường độc lập (Local + Production)

Ngày: 2026-11-04. Kiến trúc owner chốt: production = **Next.js trên Vercel + Supabase PostgreSQL**, không có Fastify riêng. Một codebase, hai database, một danh tính admin dùng ở cả hai nơi, một tài khoản Muse phục vụ cả hai.

| | LOCAL | PRODUCTION |
|---|---|---|
| Web | `web/` (`next dev`/`next start`) | Vercel project `qlead`, Root Directory `web` |
| API cho Muse | Fastify `src/server.ts` + ngrok (giữ nguyên) | Next.js Route Handlers `/api/worker/*`, `/api/public/*`, `/health` chạy **chính các handler** trong `src/worker-api.ts`, `src/wake-signal.ts` |
| Database | Docker `muse_bridge` (127.0.0.1:55432) | Supabase QLProject (pooler, cổng 6543) |
| `QLEAD_ENVIRONMENT` | không đặt (= `local`) | `production` |
| Worker credential | `muse_workers` trong DB local | `muse_workers` trong Supabase (tạo riêng) |
| Muse connector | `QLead Worker` → URL ngrok | `QLead Worker Production` → `https://qlead.vercel.app` |

## 1. Chốt chặn cô lập (src/environment.ts)

Pool duy nhất mỗi process (`src/db.ts` và `web/lib/server/db.ts` dùng chung một global) gọi `assertDatabaseEnvironment` trước truy vấn đầu tiên:

- `local` chỉ chấp nhận DATABASE_URL loopback.
- `production` từ chối loopback.
- Trên Vercel, `QLEAD_ENVIRONMENT` bắt buộc; DB production chỉ mở cho `VERCEL_ENV=production`. Preview/Development throw dù biến có bị lộ sang scope Preview (đã thấy trên Preview thật: "QLEAD_ENVIRONMENT must be set explicitly on Vercel").
- Chỉ khai báo `DATABASE_URL` cho scope **Production** trên Vercel.

`DATABASE_POOL_MAX` (1–20) đặt kích thước pool. `DATABASE_CA_CERT` (PEM CA của Supabase) bật xác minh TLS đầy đủ.

## 2. Database production (ops/production-db.ts)

Credential đọc từ `.env.supabase` (git-ignored), biến `PROD_DATABASE_URL`. Script từ chối host loopback, host không phải Supabase, host trùng DB local.

```
npx tsx ops/production-db.ts check | migrate | harden | verify | provision-admin
```

- Chỉ áp schema của QLead (`public.*` + `schema_migrations`). Không đụng schema do Supabase quản lý.
- Hardening (`ops/supabase-harden.sql`): bật RLS, REVOKE `anon`/`authenticated` trên mọi bảng `public` kể cả bảng tạo sau. QLead không dùng Supabase Data API hay Supabase Auth.
- Không copy dữ liệu; `verify` xác nhận bảng nghiệp vụ rỗng.

Admin: `provision-admin` đọc **một** admin local, tạo user **mới** ở production và chép email + scrypt hash (có salt). Không có plaintext. Đăng nhập giống nhau; user id, session, dữ liệu tách biệt. Id admin production chỉ đặt vào `QLEAD_ADMIN_USER_IDS` của Vercel Production.

## 3. API của Muse trong Next.js (web/lib/server/worker-routes.ts)

Không viết lại logic: `workerRoutes()` và `wakeSignalRoutes()` đăng ký handler lên một router tối giản thay vì Fastify; route handler Next chuyển request vào đúng handler đó (headers, body JSON ≤ 2 MiB, params, ip từ `x-forwarded-for` của Vercel; reply.code/header/send). Fastify vẫn dùng các file này ở local, nên hai môi trường chạy cùng một code claim/lease/ingest.

Tương thích serverless (đã kiểm tra code):

| Hạng mục | Cơ chế | Serverless |
|---|---|---|
| Job định kỳ 30 phút | `enqueueDueJobs` sinh slot lười trong transaction của `/claim` | OK, không timer |
| Wake generation | tính từ DB, hash tất định | OK |
| Claim/lease | `FOR UPDATE` worker + `FOR UPDATE SKIP LOCKED` job, 1 transaction/request | OK với transaction pooler |
| Advisory lock, LISTEN, prepared statement có tên, SET session | không dùng | OK |
| Initial Discovery / Early Follow-up | enqueue trong transaction lưu hồ sơ / nhận kết quả | OK |
| Recovery | lease hết hạn xử lý lười lúc claim; phase 5/15 phút tính theo thời gian | OK |
| Ingest idempotent | `scan_id` + `attempt_no` + unique constraint | OK (E2E kiểm lost-ack retry) |
| Rate limit wake / đăng nhập | Map trong process | Theo instance; nên thêm Vercel Firewall rule |

Hợp đồng API giữ nguyên (xem SHARED_WORKERS.md): `GET /api/worker/status`, `POST /api/worker/jobs/claim`, `POST /api/worker/jobs/:jobId/results`, `POST /api/worker/jobs/:jobId/failure`, `GET /api/public/worker-wake`, `GET /api/public/worker-dispatch`, `GET /health`. API agent cũ `/api/agent/*` chỉ có ở local.

Kiểm thử: `web/e2e/worker-routes-e2e.mts` (DB test riêng, Next dev) 13/13; backend `npm test` trên DB test riêng 116 pass / 2 skip; test môi trường + dispatcher 5/5.

## 4. Muse: một Hook, hai môi trường

Ràng buộc (HOOK_OPERATIONS.md, WAKE_SIGNAL_POC.md): Muse không có API; Hook GET một URL công khai, lưu generation, đánh thức agent; agent dùng connector có Bearer credential. Endpoint wake ẩn danh nên chỉ một Hook được poll.

Dispatcher `GET https://qlead.vercel.app/api/public/worker-dispatch`:

1. Production có việc → `{"wake":true,"environment":"production","generation":"production:<hash>"}`.
2. Không có, và `QLEAD_DISPATCH_SECONDARY_WAKE_URL` (= `<ngrok>/api/public/worker-wake`, chỉ HTTPS, không query/credential) được đặt → đọc tín hiệu local, timeout 3 giây → `{"wake":true,"environment":"local","generation":"local:<hash>"}`.
3. Còn lại → `{"wake":false}`. Máy dev tắt = im lặng.

Đảm bảo: production ưu tiên; credential tách theo DB (credential bên này gửi sang bên kia → 401); job id chỉ tồn tại trong DB của nó nên không thể ghi chéo kết quả; generation có tiền tố môi trường; lease + SKIP LOCKED chống claim trùng; dispatcher chỉ đọc boolean + marker công khai.

Prompt agent khi được đánh thức:

```
Nếu environment = "production": dùng connector "QLead Worker Production".
Nếu environment = "local": dùng connector "QLead Worker" (ngrok).
Không bao giờ dùng credential của môi trường này cho môi trường kia.
Claim tối đa 1 job (max_jobs: 1), rồi claim → tìm → results/failure như cũ.
Lưu generation (kèm tiền tố) trước khi chạy; không chạy lại generation đã lưu.
```

Kích hoạt (cần owner duyệt, theo thứ tự; chưa làm bước nào):

1. `https://qlead.vercel.app/health` = ok.
2. Owner tự tạo worker production trong terminal của mình: đặt `DATABASE_URL=<Supabase>` và `QLEAD_ENVIRONMENT=production` rồi `npm run cli -- create-worker --name "Muse Production"`; credential in một lần, dán thẳng vào connector mới `QLead Worker Production`; `npm run cli -- worker-set …` để active.
3. Gọi `/api/worker/status` một lần bằng connector mới (không claim).
4. (Tùy chọn) đặt `QLEAD_DISPATCH_SECONDARY_WAKE_URL` ở Vercel Production.
5. Đổi URL của **Hook hiện có** sang `/api/public/worker-dispatch` + cập nhật prompt. Không tạo Hook thứ hai.

## 5. Vercel (project `qlead`)

Root Directory `web`, framework Next.js. `web/vercel.json` cài thêm deps gốc (`npm ci --prefix .. --omit=dev`) vì `web` import `../src` (zod, pg, dotenv).

Biến môi trường, scope **Production** only:

| Biến | Giá trị |
|---|---|
| `QLEAD_ENVIRONMENT` | `production` |
| `DATABASE_URL` | Supabase transaction pooler (6543), có mật khẩu |
| `DATABASE_POOL_MAX` | `3` |
| `QLEAD_ADMIN_USER_IDS` | id admin production |
| `QLEAD_WORKER_PUBLIC_URL` | `https://qlead.vercel.app` |
| `ENABLE_DEV_QUICK_LOGIN` | `false` |
| `DATABASE_CA_CERT` | (khuyến nghị) CA Supabase |
| `QLEAD_DISPATCH_SECONDARY_WAKE_URL` | (tùy chọn) URL wake local |

Không có `NEXT_PUBLIC_*`. Session: cookie `qlead_session` HttpOnly, Secure, SameSite=Lax, 7 ngày, hash trong `web_sessions`. Production domain phải công khai (Deployment Protection chỉ cho Preview) để Muse gọi được.
