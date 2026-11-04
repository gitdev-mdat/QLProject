# QLead: hai mÃƒÂ´i trÃ†Â°Ã¡Â»Âng Ã„â€˜Ã¡Â»â„¢c lÃ¡ÂºÂ­p (Local + Production)

NgÃƒÂ y: 2026-11-04. KiÃ¡ÂºÂ¿n trÃƒÂºc owner chÃ¡Â»â€˜t: production = **Next.js trÃƒÂªn Vercel + Supabase PostgreSQL**, khÃƒÂ´ng cÃƒÂ³ Fastify riÃƒÂªng. MÃ¡Â»â„¢t codebase, hai database, mÃ¡Â»â„¢t danh tÃƒÂ­nh admin dÃƒÂ¹ng Ã¡Â»Å¸ cÃ¡ÂºÂ£ hai nÃ†Â¡i, mÃ¡Â»â„¢t tÃƒÂ i khoÃ¡ÂºÂ£n Muse phÃ¡Â»Â¥c vÃ¡Â»Â¥ cÃ¡ÂºÂ£ hai.

| | LOCAL | PRODUCTION |
|---|---|---|
| Web | `web/` (`next dev`/`next start`) | Vercel project `qlead`, Root Directory `web` |
| API cho Muse | Fastify `src/server.ts` + ngrok (giÃ¡Â»Â¯ nguyÃƒÂªn) | Next.js Route Handlers `/api/worker/*`, `/api/public/*`, `/health` chÃ¡ÂºÂ¡y **chÃƒÂ­nh cÃƒÂ¡c handler** trong `src/worker-api.ts`, `src/wake-signal.ts` |
| Database | Docker `muse_bridge` (127.0.0.1:55432) | Supabase QLProject (pooler, cÃ¡Â»â€¢ng 6543) |
| `QLEAD_ENVIRONMENT` | khÃƒÂ´ng Ã„â€˜Ã¡ÂºÂ·t (= `local`) | `production` |
| Worker credential | `muse_workers` trong DB local | `muse_workers` trong Supabase (tÃ¡ÂºÂ¡o riÃƒÂªng) |
| Muse connector | `QLead Worker` Ã¢â€ â€™ URL ngrok | `QLead Worker Production` Ã¢â€ â€™ `https://qlead.vercel.app` |

## 1. ChÃ¡Â»â€˜t chÃ¡ÂºÂ·n cÃƒÂ´ lÃ¡ÂºÂ­p (src/environment.ts)

Pool duy nhÃ¡ÂºÂ¥t mÃ¡Â»â€”i process (`src/db.ts` vÃƒÂ  `web/lib/server/db.ts` dÃƒÂ¹ng chung mÃ¡Â»â„¢t global) gÃ¡Â»Âi `assertDatabaseEnvironment` trÃ†Â°Ã¡Â»â€ºc truy vÃ¡ÂºÂ¥n Ã„â€˜Ã¡ÂºÂ§u tiÃƒÂªn:

- `local` chÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n DATABASE_URL loopback.
- `production` tÃ¡Â»Â« chÃ¡Â»â€˜i loopback.
- TrÃƒÂªn Vercel, `QLEAD_ENVIRONMENT` bÃ¡ÂºÂ¯t buÃ¡Â»â„¢c; DB production chÃ¡Â»â€° mÃ¡Â»Å¸ cho `VERCEL_ENV=production`. Preview/Development throw dÃƒÂ¹ biÃ¡ÂºÂ¿n cÃƒÂ³ bÃ¡Â»â€¹ lÃ¡Â»â„¢ sang scope Preview (Ã„â€˜ÃƒÂ£ thÃ¡ÂºÂ¥y trÃƒÂªn Preview thÃ¡ÂºÂ­t: "QLEAD_ENVIRONMENT must be set explicitly on Vercel").
- ChÃ¡Â»â€° khai bÃƒÂ¡o `DATABASE_URL` cho scope **Production** trÃƒÂªn Vercel.

`DATABASE_POOL_MAX` (1Ã¢â‚¬â€œ20) Ã„â€˜Ã¡ÂºÂ·t kÃƒÂ­ch thÃ†Â°Ã¡Â»â€ºc pool. `DATABASE_CA_CERT` (PEM CA cÃ¡Â»Â§a Supabase) bÃ¡ÂºÂ­t xÃƒÂ¡c minh TLS Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§.

## 2. Database production (ops/production-db.ts)

Credential Ã„â€˜Ã¡Â»Âc tÃ¡Â»Â« `.env.supabase` (git-ignored), biÃ¡ÂºÂ¿n `PROD_DATABASE_URL`. Script tÃ¡Â»Â« chÃ¡Â»â€˜i host loopback, host khÃƒÂ´ng phÃ¡ÂºÂ£i Supabase, host trÃƒÂ¹ng DB local.

```
npx tsx ops/production-db.ts check | migrate | harden | verify | provision-admin
```

- ChÃ¡Â»â€° ÃƒÂ¡p schema cÃ¡Â»Â§a QLead (`public.*` + `schema_migrations`). KhÃƒÂ´ng Ã„â€˜Ã¡Â»Â¥ng schema do Supabase quÃ¡ÂºÂ£n lÃƒÂ½.
- Hardening (`ops/supabase-harden.sql`): bÃ¡ÂºÂ­t RLS, REVOKE `anon`/`authenticated` trÃƒÂªn mÃ¡Â»Âi bÃ¡ÂºÂ£ng `public` kÃ¡Â»Æ’ cÃ¡ÂºÂ£ bÃ¡ÂºÂ£ng tÃ¡ÂºÂ¡o sau. QLead khÃƒÂ´ng dÃƒÂ¹ng Supabase Data API hay Supabase Auth.
- KhÃƒÂ´ng copy dÃ¡Â»Â¯ liÃ¡Â»â€¡u; `verify` xÃƒÂ¡c nhÃ¡ÂºÂ­n bÃ¡ÂºÂ£ng nghiÃ¡Â»â€¡p vÃ¡Â»Â¥ rÃ¡Â»â€”ng.

Admin: `provision-admin` Ã„â€˜Ã¡Â»Âc **mÃ¡Â»â„¢t** admin local, tÃ¡ÂºÂ¡o user **mÃ¡Â»â€ºi** Ã¡Â»Å¸ production vÃƒÂ  chÃƒÂ©p email + scrypt hash (cÃƒÂ³ salt). KhÃƒÂ´ng cÃƒÂ³ plaintext. Ã„ÂÃ„Æ’ng nhÃ¡ÂºÂ­p giÃ¡Â»â€˜ng nhau; user id, session, dÃ¡Â»Â¯ liÃ¡Â»â€¡u tÃƒÂ¡ch biÃ¡Â»â€¡t. Id admin production chÃ¡Â»â€° Ã„â€˜Ã¡ÂºÂ·t vÃƒÂ o `QLEAD_ADMIN_USER_IDS` cÃ¡Â»Â§a Vercel Production.

## 3. API cÃ¡Â»Â§a Muse trong Next.js (web/lib/server/worker-routes.ts)

KhÃƒÂ´ng viÃ¡ÂºÂ¿t lÃ¡ÂºÂ¡i logic: `workerRoutes()` vÃƒÂ  `wakeSignalRoutes()` Ã„â€˜Ã„Æ’ng kÃƒÂ½ handler lÃƒÂªn mÃ¡Â»â„¢t router tÃ¡Â»â€˜i giÃ¡ÂºÂ£n thay vÃƒÂ¬ Fastify; route handler Next chuyÃ¡Â»Æ’n request vÃƒÂ o Ã„â€˜ÃƒÂºng handler Ã„â€˜ÃƒÂ³ (headers, body JSON Ã¢â€°Â¤ 2 MiB, params, ip tÃ¡Â»Â« `x-forwarded-for` cÃ¡Â»Â§a Vercel; reply.code/header/send). Fastify vÃ¡ÂºÂ«n dÃƒÂ¹ng cÃƒÂ¡c file nÃƒÂ y Ã¡Â»Å¸ local, nÃƒÂªn hai mÃƒÂ´i trÃ†Â°Ã¡Â»Âng chÃ¡ÂºÂ¡y cÃƒÂ¹ng mÃ¡Â»â„¢t code claim/lease/ingest.

TÃ†Â°Ã†Â¡ng thÃƒÂ­ch serverless (Ã„â€˜ÃƒÂ£ kiÃ¡Â»Æ’m tra code):

| HÃ¡ÂºÂ¡ng mÃ¡Â»Â¥c | CÃ†Â¡ chÃ¡ÂºÂ¿ | Serverless |
|---|---|---|
| Job Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³ 30 phÃƒÂºt | `enqueueDueJobs` sinh slot lÃ†Â°Ã¡Â»Âi trong transaction cÃ¡Â»Â§a `/claim` | OK, khÃƒÂ´ng timer |
| Wake generation | tÃƒÂ­nh tÃ¡Â»Â« DB, hash tÃ¡ÂºÂ¥t Ã„â€˜Ã¡Â»â€¹nh | OK |
| Claim/lease | `FOR UPDATE` worker + `FOR UPDATE SKIP LOCKED` job, 1 transaction/request | OK vÃ¡Â»â€ºi transaction pooler |
| Advisory lock, LISTEN, prepared statement cÃƒÂ³ tÃƒÂªn, SET session | khÃƒÂ´ng dÃƒÂ¹ng | OK |
| Initial Discovery / Early Follow-up | enqueue trong transaction lÃ†Â°u hÃ¡Â»â€œ sÃ†Â¡ / nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ | OK |
| Recovery | lease hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n xÃ¡Â»Â­ lÃƒÂ½ lÃ†Â°Ã¡Â»Âi lÃƒÂºc claim; phase 5/15 phÃƒÂºt tÃƒÂ­nh theo thÃ¡Â»Âi gian | OK |
| Ingest idempotent | `scan_id` + `attempt_no` + unique constraint | OK (E2E kiÃ¡Â»Æ’m lost-ack retry) |
| Rate limit wake / Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p | Map trong process | Theo instance; nÃƒÂªn thÃƒÂªm Vercel Firewall rule |

HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng API giÃ¡Â»Â¯ nguyÃƒÂªn (xem SHARED_WORKERS.md): `GET /api/worker/status`, `POST /api/worker/jobs/claim`, `POST /api/worker/jobs/:jobId/results`, `POST /api/worker/jobs/:jobId/failure`, `GET /api/public/worker-wake`, `GET /api/public/worker-dispatch`, `GET /health`. API agent cÃ…Â© `/api/agent/*` chÃ¡Â»â€° cÃƒÂ³ Ã¡Â»Å¸ local.

KiÃ¡Â»Æ’m thÃ¡Â»Â­: `web/e2e/worker-routes-e2e.mts` (DB test riÃƒÂªng, Next dev) 13/13; backend `npm test` trÃƒÂªn DB test riÃƒÂªng 116 pass / 2 skip; test mÃƒÂ´i trÃ†Â°Ã¡Â»Âng + dispatcher 5/5.

## 4. Muse: mÃ¡Â»â„¢t Hook, hai mÃƒÂ´i trÃ†Â°Ã¡Â»Âng

RÃƒÂ ng buÃ¡Â»â„¢c (HOOK_OPERATIONS.md, WAKE_SIGNAL_POC.md): Muse khÃƒÂ´ng cÃƒÂ³ API; Hook GET mÃ¡Â»â„¢t URL cÃƒÂ´ng khai, lÃ†Â°u generation, Ã„â€˜ÃƒÂ¡nh thÃ¡Â»Â©c agent; agent dÃƒÂ¹ng connector cÃƒÂ³ Bearer credential. Endpoint wake Ã¡ÂºÂ©n danh nÃƒÂªn chÃ¡Â»â€° mÃ¡Â»â„¢t Hook Ã„â€˜Ã†Â°Ã¡Â»Â£c poll.

Dispatcher `GET https://qlead.vercel.app/api/public/worker-dispatch`:

1. Production cÃƒÂ³ viÃ¡Â»â€¡c Ã¢â€ â€™ `{"wake":true,"environment":"production","generation":"production:<hash>"}`.
2. KhÃƒÂ´ng cÃƒÂ³, vÃƒÂ  `QLEAD_DISPATCH_SECONDARY_WAKE_URL` (= `<ngrok>/api/public/worker-wake`, chÃ¡Â»â€° HTTPS, khÃƒÂ´ng query/credential) Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡ÂºÂ·t Ã¢â€ â€™ Ã„â€˜Ã¡Â»Âc tÃƒÂ­n hiÃ¡Â»â€¡u local, timeout 3 giÃƒÂ¢y Ã¢â€ â€™ `{"wake":true,"environment":"local","generation":"local:<hash>"}`.
3. CÃƒÂ²n lÃ¡ÂºÂ¡i Ã¢â€ â€™ `{"wake":false}`. MÃƒÂ¡y dev tÃ¡ÂºÂ¯t = im lÃ¡ÂºÂ·ng.

Ã„ÂÃ¡ÂºÂ£m bÃ¡ÂºÂ£o: production Ã†Â°u tiÃƒÂªn; credential tÃƒÂ¡ch theo DB (credential bÃƒÂªn nÃƒÂ y gÃ¡Â»Â­i sang bÃƒÂªn kia Ã¢â€ â€™ 401); job id chÃ¡Â»â€° tÃ¡Â»â€œn tÃ¡ÂºÂ¡i trong DB cÃ¡Â»Â§a nÃƒÂ³ nÃƒÂªn khÃƒÂ´ng thÃ¡Â»Æ’ ghi chÃƒÂ©o kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£; generation cÃƒÂ³ tiÃ¡Â»Ân tÃ¡Â»â€˜ mÃƒÂ´i trÃ†Â°Ã¡Â»Âng; lease + SKIP LOCKED chÃ¡Â»â€˜ng claim trÃƒÂ¹ng; dispatcher chÃ¡Â»â€° Ã„â€˜Ã¡Â»Âc boolean + marker cÃƒÂ´ng khai.

Prompt agent khi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜ÃƒÂ¡nh thÃ¡Â»Â©c:

```
NÃ¡ÂºÂ¿u environment = "production": dÃƒÂ¹ng connector "QLead Worker Production".
NÃ¡ÂºÂ¿u environment = "local": dÃƒÂ¹ng connector "QLead Worker" (ngrok).
KhÃƒÂ´ng bao giÃ¡Â»Â dÃƒÂ¹ng credential cÃ¡Â»Â§a mÃƒÂ´i trÃ†Â°Ã¡Â»Âng nÃƒÂ y cho mÃƒÂ´i trÃ†Â°Ã¡Â»Âng kia.
Claim tÃ¡Â»â€˜i Ã„â€˜a 1 job (max_jobs: 1), rÃ¡Â»â€œi claim Ã¢â€ â€™ tÃƒÂ¬m Ã¢â€ â€™ results/failure nhÃ†Â° cÃ…Â©.
LÃ†Â°u generation (kÃƒÂ¨m tiÃ¡Â»Ân tÃ¡Â»â€˜) trÃ†Â°Ã¡Â»â€ºc khi chÃ¡ÂºÂ¡y; khÃƒÂ´ng chÃ¡ÂºÂ¡y lÃ¡ÂºÂ¡i generation Ã„â€˜ÃƒÂ£ lÃ†Â°u.
```

KÃƒÂ­ch hoÃ¡ÂºÂ¡t (cÃ¡ÂºÂ§n owner duyÃ¡Â»â€¡t, theo thÃ¡Â»Â© tÃ¡Â»Â±; chÃ†Â°a lÃƒÂ m bÃ†Â°Ã¡Â»â€ºc nÃƒÂ o):

1. `https://qlead.vercel.app/health` = ok.
2. Owner tÃ¡Â»Â± tÃ¡ÂºÂ¡o worker production trong terminal cÃ¡Â»Â§a mÃƒÂ¬nh: Ã„â€˜Ã¡ÂºÂ·t `DATABASE_URL=<Supabase>` vÃƒÂ  `QLEAD_ENVIRONMENT=production` rÃ¡Â»â€œi `npm run cli -- create-worker --name "Muse Production"`; credential in mÃ¡Â»â„¢t lÃ¡ÂºÂ§n, dÃƒÂ¡n thÃ¡ÂºÂ³ng vÃƒÂ o connector mÃ¡Â»â€ºi `QLead Worker Production`; `npm run cli -- worker-set Ã¢â‚¬Â¦` Ã„â€˜Ã¡Â»Æ’ active.
3. GÃ¡Â»Âi `/api/worker/status` mÃ¡Â»â„¢t lÃ¡ÂºÂ§n bÃ¡ÂºÂ±ng connector mÃ¡Â»â€ºi (khÃƒÂ´ng claim).
4. (TÃƒÂ¹y chÃ¡Â»Ân) Ã„â€˜Ã¡ÂºÂ·t `QLEAD_DISPATCH_SECONDARY_WAKE_URL` Ã¡Â»Å¸ Vercel Production.
5. Ã„ÂÃ¡Â»â€¢i URL cÃ¡Â»Â§a **Hook hiÃ¡Â»â€¡n cÃƒÂ³** sang `/api/public/worker-dispatch` + cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t prompt. KhÃƒÂ´ng tÃ¡ÂºÂ¡o Hook thÃ¡Â»Â© hai.

## 5. Vercel (project `qlead`)

Root Directory `web`, framework Next.js. `web/vercel.json` cÃƒÂ i thÃƒÂªm deps gÃ¡Â»â€˜c (`npm ci --prefix ..`, gá»“m cáº£ @types/pg cho bÆ°á»›c type-check) vÃƒÂ¬ `web` import `../src` (zod, pg, dotenv).

BiÃ¡ÂºÂ¿n mÃƒÂ´i trÃ†Â°Ã¡Â»Âng, scope **Production** only:

| BiÃ¡ÂºÂ¿n | GiÃƒÂ¡ trÃ¡Â»â€¹ |
|---|---|
| `QLEAD_ENVIRONMENT` | `production` |
| `DATABASE_URL` | Supabase transaction pooler (6543), cÃƒÂ³ mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u |
| `DATABASE_POOL_MAX` | `3` |
| `QLEAD_ADMIN_USER_IDS` | id admin production |
| `QLEAD_WORKER_PUBLIC_URL` | `https://qlead.vercel.app` |
| `ENABLE_DEV_QUICK_LOGIN` | `false` |
| `DATABASE_CA_CERT` | (khuyÃ¡ÂºÂ¿n nghÃ¡Â»â€¹) CA Supabase |
| `QLEAD_DISPATCH_SECONDARY_WAKE_URL` | (tÃƒÂ¹y chÃ¡Â»Ân) URL wake local |

KhÃƒÂ´ng cÃƒÂ³ `NEXT_PUBLIC_*`. Session: cookie `qlead_session` HttpOnly, Secure, SameSite=Lax, 7 ngÃƒÂ y, hash trong `web_sessions`. Production domain phÃ¡ÂºÂ£i cÃƒÂ´ng khai (Deployment Protection chÃ¡Â»â€° cho Preview) Ã„â€˜Ã¡Â»Æ’ Muse gÃ¡Â»Âi Ã„â€˜Ã†Â°Ã¡Â»Â£c.
