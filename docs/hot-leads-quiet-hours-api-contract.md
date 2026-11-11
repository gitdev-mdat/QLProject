# Hot Leads, quiet hours, and workflow API contract

This backend contract is additive and intended for the QLead customer experience integration. It does not require a separate scoring service, worker, queue, or database.

## Lead records

`GET /api/leads` keeps its existing response shape and adds `hotAssessments` to each lead:

```ts
type HotLeadAssessment = {
  profileId: string;
  status: 'hot' | 'historical' | 'standard';
  reasonVi: string | null;
  evidence: string | null;
  publishedAt: string | null;
  assessedAt: string | null;
  expiresAt: string | null;
};
```

Assessments are per search profile because relevance depends on that profile's stored keywords and customer description. `hot` means the stored evidence is still within its two hour window and the current source post still has a valid publication time in that window; `historical` means it qualified at discovery but its urgent window has ended or its publication time is no longer verifiable; `standard` means it did not qualify. Consumers should render the server supplied status and reason, not reproduce classification in browser code. Unknown, future, or older than two hour publication times are never Hot. The reason quotes the original source phrase with its Vietnamese accents. Only the source post's title and content can provide intent evidence; Vietnamese summaries and discovery timestamps do not qualify a post. Comment counts are not stored in this source and are not inferred.

## Hot push notification

The existing push outbox carries `notification_kind: 'hot_lead'`. Its payload is:

```ts
{
  v: 1,
  kind: 'hot_lead',
  title: 'QLead vừa phát hiện Hot Lead!',
  body: 'Một khách hàng đang có nhu cầu rõ ràng và bài đăng còn rất mới. Xem ngay để tiếp cận sớm.',
  url: '/app/bai-viet/<lead UUID>',
  tag: 'hot-lead-<lead UUID>'
}
```

The event is written in the same PostgreSQL transaction that commits the scan and marks its lead delivered. It requires active tenant ownership, an enabled push preference, and a live subscription/session. A partial unique key on user plus canonical Facebook URL prevents repeated Hot alerts across profiles and retries. If a delivered batch includes Hot Leads, it creates Hot alerts instead of a redundant ordinary new-lead push for that batch. Hot pushes retain the existing durable retry and per-device outbox delivery but bypass the ordinary 15 minute new-lead coalescing delay. Push acceptance is best-effort and does not guarantee a device displays or sounds the alert. The current in-app notification center is for account-status notices; hot status and reason are carried by the lead record rather than creating a second notification center.

## Quiet-hours state

`GET /api/leads` adds `delivery.quietHours`:

```ts
{ active: boolean; timeZone: 'Asia/Ho_Chi_Minh'; nextAllowedScanAt: string | null }
```

The worker claim response also adds this object as `quiet_hours`. During quiet hours, worker status reports `queue.claimable_jobs: 0`; claims return an empty `jobs` array plus the next allowed time. Profile scan outcomes (`queued` or `existing`) include `quietHoursActive` and `nextAllowedScanAt` while the interval is active. Initial and manual work can remain queued for 06:30. Follow-ups and retries remain pending; recurring scans resume on the current schedule slot, with no generated backlog of missed overnight intervals. The boundary is 00:30 inclusive to 06:30 exclusive, Vietnam time.

## Workflow status

`POST /api/leads/:id` accepts the existing values plus `status: 'not_interested'` and preserves `onlyIfNew`. `not_interested` is labelled `Không quan tâm`; `not_fit` remains `Không phù hợp`. Status reads and writes remain scoped to the signed-in user, and the automatic mark-seen write only inserts when no user status exists.

## Migration and rollout

Apply `migrations/025_hot_leads_quiet_hours.sql` through the normal reviewed release process. It adds profile-level assessment provenance and expiration, distinguishes push event kinds, and expands the lead status constraint without rewriting existing data. It has not been applied to Production by this change.
