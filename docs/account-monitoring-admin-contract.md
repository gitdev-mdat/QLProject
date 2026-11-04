# Account lead monitoring: Admin API contract

The customer account remains usable while lead monitoring is suspended. The `users.lead_monitoring_status` field is the source of truth (`active` or `suspended`); new and existing accounts default to `active` after migration 013.

## Admin authorization

All routes require the existing QLead session and `QLEAD_ADMIN_USER_IDS` server-side allowlist. A customer gets `404` from Admin APIs. Mutations also require a same-origin `Origin` and `x-qlead-admin: 1`. Never send a role or actor id in the request body. Responses use `Cache-Control: no-store`.

## Endpoints

- `GET /api/admin/users?page=1&limit=50&q=` — returns `{ users, total, limit, offset }`. `limit` is 1–100. Search matches display name, account email, or exact user UUID. Each row includes status/change audit and profile, lead, scan, pending, and claimed counts.
- `GET /api/admin/users/:userId` — returns account status/audit, aggregate counts, and profile summaries. It does not return password hashes, worker credentials, job payloads, or lead contents.
- `PATCH /api/admin/users/:userId/monitoring` with `{ "status": "suspended", "reason": "..." }` or `{ "status": "active" }` — idempotently changes monitoring and records the authenticated Admin user and timestamp. A suspension response includes `inFlightJobCount`; those valid leases may still finish. Reactivation retains the most recent suspension audit.

Example browser mutation:

```ts
await fetch(`/api/admin/users/${userId}/monitoring`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' },
  body: JSON.stringify({ status: 'suspended', reason: 'Requested by account owner' }),
});
```

The browser must not provide an Admin identity. The server obtains it from the session. Display `inFlightJobCount` as work already assigned that may complete; it does not mean future work remains enabled.

## Customer contract

- `GET /api/account/monitoring` returns only `{ "status": "active" | "suspended" }` for the signed-in account.
- The app shell refreshes that state every 30 seconds and shows an account-level suspension notice. Suspended users can still sign in and see saved leads/scans.
- Manual scan requests return a `scan.outcome` of `suspended` and do not enqueue work. An already claimed job can finish and have its results accepted.
- Profile pause flags and saved search configuration are unchanged by suspension. Reactivation restores ordinary eligibility through the existing shared worker schedule and creates at most the current due slot; it does not create one job per missed interval.
