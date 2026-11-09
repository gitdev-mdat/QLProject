# Lead delivery contract

`GET /api/leads?profile_id=<uuid>&limit=200` returns only leads delivered to the signed-in user's profile. Omit `profile_id` for all sources; use `profile_id=legacy` for historical legacy-agent leads. The server clamps `limit` to 1–200. An unknown or other tenant's profile returns an empty result.

Reading the endpoint can distribute eligible posts already in QLead's database. Delivery is idempotent per profile and the profile's configured monitoring interval; repeated refreshes in that interval reuse the same cycle. It does not schedule a Muse scan. The transaction serializes on the customer account and profile, selects at most the configured cap, and retains every unselected candidate in the queue.

## Response

```json
{
  "leads": [
    {
      "id": "uuid",
      "author": "Business page",
      "title": "Opening soon",
      "content": "...",
      "published_at": "2026-11-08T04:00:00.000Z",
      "deliveredAt": "2026-11-08T05:00:00.000Z",
      "sources": [{ "kind": "profile", "profileId": "uuid", "version": 1 }]
    }
  ],
  "total": 10,
  "delivery": {
    "status": "searching",
    "maxLeadsPerCycle": 10,
    "deliveredThisCycle": 10,
    "queued": 50,
    "nextCycleAt": "2026-11-08T05:30:00.000Z",
    "workerClaimed": false,
    "currentSearchStatus": "queued",
    "worker": {
      "configuredActive": true,
      "lastAuthenticatedAt": "2026-11-08T04:59:00.000Z",
      "lastClaimAt": "2026-11-08T04:58:00.000Z",
      "connectionVerifiedAt": "2026-11-08T04:30:00.000Z"
    }
  }
}
```

`delivery.status` is `ready`, `searching`, `paused`, `suspended`, or `worker_unavailable`. `currentSearchStatus` is `queued`, `running`, `retrying`, `completed`, `failed`, or `null`. `workerClaimed` is based on a current unexpired database lease. Worker timestamps are evidence of authenticated requests and claims; `configuredActive` alone is not a worker health signal. For first-scan and job timing details, use the existing `GET /api/first-scan` `discovery` object, which reads job creation, first claim, scan receipt, and attempt durations from persisted records. Its `searchReady` is `false` when no verified active worker is configured, `true` only while this job has an unexpired claim, and `null` otherwise because QLead cannot observe whether Muse's Hook is currently polling.

## Delivery rules

- `maxLeadsPerCycle` is stored per profile in `lead_distribution_settings`; new profiles default to 10. No billing or plan behavior is implied.
- The cycle key is derived from `scan_configs.frequency_minutes`. A unique `(profile, cycle key)` and database locks prevent refreshes or concurrent workers from exceeding one cap in a cycle.
- Candidates are selected across old queued and newly discovered source-linked posts. Ranking considers profile keyword phrase hits, Facebook post time, active opportunity wording, and available source metadata. Missing post time reduces rank but does not hide an otherwise eligible source-linked post.
- The configurable `expiry_days` defaults to 30. Expired posts remain stored and are marked `expired` in the delivery ledger; history is not deleted.
- Existing source-linked profile history is backfilled as `delivered`, so the migration never redelivers it. Legacy-agent history remains visible under the existing legacy scope.
- Delivery is account- and profile-scoped. A delivered permalink in another search profile or a legacy source is skipped to avoid duplicate customer-visible leads.

## Muse and partial-result limits

Search jobs are immediately visible to Muse's existing polling Hook. The checked-in operations runbook records a 30-second poll interval and one real test run that took about 55 seconds from Hook detection to result acceptance; this is one observed run, not a P95 benchmark or SLA. The API cannot wake Muse directly. `RUNNING` means an unexpired claim exists; a worker marked `ACTIVE` without an unexpired job claim is not reported as running. Worker results are ingested in one result transaction today, so partial result delivery during a scan is not supported by the current Muse contract. This endpoint can deliver stored backlog before another scan completes.
