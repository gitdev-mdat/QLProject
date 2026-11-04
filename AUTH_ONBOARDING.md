# Registration, onboarding and session isolation

## Root cause (P0 "Ngành khác" → Test User A)

1. **Registration was demo-only.** `web/components/auth-demo-form.tsx` (line 14 before this change): on submit, `if (mode === 'register') window.location.assign('/bat-dau')`. Nothing was sent, no user or session was created.
2. **`/bat-dau` was a public demo.** `web/app/bat-dau/page.tsx` rendered `Onboarding` from `dashboard.tsx` with no session check and a "Bản xem thử" notice.
3. **"Ngành khác? Tự mô tả khách hàng" was a plain link** to `/app/bo-loc` (`dashboard.tsx`, old line 144), and the last step linked to `/app`.
4. **The browser still held a valid DEV session cookie.** `/app` requires a session (`app/app/layout.tsx` → `requireSession`). The `qlead_session` cookie from an earlier DEV quick login as Test User A was valid for 7 days (live DB showed 8 unrevoked `dev_quick_login` sessions created that day). So `/app/bo-loc` correctly showed the user that cookie belonged to.
5. **No fallback existed.** `getSession` only resolves the cookie's token hash; there is no default user. But `createSession` did not revoke an earlier session, and `/dang-nhap` silently redirected a signed-in browser to `/app`.

Ownership scoping itself was correct: every lead, profile and scan query filters on the session's `user_id`.

## What changed

- `migrations/010_user_accounts.sql` (additive): `user_accounts(user_id, email unique lowercase, password_hash 'scrypt$…', onboarding_completed_at)`. Applied to `muse_bridge` and `muse_bridge_test`. DEV and CLI users have no row and cannot use a password.
- `web/lib/server/accounts.ts`: scrypt (N=16384, r=8, p=1, 16-byte salt) hashing, constant-cost verify for unknown emails, in-process limit of 10 attempts per email+client per 15 minutes, `needsOnboarding`.
- `POST /api/auth/register`, `POST /api/auth/login` (same-origin only). Both create a `password` session.
- `createSession` now revokes the session the browser already carries before issuing a new one (applies to DEV login too).
- `/dang-nhap` and `/dang-ky` no longer redirect a signed-in browser. They show "Trình duyệt đang đăng nhập với tên X… Tiếp tục với X", and signing in or registering replaces that session.
- `/bat-dau` (real onboarding): no session leads to `/dang-ky`; an account that is already set up goes to `/app`. `components/onboarding.tsx`:
  - Step 1: industry cards prefill the description; "Ngành khác" opens the same description box in place.
  - Step 2: review the suggested name, area, frequency and search phrases.
  - Step 3: summary, choose whether to enable, then save.
  - The draft is kept per user in the browser, so stepping back or reloading keeps it.
- `POST /api/onboarding`: in one transaction, creates the first profile only if the user has none, and marks onboarding complete. Repeat submits return `created: false`.
- `/app` layout sends a web-registered account without a profile back to `/bat-dau`.
- `components/auth-demo-form.tsx` is renamed `auth-screen.tsx`, and the old demo onboarding is removed from `dashboard.tsx`.

## Verification

- `web/e2e/accounts-e2e.mts` (test DB, one browser context per scenario, only this run's `e2e-acct-<run>-*@qlead.test` users and one seeded DEV seller are created and deleted): **17/17**.
  - Scenario A covers new customer registration, "Ngành khác" in place, back and forth, save, an empty dashboard, refresh, logout and login.
  - B: explicit DEV login.
  - C: cross-user URL and API attempts, plus a DEV session revoked by registering.
  - D: resume an unfinished onboarding, no duplicate profile, returning customer.
  - E: signed-out access, cross-origin register and login, and a production `next start` with `ENABLE_DEV_QUICK_LOGIN=true` (no DEV box, `/api/dev-login` 404).
  - One run hit a cold-compile "Failed to fetch" in dev mode; the rerun passed.
- `web/e2e/profiles-e2e.mts` 17/17, `web/e2e/qlead-e2e.mjs` 31/31 (live DB, read-only for these flows), backend `npm test` 64/64, type-check and production build pass.
- Screenshots: `docs/account-screenshots/` (1440 and 390).

## Not done

- No email verification or password reset yet.
- The login rate limit is per process, in memory.
