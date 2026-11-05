# QLead Web Push Backend (F03)

Backend implementation for Claude's Phase 1 PWA. It does not modify the service worker or UI.

## API contract

All JSON responses use `Cache-Control: no-store`. User routes require the `qlead_session` session. State-changing routes require a same-origin `Origin`/`Host` pair. The subscription routes are scoped to the current user **and session**, so a shared browser cannot read or remove another account's device subscription.

| Method and path | Request | Success | Other responses |
| --- | --- | --- | --- |
| `GET /api/push/config` | session cookie | `200 {"enabled":true,"vapidPublicKey":"…"}` | `200 {"enabled":false}` when server push config is incomplete; `401` |
| `PUT /api/push/subscription` | `{subscription:{endpoint,expirationTime,keys:{p256dh,auth}},platform,standalone,origin}` | `200 {"subscribed":true}` | `400 invalid_request`, `401 unauthorized`, `403 forbidden`, `503 push_not_configured` |
| `POST /api/push/subscription/status` | `{endpoint}` | `200 {"subscribed":boolean}` | `400`, `401`, `403` |
| `DELETE /api/push/subscription` | `{endpoint}` | `200 {"subscribed":false}` | `400`, `401`, `403` |
| `POST /api/push/test` | `{endpoint}` | `202 {"sent":true}` means the push service accepted the request | `404 not_subscribed`, `429 too_many_requests` with `retryAfterSeconds:30`, `502 push_failed`, `503 push_not_configured` |
| `GET /api/push/preferences` | session cookie | `200 {"newLeads":boolean}` | `401` |
| `PUT /api/push/preferences` | `{newLeads:boolean}` | `200 {"newLeads":boolean}` | `400`, `401`, `403` |

The preferences API is optional for Phase 1. Phase 1 turns notifications on/off by registering/removing that device; the account-wide preference is available for an explicit future control. `config.enabled` reports whether the server is configured, not the signed-in user's preference.

Registration is idempotent by a SHA-256 endpoint hash. The encrypted subscription (endpoint and Web Push keys) is stored with AES-256-GCM; the raw endpoint and keys are never returned or logged. Only HTTPS endpoints from the supported browser push services are accepted. `origin` must match the browser `Origin` and the server allowlist (`https://qlead.vercel.app`, `https://qlead.vn`, or `QLEAD_PUSH_ALLOWED_ORIGINS`). When a live `qlead.vn` subscription exists, it is the sole origin receiving new pushes; otherwise the most recently refreshed active origin is selected. This prevents old and new domains from duplicating notifications during a domain transition.

## New-lead delivery

The worker result transaction counts newly inserted, source-linked posts using the existing trusted config association and receipt timestamp. It writes one outbox event per scan run only when the count is positive, monitoring is active, account notifications are enabled, and at least one unexpired subscription belongs to a live session. Duplicate acknowledgements return before this trigger. A single eligible lead links to `/app/bai-viet/<leadId>`; a batch links to `/app/bai-viet`. Notification text is generic and does not copy post content or customer details.

The transaction commits the scan and outbox together. Next.js `after()` attempts delivery after the response; the protected Vercel Cron retries due events and expired leases. New-lead pushes are coalesced per user for 15 minutes. Transient push-service failures retry after 30, 60, and 120 seconds, with at most three attempts; 404/410 expires and removes the subscription. A retry never changes the Muse result acknowledgment. VAPID Web Push uses `aes128gcm`, TTL 12 hours, normal urgency, and the `new-leads` topic. The Cron processes at most five users per invocation, with up to four device sends concurrently per user.

## Vercel setup and rollout

Configure these server-only Production variables before deployment:

- `VAPID_PUBLIC_KEY` — base64url, uncompressed P-256 public key.
- `VAPID_PRIVATE_KEY` — base64url private key; never use `NEXT_PUBLIC_*`.
- `VAPID_SUBJECT` — an HTTPS contact URI, defaulting to `https://qlead.vercel.app/`; qlead.vn email hosting is not required.
- `QLEAD_WEB_PUSH_ENCRYPTION_KEY` — 32 random bytes encoded as base64, kept stable so existing device subscriptions remain decryptable.
- `CRON_SECRET` — at least 16 random characters; Vercel Cron sends it as `Authorization: Bearer …`.
- Optional `QLEAD_PUSH_ALLOWED_ORIGINS` — comma-separated HTTPS origins to add to the built-in production origins.

Generate the VAPID key pair on a trusted admin machine with `web-push generate-vapid-keys` (or `webpush.generateVAPIDKeys()`), store both values in the team's secret manager, and add them to Vercel Production without pasting them into chat or committing them. Generate the encryption key and cron secret with a cryptographic random generator and store them in the same secret manager. Keep the same VAPID pair across the Vercel and qlead.vn origins.

Apply the additive migration `017_push_notifications.sql` with the normal database migration process **before** deploying this code. It creates private tables with RLS enabled, no Data API policies, and explicit role revokes. Do not run this migration against Production as part of this PR. The project is on Vercel Hobby, which only allows a daily Cron, so `vercel.json` schedules `/api/cron/push-drain` once a day as a backstop. Immediate sends run in `after()` when a result is accepted, and due retries are also drained after Muse's own frequent worker/dispatch requests (at most once a minute per instance, after the response; `web/lib/server/worker-routes.ts`). On Pro, the schedule can go back to `* * * * *`.

Rollback: roll back the application deployment and remove the Cron entry if needed; the migration is additive and can remain in place. Do not drop the tables during rollback. Existing scan, job, worker credentials, hooks and histories are unchanged.

## Tests and real device check

Run the test suite only against the repository's dedicated local synthetic PostgreSQL database. Unit tests cover encrypted storage, payload privacy, validation and endpoint policy; integration tests cover the worker-result outbox and delivery against a local fake push endpoint. The real-device check happens only after Claude's service worker/UI is deployed: subscribe a test device at qlead.vercel.app, call its test endpoint, then submit a synthetic eligible result through the isolated test environment. A `202` confirms acceptance by a push service, not receipt or display on a device.
