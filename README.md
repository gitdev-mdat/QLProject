# Muse Local Bridge

Local Fastify API and PostgreSQL store for independent Muse agents. Muse continues to schedule scans and search Facebook; this service manages per-agent configuration, result ingestion, deduplication, and synchronization history.

## Prerequisites

- Windows 10/11, Docker Desktop (Linux engine running), Node.js LTS and npm, PowerShell.
- Optional `cloudflared` for Muse access through a temporary HTTPS tunnel.

The API binds to `127.0.0.1:8787`. PostgreSQL binds only to `127.0.0.1:55432`. Admin operations use a local CLI connected directly to the database; there is no HTTP admin endpoint.

## Start

From this directory in PowerShell, run the helper to start Docker Desktop if needed, wait for PostgreSQL, apply pending migrations, and open persistent terminals for the API and ngrok:

```powershell
.\start-dev.ps1
```

The helper does not seed data or reset the database. It reuses an existing API or ngrok tunnel when possible. Set up `.env` and install npm dependencies once for a fresh checkout. In PowerShell, check `Invoke-RestMethod http://127.0.0.1:8787/health`; expected values are `status: ok` and `database: connected`. Database port 5432 is mapped to loopback port 55432 to avoid a common conflict. If 55432 is occupied, change the host side of the Compose port mapping and the port in `.env`.

## Create users, agents, and configs

Convenience seed creates Test User A / Muse A and Test User B / Muse B, configures the requested filters, and prints each fresh credential once:

```powershell
npm run seed
```

Save credentials privately. Only hashes are stored in PostgreSQL; lost credentials must be revoked and replaced. Alternatively run commands individually, copying IDs from each response:

```powershell
npm run cli -- create-user --name "Test User A"
npm run cli -- create-user --name "Test User B"
npm run cli -- create-agent --user <USER_A_UUID> --name "Muse A"
npm run cli -- create-agent --user <USER_B_UUID> --name "Muse B"
npm run cli -- set-config --agent <AGENT_A_UUID> --keywords "quán cafe sắp khai trương" --location "TP.HCM" --frequency 30
npm run cli -- set-config --agent <AGENT_B_UUID> --keywords "đại lý phân phối mỹ phẩm" --location "Hà Nội" --frequency 30
```

Separate multiple keywords with `|`. Each config update creates the next version. `user_id` in Muse results is untrusted metadata and never determines ownership.

## Verify and inspect

```powershell
npm test
npm run cli -- scans
npm run cli -- posts --user <USER_UUID>
npm run cli -- status
npm run cli -- status --agent <AGENT_UUID>
npm run cli -- revoke --agent <AGENT_UUID>
```

Tests use representative synthetic data. They exercise both agent identities/configs, ownership, same URL across agents, same-scan retries, URL deduplication, unauthorized requests, config version independence, empty scans, lost-ack retry, and records across a fresh database connection. They do not represent real Muse account activity or a Docker volume restart.

## API and reliability

- `GET /health` reports API/database readiness.
- `GET /api/agent/config`, `GET /api/agent/status`, paginated `GET /api/agent/posts`, and `POST /api/agent/results` require `Authorization: Bearer <AGENT_TOKEN>`.
- `GET /api/agent/posts?limit=50&offset=0` returns only records owned by the authenticated agent. It adds evidence-based contact/location extraction and linked scan-config summaries where available. It is an agent API, not a browser-user API; never expose the token in frontend code.
- Migration `003_post_search_config_associations.sql` records post-to-config associations for future result batches. Existing records are not assigned a config retroactively when the originating version cannot be verified.
- JSON payload limit is 2 MiB; each scan accepts up to 1,000 posts.
- Database writes and acknowledgment values are committed atomically. Retries with the same agent and `scan_id` return the original acknowledgment. Normalized Facebook URL uniqueness is per agent, allowing the same post to exist independently for both agents.

Production build: `npm run build`; then `npm start`.

## Cloudflare Quick Tunnel

If not installed, install the official Windows package with:

```powershell
winget install -e --id Cloudflare.cloudflared
```

Open a new PowerShell window and verify:

```powershell
cloudflared --version
```

If Windows does not find it on `PATH`, run the installed executable directly or add its install directory to `PATH`. A manual download is also available from [Cloudflare's official downloads page](https://developers.cloudflare.com/tunnel/downloads/).

With the API running, open another PowerShell window and execute:

```powershell
cloudflared tunnel --url http://localhost:8787
```

Use only the actual HTTPS URL printed by `cloudflared`; keep that process running. Verify it with `Invoke-RestMethod https://ACTUAL-URL.trycloudflare.com/health`, substituting the printed host. Quick Tunnel URLs are temporary and may change after restart. The tunnel forwards only to the API. PostgreSQL stays bound to loopback, admin commands are CLI-only, and agent API requests still require credentials. Do not enable interactive Cloudflare Access authentication. The tunnel was not tested if `cloudflared` is unavailable.

Use the prompt in [MUSE_HANDOFF.md](MUSE_HANDOFF.md) separately for each Muse account. Replace its URL with the live tunnel URL and securely configure each account with its own credential. This project does not modify Muse accounts or schedules.

## Stop and preserve data

Run `.\stop-dev.ps1` to close only the API and tunnel terminals created by `start-dev.ps1`; PostgreSQL and its named volume stay running. Alternatively, close the API and tunnel terminals individually. Stop PostgreSQL with `docker compose down`; this preserves the named volume. Restart with `.\start-dev.ps1`. `docker compose down -v` deletes the database volume and stored records.

Windows sleep suspends Docker, the API, and ngrok, so Muse requests will fail until the computer wakes and the services reconnect. Shutdown or restart ends the API and tunnel; Docker Desktop may restart PostgreSQL on the next sign-in depending on its startup setting. Closing the API terminal stops the API and public health checks; closing the ngrok terminal stops public access while the local API can continue. Keep both terminals open while Muse is using the integration.
