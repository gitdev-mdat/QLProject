# Muse A: ngrok direct HTTP diagnostic (health only)

The ngrok URL is temporary and works only while the local API and ngrok process are running. Current base URL: `https://thrill-snowdrop-primer.ngrok-free.dev`.

## Copy into Muse A

In the existing `Local Lead Bridge` connector, update only its base URL to:

`https://thrill-snowdrop-primer.ngrok-free.dev`

Preserve the connector's existing Agent A credential in its secure credential store. Do not display, copy into this prompt, or report the credential. Update the existing connector; do not create a duplicate.

For this diagnostic, use Muse's **direct HTTP client**, not its Browser tool. Make exactly one unauthenticated request:

`GET https://thrill-snowdrop-primer.ngrok-free.dev/health`

Report the actual HTTP status, response body, response headers, and request time. A healthy response should be HTTP 200 with `{"status":"ok","database":"connected"}`. If the request returns an error—including 403—report the exact status and body, plus available headers such as `Ngrok-Agent-Ips`, `Server`, or `CF-Ray`, then stop. Do not retry repeatedly.

Do not send an Authorization header for `/health`. Do not call `/api/agent/config` yet, use Facebook search, perform a scan, POST results, or change any schedule. Leave POC #5 and all existing automations unchanged. Wait for a separate instruction before testing authenticated config or searching Facebook.

## Facebook post metadata and safe recovery procedure

The results endpoint now accepts both canonical post properties and Muse's existing post shape. It stores `title`, `content` (or `summary`), `author`, `published_at` (or `posted_at`), `source_type`, `collected_via`, and `platform`. When both an alias and its canonical property are present, the canonical property wins. Optional values can be absent or `null`; unknown fields and malformed timestamps are rejected with field-level validation messages.

Metadata recovery is forward-only. Posting an already stored URL with a **new** `scan_id` fills only fields currently null or blank, and never overwrites nonblank values. Repeating the same `scan_id` is idempotent and does not enrich. The API reports `inserted_posts`, `updated_posts`, `duplicates`, and `unchanged_posts`; scan history stores inserted, updated, and unchanged counts. Existing rows stay in place and their new `title` and `platform` columns remain null until the source provides those values.

The Muse acceptance scan `scan-20261029-151835` has already been recorded. If the owner separately authorizes recovery, use a new scan ID and only the exact original post URLs and metadata still available from Muse's existing scan result. Do not fabricate missing data, initiate Facebook search, run a scan, or change connector credentials or schedules as part of recovery. Confirm before submitting any recovery payload. No recovery/enrichment was performed by the backend change itself.

The additive migration has been applied to this workspace's PostgreSQL database. On a fresh or separately restored database, run `npm run migrate` before starting the updated API. The migration adds nullable `facebook_posts.title` and `facebook_posts.platform`, plus `scan_runs.updated_posts` with a zero default; it does not reset or reseed PostgreSQL.
