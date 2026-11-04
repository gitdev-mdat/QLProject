# QLead actionable lead results — implementation report

## Existing data contract audit

`facebook_posts` already stores `author`, `title`, `content`, `published_at`, `original_url`, `normalized_url`, `source_type`, `collected_via`, `platform`, `first_seen_at`, and `agent_connection_id`. The prior metadata migration also added `title` and `platform`. There are no phone or geographic columns. The schema does not tie each post to a search configuration; it retains agent ownership only. `scan_runs` stores the scan's configuration version.

Fastify authenticates agent credentials for its config, status, and result routes. There is no authenticated end-user session or dashboard API. PostgreSQL was started locally for migration and integration verification; no crawler or API service was started.

## Changes

- Added an additive `facebook_post_search_configs` association table. New agent result batches associate each post with a configuration version only when that version exists for the authenticated agent. Existing rows are not backfilled because their exact configuration cannot be proven.
- Added agent-authenticated, paginated `GET /api/agent/posts`. SQL is scoped to the authenticated agent connection; it returns only that agent's stored posts and linked configuration summaries. Agent credentials remain server-side and are never embedded in the web app.
- Added a structured lead mapper. It preserves original text, author, post URL, published time, discovery time, source, agent name, and linked search configurations. `published_at` is never replaced with discovery time.
- Phone extraction accepts only numbers adjacent to explicit contact wording and returns the original evidence. Location extraction uses a small explicit city/province vocabulary; multiple mentions stay ambiguous. Need text is an exact post sentence selected by request language, or remains unclassified. Extraction does not use the user's search region to infer the post location.
- Replaced the results feed with a CRM-style desktop table, responsive lead cards, search and filters, post/discovery sorting, copy actions, and a dedicated details page. Landing previews now use generic sample author labels and omit invented dates, phone numbers, and original Facebook URLs.

## Integration boundary

The authenticated agent endpoint is available for trusted agent/service clients. The web app remains in preview mode because it has no user authentication or tenant-scoped web API; it cannot safely call an agent-token endpoint. The current UI explicitly labels its rows as sample data. To show live records in the website, implement end-user authentication and a tenant-scoped dashboard API that maps a signed-in user only to their authorized agent connection. Do not put agent tokens in browser code.

No phone/location database columns were added because both values are safely derived from the already stored content at read time and retain evidence. Migration `003_post_search_config_associations.sql` was applied locally with `npm run migrate`. Existing posts were still 35 after the integration suite; test fixtures were cleaned up, and no exact config associations were backfilled for legacy rows.

## Verification limits

Pure extraction tests cover explicit and absent phone numbers, known/ambiguous/unknown locations, long Vietnamese content, URL-only records, missing publication dates, and discovery-date preservation. All 20 tests passed against the local PostgreSQL instance, including agent scoping, pagination, configuration association, migration repeatability, and preservation of existing Agent A/B state. The production browser currently shows clearly labeled preview rows rather than live DB rows because there is no end-user authentication or tenant-scoped dashboard API; the agent-authenticated API was verified through integration tests.
