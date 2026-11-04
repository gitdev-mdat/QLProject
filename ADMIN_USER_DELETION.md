# Admin account deletion

## Data ownership found

Schema relationships in migrations 001–014:

- `users` owns `user_accounts`, `web_sessions`, `agent_connections`, `lead_states`, `lead_notes`, and `facebook_group_requests` through `ON DELETE CASCADE`.
- `agent_connections` owns `scan_configs`, `scan_runs`, and `facebook_posts`; their dependent `facebook_post_search_configs` and `search_jobs` cascade. `search_job_attempts` cascade from `search_jobs`.
- `search_jobs.claimed_by_worker_id` points to global `muse_workers` with `ON DELETE SET NULL`; deletion does not remove workers. Attempts reference workers with `ON DELETE RESTRICT`, but deleting the user's jobs cascades their attempts first.
- `scan_runs.search_job_id`, `scan_configs.created_by_user_id`, `search_jobs.requested_by_user_id`, `facebook_group_requests.reviewed_by_user_id`, the account monitoring actor IDs, and `worker_handoffs.created_by_user_id` use `ON DELETE SET NULL` where they reference a user.
- The new deletion audit stores actor UUID, target UUID, time and result only. Target UUID intentionally has no FK so the audit survives deletion. Actor FK is `ON DELETE SET NULL`; no name, email, query, post content or credential is retained.

The local configured database was `muse_bridge` at `127.0.0.1:55432`, but PostgreSQL was unavailable during this implementation. Therefore the live `pg_constraint` catalog could not be queried. The relationship list above is verified from the checked-in migrations, not presented as a live-schema inspection.

## API

- `GET /api/admin/users/:userId/deletion`: admin-only, same session authorization as other Admin APIs; returns fresh impact counts and active lease blockers. `Cache-Control: no-store`.
- `POST /api/admin/users/:userId/deletion`: same-origin plus `x-qlead-admin: 1`, JSON `{ "confirmUserId": "<same UUID as path>" }`. UUID confirmation prevents stale selection. Success returns `{ deleted: true, impact }`.
- `409 active_jobs`: lists only the target's profile name and lease expiry, with a fresh preview; no job IDs, queries or post content.
- Self deletion is rejected. Any ID in `QLEAD_ADMIN_USER_IDS` is protected. Invalid/stale IDs fail closed.

Deletion locks the target `users` row, then rechecks valid claimed leases and counts inside the same transaction. The worker claim query locks that same user row with `SKIP LOCKED`, so new claims skip a deletion-locked account; claims that already hold it finish first and are then seen as active leases. The user delete and cascades are atomic. Unclaimed pending work, scans and posts owned through the account's profiles are removed. Global workers and unrelated tenants remain.

## Migration and rollout

Migration `014_admin_user_deletion_audit.sql` is required. It is registered with the normal migration runner but was **not** applied to the live database. Before enabling the feature, back up the database, inspect migration history/schema, then apply `npm run migrate` in the approved maintenance window. Do not invoke the admin delete API before 014 is applied.

Run backend tests against an empty isolated database whose name includes `test`, with all migrations applied. `test/admin-user-deletion.test.ts` deliberately skips any non-test database and never manufactures or deletes a live account. It covers empty and populated accounts, duplicate display names, absent login email, credentials/sessions, valid lease conflicts, claim serialization, tenant/worker preservation, audit, repeated requests and rollback.

## Claude handoff

1. Review this file and migration 014. Do not apply it to production/live data without an explicit migration task and backup.
2. Start PostgreSQL and create/use a dedicated empty test database (not `muse_bridge`); apply migrations there and run `npm test` plus both builds.
3. Review `/admin/users` confirmation UX and API auth in a browser with a dedicated Admin test account.
4. Before any real account removal, select by immutable UUID, inspect the preview, confirm no active lease, and have the owner independently confirm the exact UUID. Never infer disposability from a display name.
5. Do not delete any existing account as part of verification.
