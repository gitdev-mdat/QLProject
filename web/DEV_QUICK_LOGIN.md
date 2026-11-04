# DEV quick login and web sessions

## What exists

- `web_sessions` table (migration `004_web_sessions.sql`, additive). Stores only a SHA-256 hash of the session token.
- Cookie `qlead_session`: HttpOnly, Secure, SameSite=Lax, 7 days. Logout (`POST /api/auth/logout`) revokes the row server-side.
- Every `/app` route checks the session in `app/app/layout.tsx` and on each page; data is read from Postgres in
  `lib/server/leads.ts`, always filtered by `agent_connections.user_id` of the signed-in user. Other users' posts return 404.
- Email/password login is **not implemented**; the normal form says so. `created_via = 'password'` is reserved for it.

## DEV quick login gates (`lib/dev-login-gate.ts`, `app/api/dev-login/route.ts`)

All must hold, checked on the server for the page render and again on the POST:

1. `NODE_ENV === 'development'` (only `next dev`; `next build`/`next start` are always `production`).
2. `ENABLE_DEV_QUICK_LOGIN=true` in `web/.env.development.local` (git-ignored; Next does not load it in production).
3. `Host` is `localhost`, `127.0.0.1` or `[::1]`; any `x-forwarded-for` hop is loopback; no proxy/tunnel headers
   (`forwarded`, `x-real-ip`, `ngrok-trace-id`, `via`, …).
4. POST only: `Origin` equals `Host` and header `x-qlead-dev-login: 1` (CSRF).
5. The account must be listed in `DEV_QUICK_LOGIN_USERS` and already exist in `users`; nothing is created.

`npm run dev` binds Next to `127.0.0.1`. The ngrok tunnel (`start-dev.ps1`) forwards only to Fastify on 8787,
which has no dev-login route. Any failed gate returns 404.

## Local use

```
cd web
npm run dev -- -p 3001
```

Open http://127.0.0.1:3001/dang-nhap and click **Test User A** or **Test User B**.

## Tests

- Unit: `npm test` at the repo root runs `test/dev-login-gate.test.ts` (production with the flag set must fail closed).
- E2E: with the dev server running, `npm run test:e2e -- http://127.0.0.1:3001` (uses installed Chrome via playwright-core).
  Set `PROD_URL` to a running production build to include the production checks.

## Before deploying

1. Build with `npm run build`; confirm `NODE_ENV` is `production` on the server.
2. Do not copy `.env.development.local`; do not set `ENABLE_DEV_QUICK_LOGIN` or `DEV_QUICK_LOGIN_USERS`.
3. Run `PROD_URL=<staging url> npm run test:e2e` or at least:
   `curl -X POST <url>/api/dev-login -H "origin: <url>" -H "x-qlead-dev-login: 1"` → must be **404**, and `/dang-nhap` must not contain "Đăng nhập nhanh (DEV)".
4. Optionally delete `app/api/dev-login` and `lib/server/dev-users.ts` from the deploy branch entirely.
