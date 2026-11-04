# QLead: hai mÃ´i trÆ°á»ng Ä‘á»™c láº­p (Local + Production)

NgÃ y: 2026-11-04. Kiáº¿n trÃºc owner chá»‘t: production = **Next.js trÃªn Vercel + Supabase PostgreSQL**, khÃ´ng cÃ³ Fastify riÃªng. Má»™t codebase, hai database, má»™t danh tÃ­nh admin dÃ¹ng á»Ÿ cáº£ hai nÆ¡i, má»™t tÃ i khoáº£n Muse phá»¥c vá»¥ cáº£ hai.

| | LOCAL | PRODUCTION |
|---|---|---|
| Web | `web/` (`next dev`/`next start`) | Vercel project `qlead`, Root Directory `web` |
| API cho Muse | Fastify `src/server.ts` + ngrok (giá»¯ nguyÃªn) | Next.js Route Handlers `/api/worker/*`, `/api/public/*`, `/health` cháº¡y **chÃ­nh cÃ¡c handler** trong `src/worker-api.ts`, `src/wake-signal.ts` |
| Database | Docker `muse_bridge` (127.0.0.1:55432) | Supabase QLProject (pooler, cá»•ng 6543) |
| `QLEAD_ENVIRONMENT` | khÃ´ng Ä‘áº·t (= `local`) | `production` |
| Worker credential | `muse_workers` trong DB local | `muse_workers` trong Supabase (táº¡o riÃªng) |
| Muse connector | `QLead Worker` â†’ URL ngrok | `QLead Worker Production` â†’ `https://qlead.vercel.app` |

## 1. Chá»‘t cháº·n cÃ´ láº­p (src/environment.ts)

Pool duy nháº¥t má»—i process (`src/db.ts` vÃ  `web/lib/server/db.ts` dÃ¹ng chung má»™t global) gá»i `assertDatabaseEnvironment` trÆ°á»›c truy váº¥n Ä‘áº§u tiÃªn:

- `local` chá»‰ cháº¥p nháº­n DATABASE_URL loopback.
- `production` tá»« chá»‘i loopback.
- TrÃªn Vercel, `QLEAD_ENVIRONMENT` báº¯t buá»™c; DB production chá»‰ má»Ÿ cho `VERCEL_ENV=production`. Preview/Development throw dÃ¹ biáº¿n cÃ³ bá»‹ lá»™ sang scope Preview (Ä‘Ã£ tháº¥y trÃªn Preview tháº­t: "QLEAD_ENVIRONMENT must be set explicitly on Vercel").
- Chá»‰ khai bÃ¡o `DATABASE_URL` cho scope **Production** trÃªn Vercel.

`DATABASE_POOL_MAX` (1â€“20) Ä‘áº·t kÃ­ch thÆ°á»›c pool. `DATABASE_CA_CERT` (PEM CA cá»§a Supabase) báº­t xÃ¡c minh TLS Ä‘áº§y Ä‘á»§.

## 2. Database production (ops/production-db.ts)

Credential Ä‘á»c tá»« `.env.supabase` (git-ignored), biáº¿n `PROD_DATABASE_URL`. Script tá»« chá»‘i host loopback, host khÃ´ng pháº£i Supabase, host trÃ¹ng DB local.

```
npx tsx ops/production-db.ts check | migrate | harden | verify | provision-admin
```

- Chá»‰ Ã¡p schema cá»§a QLead (`public.*` + `schema_migrations`). KhÃ´ng Ä‘á»¥ng schema do Supabase quáº£n lÃ½.
- Hardening (`ops/supabase-harden.sql`): báº­t RLS, REVOKE `anon`/`authenticated` trÃªn má»i báº£ng `public` ká»ƒ cáº£ báº£ng táº¡o sau. QLead khÃ´ng dÃ¹ng Supabase Data API hay Supabase Auth.
- KhÃ´ng copy dá»¯ liá»‡u; `verify` xÃ¡c nháº­n báº£ng nghiá»‡p vá»¥ rá»—ng.

Admin: `provision-admin` Ä‘á»c **má»™t** admin local, táº¡o user **má»›i** á»Ÿ production vÃ  chÃ©p email + scrypt hash (cÃ³ salt). KhÃ´ng cÃ³ plaintext. ÄÄƒng nháº­p giá»‘ng nhau; user id, session, dá»¯ liá»‡u tÃ¡ch biá»‡t. Id admin production chá»‰ Ä‘áº·t vÃ o `QLEAD_ADMIN_USER_IDS` cá»§a Vercel Production.

## 3. API cá»§a Muse trong Next.js (web/lib/server/worker-routes.ts)

KhÃ´ng viáº¿t láº¡i logic: `workerRoutes()` vÃ  `wakeSignalRoutes()` Ä‘Äƒng kÃ½ handler lÃªn má»™t router tá»‘i giáº£n thay vÃ¬ Fastify; route handler Next chuyá»ƒn request vÃ o Ä‘Ãºng handler Ä‘Ã³ (headers, body JSON â‰¤ 2 MiB, params, ip tá»« `x-forwarded-for` cá»§a Vercel; reply.code/header/send). Fastify váº«n dÃ¹ng cÃ¡c file nÃ y á»Ÿ local, nÃªn hai mÃ´i trÆ°á»ng cháº¡y cÃ¹ng má»™t code claim/lease/ingest.

TÆ°Æ¡ng thÃ­ch serverless (Ä‘Ã£ kiá»ƒm tra code):

| Háº¡ng má»¥c | CÆ¡ cháº¿ | Serverless |
|---|---|---|
| Job Ä‘á»‹nh ká»³ 30 phÃºt | `enqueueDueJobs` sinh slot lÆ°á»i trong transaction cá»§a `/claim` | OK, khÃ´ng timer |
| Wake generation | tÃ­nh tá»« DB, hash táº¥t Ä‘á»‹nh | OK |
| Claim/lease | `FOR UPDATE` worker + `FOR UPDATE SKIP LOCKED` job, 1 transaction/request | OK vá»›i transaction pooler |
| Advisory lock, LISTEN, prepared statement cÃ³ tÃªn, SET session | khÃ´ng dÃ¹ng | OK |
| Initial Discovery / Early Follow-up | enqueue trong transaction lÆ°u há»“ sÆ¡ / nháº­n káº¿t quáº£ | OK |
| Recovery | lease háº¿t háº¡n xá»­ lÃ½ lÆ°á»i lÃºc claim; phase 5/15 phÃºt tÃ­nh theo thá»i gian | OK |
| Ingest idempotent | `scan_id` + `attempt_no` + unique constraint | OK (E2E kiá»ƒm lost-ack retry) |
| Rate limit wake / Ä‘Äƒng nháº­p | Map trong process | Theo instance; nÃªn thÃªm Vercel Firewall rule |

Há»£p Ä‘á»“ng API giá»¯ nguyÃªn (xem SHARED_WORKERS.md): `GET /api/worker/status`, `POST /api/worker/jobs/claim`, `POST /api/worker/jobs/:jobId/results`, `POST /api/worker/jobs/:jobId/failure`, `GET /api/public/worker-wake`, `GET /api/public/worker-dispatch`, `GET /health`. API agent cÅ© `/api/agent/*` chá»‰ cÃ³ á»Ÿ local.

Kiá»ƒm thá»­: `web/e2e/worker-routes-e2e.mts` (DB test riÃªng, Next dev) 13/13; backend `npm test` trÃªn DB test riÃªng 116 pass / 2 skip; test mÃ´i trÆ°á»ng + dispatcher 5/5.

## 4. Muse: má»™t Hook, hai mÃ´i trÆ°á»ng

RÃ ng buá»™c (HOOK_OPERATIONS.md, WAKE_SIGNAL_POC.md): Muse khÃ´ng cÃ³ API; Hook GET má»™t URL cÃ´ng khai, lÆ°u generation, Ä‘Ã¡nh thá»©c agent; agent dÃ¹ng connector cÃ³ Bearer credential. Endpoint wake áº©n danh nÃªn chá»‰ má»™t Hook Ä‘Æ°á»£c poll.

Dispatcher `GET https://qlead.vercel.app/api/public/worker-dispatch`:

1. Production cÃ³ viá»‡c â†’ `{"wake":true,"environment":"production","generation":"production:<hash>"}`.
2. KhÃ´ng cÃ³, vÃ  `QLEAD_DISPATCH_SECONDARY_WAKE_URL` (= `<ngrok>/api/public/worker-wake`, chá»‰ HTTPS, khÃ´ng query/credential) Ä‘Æ°á»£c Ä‘áº·t â†’ Ä‘á»c tÃ­n hiá»‡u local, timeout 3 giÃ¢y â†’ `{"wake":true,"environment":"local","generation":"local:<hash>"}`.
3. CÃ²n láº¡i â†’ `{"wake":false}`. MÃ¡y dev táº¯t = im láº·ng.

Äáº£m báº£o: production Æ°u tiÃªn; credential tÃ¡ch theo DB (credential bÃªn nÃ y gá»­i sang bÃªn kia â†’ 401); job id chá»‰ tá»“n táº¡i trong DB cá»§a nÃ³ nÃªn khÃ´ng thá»ƒ ghi chÃ©o káº¿t quáº£; generation cÃ³ tiá»n tá»‘ mÃ´i trÆ°á»ng; lease + SKIP LOCKED chá»‘ng claim trÃ¹ng; dispatcher chá»‰ Ä‘á»c boolean + marker cÃ´ng khai.

Prompt agent khi Ä‘Æ°á»£c Ä‘Ã¡nh thá»©c:

```
Náº¿u environment = "production": dÃ¹ng connector "QLead Worker Production".
Náº¿u environment = "local": dÃ¹ng connector "QLead Worker" (ngrok).
KhÃ´ng bao giá» dÃ¹ng credential cá»§a mÃ´i trÆ°á»ng nÃ y cho mÃ´i trÆ°á»ng kia.
Claim tá»‘i Ä‘a 1 job (max_jobs: 1), rá»“i claim â†’ tÃ¬m â†’ results/failure nhÆ° cÅ©.
LÆ°u generation (kÃ¨m tiá»n tá»‘) trÆ°á»›c khi cháº¡y; khÃ´ng cháº¡y láº¡i generation Ä‘Ã£ lÆ°u.
```

KÃ­ch hoáº¡t (cáº§n owner duyá»‡t, theo thá»© tá»±; chÆ°a lÃ m bÆ°á»›c nÃ o):

1. `https://qlead.vercel.app/health` = ok.
2. Owner tá»± táº¡o worker production trong terminal cá»§a mÃ¬nh: Ä‘áº·t `DATABASE_URL=<Supabase>` vÃ  `QLEAD_ENVIRONMENT=production` rá»“i `npm run cli -- create-worker --name "Muse Production"`; credential in má»™t láº§n, dÃ¡n tháº³ng vÃ o connector má»›i `QLead Worker Production`; `npm run cli -- worker-set â€¦` Ä‘á»ƒ active.
3. Gá»i `/api/worker/status` má»™t láº§n báº±ng connector má»›i (khÃ´ng claim).
4. (TÃ¹y chá»n) Ä‘áº·t `QLEAD_DISPATCH_SECONDARY_WAKE_URL` á»Ÿ Vercel Production.
5. Äá»•i URL cá»§a **Hook hiá»‡n cÃ³** sang `/api/public/worker-dispatch` + cáº­p nháº­t prompt. KhÃ´ng táº¡o Hook thá»© hai.

## 5. Vercel (project `qlead`)

Root Directory `web`, framework Next.js. `web/vercel.json` cÃ i thÃªm deps gá»‘c (`npm ci --prefix ..`, gồm cả @types/pg cho bước type-check) vÃ¬ `web` import `../src` (zod, pg, dotenv).

Biáº¿n mÃ´i trÆ°á»ng, scope **Production** only:

| Biáº¿n | GiÃ¡ trá»‹ |
|---|---|
| `QLEAD_ENVIRONMENT` | `production` |
| `DATABASE_URL` | Supabase transaction pooler (6543), cÃ³ máº­t kháº©u |
| `DATABASE_POOL_MAX` | `3` |
| `QLEAD_ADMIN_USER_IDS` | id admin production |
| `QLEAD_WORKER_PUBLIC_URL` | `https://qlead.vercel.app` |
| `ENABLE_DEV_QUICK_LOGIN` | `false` |
| `DATABASE_CA_CERT` | (khuyáº¿n nghá»‹) CA Supabase |
| `QLEAD_DISPATCH_SECONDARY_WAKE_URL` | (tÃ¹y chá»n) URL wake local |

KhÃ´ng cÃ³ `NEXT_PUBLIC_*`. Session: cookie `qlead_session` HttpOnly, Secure, SameSite=Lax, 7 ngÃ y, hash trong `web_sessions`. Production domain pháº£i cÃ´ng khai (Deployment Protection chá»‰ cho Preview) Ä‘á»ƒ Muse gá»i Ä‘Æ°á»£c.
