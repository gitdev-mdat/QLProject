# QLead: hai môi trường độc lập (Local + Production)

Ngày: 2026-11-04. Một codebase, hai database, một danh tính admin dùng được ở cả hai nơi, một tài khoản Muse phục vụ cả hai.

| | LOCAL | PRODUCTION |
|---|---|---|
| Web (Next.js) | `web/` chạy `next dev`/`next start` trên máy | Vercel project cho `web/` (Root Directory = `web`) |
| API (Fastify) | `npm run dev` + ngrok | Vercel project ở gốc repo (`api/index.js` + `vercel.json`) |
| Database | Docker `muse_bridge` (127.0.0.1:55432) | Supabase QLProject (Postgres) |
| `QLEAD_ENVIRONMENT` | không đặt (mặc định `local`) | `production` |
| Worker credential | `muse_workers` trong DB local | `muse_workers` trong Supabase (tạo riêng) |
| Muse connector | `QLead Worker` → URL ngrok | `QLead Worker Production` → URL API production |

## 1. Chốt chặn cô lập (src/environment.ts)

Mọi pool (Fastify `src/db.ts`, Next `web/lib/server/db.ts`) gọi `assertDatabaseEnvironment` trước truy vấn đầu tiên:

- `local` chỉ chấp nhận DATABASE_URL loopback. Không thể vô tình trỏ máy dev vào Supabase.
- `production` từ chối loopback.
- Trên Vercel, `QLEAD_ENVIRONMENT` bắt buộc; DB production chỉ mở cho `VERCEL_ENV=production`. Preview/Development throw ngay cả khi biến bị lộ sang scope Preview.
- Ngoài ra: chỉ khai báo `DATABASE_URL` cho scope **Production** trên Vercel. Preview không có DB, nên không thể ghi.

`DATABASE_POOL_MAX` (1–20) đặt kích thước pool; trên Vercel dùng 2–3 với Supabase transaction pooler (cổng 6543).

## 2. Database production (ops/production-db.ts)

Credential đọc từ `.env.supabase` (git-ignored), biến `PROD_DATABASE_URL`, không bao giờ từ `DATABASE_URL`. Script từ chối host loopback, host không phải Supabase, và host trùng DB local.

```
npx tsx ops/production-db.ts check
npx tsx ops/production-db.ts migrate          # migrations/*.sql + ops/supabase-harden.sql
npx tsx ops/production-db.ts verify
npx tsx ops/production-db.ts provision-admin
```

- Chỉ áp schema của QLead (bảng `public.*` + `schema_migrations`). `CREATE EXTENSION IF NOT EXISTS pgcrypto` là no-op trên Supabase. Không đụng `auth`, `storage`, `extensions`…
- Hardening: bật RLS và REVOKE quyền `anon`/`authenticated` trên mọi bảng `public` (kể cả bảng tạo sau). QLead không dùng Supabase Data API; app kết nối bằng owner qua pooler nên không bị RLS chặn. Không có Supabase Auth.
- Không copy dữ liệu. `verify` xác nhận mọi bảng nghiệp vụ = 0 dòng.

### Admin (cùng thông tin đăng nhập, dữ liệu độc lập)

`provision-admin` đọc **một** admin local (id trong `QLEAD_ADMIN_USER_IDS` của `web/.env.development.local`), tạo user **mới** ở production và chép email + scrypt hash (đã có salt). Không có mật khẩu plaintext ở đâu cả. Đăng nhập giống nhau, nhưng user id, session (`web_sessions`) và dữ liệu tách biệt hoàn toàn. Đổi mật khẩu một bên không ảnh hưởng bên kia. Id admin production chỉ đặt vào `QLEAD_ADMIN_USER_IDS` của Vercel Production.

## 3. Fastify trên Vercel Functions: đánh giá

Kết luận: **chạy được an toàn dưới dạng Vercel Function**, không cần hosting thường trực.

| Hạng mục | Cách hiện tại | Serverless |
|---|---|---|
| Job định kỳ 30 phút | `enqueueDueJobs` sinh slot lười trong transaction của `/claim` (slot = floor(now / tần suất)) | OK, không timer |
| Wake generation | `/api/public/worker-wake` tính từ DB, hash tất định | OK, không trạng thái trong process |
| Claim/lease | `SELECT … FOR UPDATE` trên worker + `FOR UPDATE SKIP LOCKED` trên job, một transaction/request | OK với Supavisor transaction mode |
| Advisory lock / LISTEN / prepared statement có tên / SET session | Không dùng (đã grep) | OK với transaction pooler |
| Initial Discovery / Early Follow-up | Được enqueue trong transaction của web save / ingest kết quả | OK |
| Recovery theo lịch | Lease hết hạn xử lý lười (`expireLeases` lúc claim); phase 5/15 phút tính từ thời gian | OK |
| Ingest idempotent | `scan_id` + `attempt_no` + unique constraint, cùng transaction | OK |
| Rate limit wake | Map trong process, mỗi instance một bucket | Yếu hơn; `trustProxy` bật trên Vercel. Khuyến nghị thêm Vercel Firewall rate-limit |
| Body 2 MiB | Giới hạn Vercel 4.5 MB | OK |

Không có `setInterval`/vòng lặp nền trong `src/`. Entry: `api/index.js` gọi app Fastify đã build (`dist/`), `vercel.json` rewrite mọi path vào function, thư mục tĩnh rỗng `api-public` (không phục vụ file repo).

## 4. Muse: một Hook, hai môi trường (dispatcher)

Ràng buộc đã biết (HOOK_OPERATIONS.md, WAKE_SIGNAL_POC.md): Muse không có API; Hook chỉ GET một URL công khai, lưu generation đã thấy, đánh thức agent; agent dùng connector có Bearer credential. Endpoint wake là ẩn danh nên chỉ một Hook được poll.

Thiết kế: **giữ một Hook duy nhất**, đổi URL nó poll sang dispatcher production:

`GET <PROD_API>/api/public/worker-dispatch`

1. Nếu production có việc → `{"wake":true,"environment":"production","generation":"production:<hash>"}`.
2. Nếu không, và `QLEAD_DISPATCH_SECONDARY_WAKE_URL` (URL wake công khai của local qua ngrok, chỉ HTTPS, không query/credential) được đặt → đọc tín hiệu local với timeout 3 giây → `{"wake":true,"environment":"local","generation":"local:<hash>"}`.
3. Còn lại → `{"wake":false}`. Máy dev tắt/ngrok chết = im lặng, production không bị ảnh hưởng.

Đảm bảo:

- Production luôn được ưu tiên; local chỉ được hỏi khi production rảnh.
- Credential riêng mỗi môi trường, nằm trong `muse_workers` của DB tương ứng. Credential local gửi tới API production → 401, và ngược lại. Không thể ghi chéo kết quả: job id thuộc DB nào thì chỉ API đó nhận.
- Generation có tiền tố môi trường nên trạng thái dedup của Hook không lẫn hai hàng đợi.
- Không claim trùng: lease + SKIP LOCKED trong từng DB; mỗi chu kỳ agent claim tối đa 1 job.
- Dispatcher chỉ đọc boolean + marker công khai của local; không có dữ liệu khách hàng đi qua.
- `/api/public/worker-wake` cũ giữ nguyên; Hook hiện tại vẫn chạy với ngrok cho đến khi owner chuyển.

Prompt cho agent khi được đánh thức (dùng sau khi production đã xác minh):

```
Nếu environment = "production": dùng connector "QLead Worker Production".
Nếu environment = "local": dùng connector "QLead Worker" (ngrok).
Không bao giờ dùng credential của môi trường này cho môi trường kia.
Claim tối đa 1 job (max_jobs: 1) rồi làm đúng quy trình claim → tìm → results/failure như cũ.
Lưu generation (kèm tiền tố) trước khi chạy; không chạy lại generation đã lưu.
```

Kích hoạt (cần owner duyệt, theo thứ tự):

1. Production API chạy, `GET /health` = ok.
2. Tạo worker production trong Supabase (`DATABASE_URL=<prod> QLEAD_ENVIRONMENT=production npm run cli -- create-worker …` do owner chạy trong terminal của mình, credential in ra một lần, dán thẳng vào Muse connector mới `QLead Worker Production`).
3. Gọi `/api/worker/status` một lần bằng connector mới (không claim).
4. Đặt `QLEAD_DISPATCH_SECONDARY_WAKE_URL` = `<ngrok>/api/public/worker-wake` ở Vercel Production (tùy chọn).
5. Đổi URL của Hook hiện có từ `<ngrok>/api/public/worker-wake` sang `<PROD_API>/api/public/worker-dispatch` và cập nhật prompt như trên. Không tạo Hook thứ hai.

## 5. Biến môi trường

Web (Vercel, scope **Production** only):

| Biến | Giá trị |
|---|---|
| `QLEAD_ENVIRONMENT` | `production` |
| `DATABASE_URL` | Supabase transaction pooler (6543) |
| `DATABASE_POOL_MAX` | `3` |
| `QLEAD_ADMIN_USER_IDS` | id admin production (từ `provision-admin`) |
| `QLEAD_WORKER_PUBLIC_URL` | URL API production (dùng trong prompt ở /admin/workers) |
| `ENABLE_DEV_QUICK_LOGIN` | `false` (production build vốn bỏ qua) |

API (Vercel, scope Production only): `QLEAD_ENVIRONMENT=production`, `DATABASE_URL`, `DATABASE_POOL_MAX=3`, `LOG_LEVEL=info`, tùy chọn `QLEAD_DISPATCH_SECONDARY_WAKE_URL`.

Không có biến `NEXT_PUBLIC_*`; không secret nào vào bundle frontend. Web không gọi Fastify: cả hai đọc cùng DB, Fastify chỉ phục vụ Muse.

## 6. Handoff cho Claude (Vercel Next.js)

- Root Directory `web`; `web/vercel.json` cài thêm deps gốc (`npm ci --prefix ..`) vì `web` import `../src` (zod, pg types).
- Auth: cookie `qlead_session` HttpOnly, Secure, SameSite=Lax, 7 ngày; session lưu hash trong `web_sessions`. Không có Supabase Auth. Admin = allowlist server-side `QLEAD_ADMIN_USER_IDS`.
- Domain tạm: `*.vercel.app` production. Deployment Protection có thể giữ cho Preview; Production domain phải công khai.
- Hạn chế: rate limit đăng nhập (`web/lib/auth-rate-limit.ts`) và wake là theo instance.
