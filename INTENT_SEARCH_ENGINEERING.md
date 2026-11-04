# QLead intent search implementation report

## Existing architecture audit

- Fastify exposes `/health`, agent-token-authenticated `GET /api/agent/config`, agent-token-authenticated `GET /api/agent/status`, and agent-token-authenticated `POST /api/agent/results`.
- `scan_configs` is owned by `agent_connection_id`; the current configuration fields are `enabled`, `keywords` (JSON array), `location` (text), `sources` (JSON array), and `frequency_minutes` (1–10080). The agent config response returns those fields plus `version`.
- `facebook_posts` and `scan_runs` are also scoped by agent connection. Agent A/B isolation is enforced by credential-to-agent lookup and existing integration tests.
- No end-user login/session routes, user-facing config read/write routes, or user-owned intent storage exist. Existing browser auth screens are preview flows and must not receive agent credentials. Adding persistence from the browser would violate the current tenant boundary.
- The repo documents `social.search` as the current source identifier and 30 minutes as the established schedule. There is no verified search-provider contract for industry, event stage, regional coverage, independent query execution, ranking, or alerts.

## Structured intent and normalization

`src/search-intent.ts` defines a strict Zod schema with `user_request`, `industries`, `business_types`, `intent_signals`, `included_locations`, `excluded_conditions`, `search_keywords`, `search_source`, `frequency_minutes`, and `enabled`. It trims and de-duplicates string arrays, rejects unknown fields, and bounds list sizes and frequency.

`interpretSearchRequest` recognizes a deliberately small, deterministic Vietnamese vocabulary for food and beverage, common business types, opening stages, and named regions/cities. F&B expands to cafés, restaurants, milk tea shops, bakeries, and food shops. Unknown text stays ambiguous instead of gaining invented conditions. Conflicting stage or location signals produce review warnings.

`toLegacyScanConfig` projects the structured intent to the existing Muse shape: `enabled`, `keywords`, `location`, `sources`, and `frequency_minutes`. It rejects an empty query or missing location. It does not write the configuration or change the database contract.

## Search-planning behavior

`planSearchQueries` builds focused business-type/stage phrases with explicit region suffixes, de-duplicates them, and caps the query budget at ten (five in the UI). `deduplicateSearchResults` uses stored normalized URLs when available. `evaluatePostAgainstIntent` compares available text to structured conditions and explicit exclusions. Missing evidence, including unknown location, returns `review`; an explicit excluded condition or explicit out-of-region location can return `exclude`.

These are local planning helpers only. They do not call Facebook or Muse and do not establish that Muse runs every phrase independently. The current agent contract can receive a keyword array and a location string, but real execution semantics and query limits must be verified in Muse before enabling a real scan.

## Implemented UX and integration boundary

- The landing hero now demonstrates the combined “quán F&B sắp khai trương ở miền Nam” request, parsed industry/business types/stage/region, an editable region, and one simulated example post. The whole interactive card has one “Xem thử” label.
- `/app/bo-loc` now provides natural-language description, contextual examples, editable structured conditions, progressive disclosure for exclusions/frequency, bounded planned phrases, and a compatible config preview.
- The UI action validates and projects the intent, then clearly reports that persistence is unavailable. No fake successful save, real scan, or notification is shown.
- `scan_configs`, Agent A/B data, current 30-minute defaults, credentials, endpoint paths, and Muse connectors are unchanged.

## Pending for a verified Phase B/C integration

1. Add end-user authentication and tenant-scoped intent/config endpoints. Map each signed-in user to only their authorized agent connection; never use `user_id` from a client payload as ownership evidence.
2. Add additive persistence for the structured intent (or an equivalent versioned JSON field) under the authenticated tenant and agent, plus migration and isolation tests.
3. Confirm with the actual Muse agent how `keywords`, `location`, `sources`, configuration version, and 30-minute scheduling are interpreted. Confirm whether list entries are separate searches and whether location is used in retrieval or only metadata.
4. Only after capability verification, wire the derived config to Muse, compare expanded result sets, and tune the bounded budget/relevance policy. No complete Facebook coverage is guaranteed.
5. Implement notification delivery and verify its real channel separately before presenting alerts as active.
