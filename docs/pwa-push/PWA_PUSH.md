# QLead F03 — Installable PWA and Web Push (frontend)

QLead stays one Next.js app. No native wrapper, no service-worker framework, no offline caching.

## Pieces

| File | Role |
|---|---|
| `web/app/manifest.ts` | `id: '/'` (unchanged identity), `start_url: '/app'`, `scope: '/'`, standalone, PNG 192/512 + maskable 512 + SVG, shortcut to Danh sách lead |
| `web/app/layout.tsx` | apple-touch-icon 180, `apple-mobile-web-app-*` meta, `viewport-fit=cover` |
| `web/public/icons/*` | GOAT icons rendered from `app/icon.svg` / `public/brand/qlead-goat-full.svg`; `badge-96.png` is the white silhouette Android uses in the status bar |
| `web/public/sw.js` | Push-only worker: `push`, `notificationclick`, `pushsubscriptionchange`. No `fetch` handler, no Cache Storage (and it deletes any cache it finds on activate). `skipWaiting` + `clients.claim`, never reloads pages |
| `web/next.config.ts` | `/sw.js` is `no-store`, JS content type, strict CSP |
| `web/app/mo/route.ts` | Notification tap entry: signed in → lead page; signed out → `/dang-nhap?tiep=/app/…` |
| `web/lib/safe-return.ts` | Only `/app` or `/app/…` paths pass; used by `/mo` and the login `?tiep=` |
| `web/app/app/thong-bao/page.tsx` + `components/pwa-settings.tsx` | "Ứng dụng và thông báo": push card + install card |
| `web/components/pwa-runtime.tsx` | Registers the worker 2 s after load; releases a leftover subscription that the server says belongs to another account; the one-line install hint on Hôm nay |
| `web/lib/install-prompt.ts` | Holds Chromium's `beforeinstallprompt` for a deliberate tap |
| `web/lib/push-client.ts` | Calls the backend contract in `PUSH_API_CONTRACT.md` |
| `web/components/app-shell.tsx` | Bell entry (top bar on phones, sidebar on desktop), install hint mount, logout releases this device's subscription first |

## UX rules implemented

- Nothing asks for anything on page load. The OS permission prompt is requested only inside the "Bật thông báo" click.
- Install hint: phones only, never on the first visit, never when installed, only where the browser really offers a path (Chromium prompt or iOS Safari), "Để sau" hides it for good on that device. Login and onboarding are untouched.
- iPhone in a Safari tab: install first (3 steps: Chia sẻ → Thêm vào MH chính → Thêm; iOS 26 note: ••• → Chia sẻ). iPhone in Chrome/in-app browsers: "open in Safari". Push card says to add to Home Screen first.
- Denied: shows where to allow it per platform and a reload button; never re-prompts.
- On/off state comes from the server (`/api/push/subscription/status`), not a local flag.
- Backend not deployed / no VAPID key: "Thông báo đang được chuẩn bị".

## Tests

`web/e2e/pwa-push-e2e.mts` (33 checks) on a production build, plus the existing `web/e2e/nav-qa.mts` (22 checks) for navigation regressions.
Headless Chromium has no push service, so that script stubs `/api/push/*` per the contract, fakes the PushManager subscription, and delivers pushes to the real `sw.js` with DevTools `ServiceWorker.deliverPushMessage`. Real devices and the real backend are still required for: Android install, iPhone Add to Home Screen, real push delivery, and real notification taps.

## Domain move (qlead.vercel.app → qlead.vn)

Permissions, service workers and push subscriptions are per origin; nothing carries over automatically.

1. Before the move: backend keeps the **same VAPID key pair** and stores `origin` per subscription (contract §10). Add `https://qlead.vn` to the origin allowlist.
2. Make qlead.vn serve the same app **without** redirecting qlead.vercel.app yet. Installed apps and subscriptions on the old origin keep working.
3. On qlead.vn the settings page and install hint show their normal "off / not installed" state, so users re-install and tap "Bật thông báo" once. Optionally show a one-line notice on the old origin pointing to qlead.vn (separate change).
4. Backend stops sending to an old-origin subscription once the same user has an active new-origin one (no double notifications). Notification taps from old-origin workers still open old-origin `/mo`, which works until step 5.
5. After ~30 days (or when old-origin subscriptions stop refreshing), redirect qlead.vercel.app → qlead.vn and delete stale old-origin subscriptions.

No DNS or redirect changes are part of this PR.
