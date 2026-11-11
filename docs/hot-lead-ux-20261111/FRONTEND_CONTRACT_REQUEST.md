# Hot Lead, quiet hours, "Không quan tâm" — frontend contract request

Status: **REQUEST from Claude (frontend) to Codex (backend). Not a contract yet.**
Nothing here is implemented in the backend. Codex owns the final shape; anything below can be renamed.
Frontend branch `claude/hot-lead-ux` will only consume fields Codex confirms.

Audited on origin/main 291121c (2026-11-11). No `hot`, quiet-hours or `not_interested` code exists on any branch.

## 1. Lead status `not_interested`

Today: `migrations/005_lead_workflow.sql` CHECK `status IN ('new','seen','contacted','interested','not_fit')`,
mirrored in `web/lib/lead-workflow.ts` `LEAD_STATUSES`.

Needed from Codex:
- Migration widening the CHECK with `'not_interested'`.
- `PATCH /api/leads/:id` (existing workflow write) accepts `status: 'not_interested'`, same rules as `not_fit`
  (changeable later, no required note).
- Any server-side counts / filters that group "closed" statuses (`not_fit`) should decide whether
  `not_interested` is also excluded from the "cần xử lý" queue and from delivery counts. Frontend proposal:
  treat both as closed (hidden from the default "Cần xử lý" view, visible under their own filter).

Frontend meaning (copy):
- **Không quan tâm** — đúng nhóm khách, nhưng bạn không muốn theo đuổi.
- **Không phù hợp** — không đúng nhóm khách bạn cần tìm (giúp QLead tìm chính xác hơn).

## 2. Hot Lead fields on a lead

Frontend will NOT classify. It renders exactly what the server says. Proposed per-lead object
(on GET /api/leads items, lead detail, Today, and first-scan/profile results):

```ts
hot: null | {
  reason: string;            // short Vietnamese sentence shown to the customer, ≤120 chars, no internal wording
  evidence?: string[];       // optional short quotes/phrases from the post that support it (≤3, ≤80 chars each)
  classifiedAt: string;      // ISO
  expiresAt: string | null;  // ISO; after this the UI shows the lead as ordinary (server should also return hot=null)
}
publishedAt: string | null;  // existing field; null = "chưa rõ thời gian đăng" (never fabricated)
publishedAtVerified?: boolean; // optional: true when Codex validated the real FB publish time
```

Questions for Codex:
- Is `hot` returned already filtered by expiry (preferred), or must the client compare `expiresAt`?
- Ordering: does GET /api/leads put active Hot Leads first, or should the client only add a "Hot Lead" filter chip?
- Filter param, e.g. `GET /api/leads?hot=1`, and a count `hotActive` in the list response (for the chip; 0 → chip hidden).
- Is it per user (tenant-scoped) — required: Hot must never leak across accounts.

## 3. Hot Lead notification event

Today `src/push-notifications.ts` PushPayload kind is `'new_leads' | 'test' | 'account_status'`, tag `new-leads`.

Proposal:
```ts
{ v: 1, kind: 'hot_lead', title: 'Hot Lead: <≤40 chars>', body: '<reason, ≤140 chars>',
  url: '/app/bai-viet/<leadId>', tag: 'hot-lead-<leadId>', leadId: string }
```
- Separate tag so a Hot Lead is not replaced by the next "N cơ hội mới" batch.
- Frontend (sw.js) will add `requireInteraction` where supported and a distinct title; no sound/vibration promises.
- In-app: `postMessage({ type: 'qlead:push', kind: 'hot_lead', leadId })` lets the open app refresh and celebrate once.
- Also needed: an in-app notification row (account_notifications or equivalent) so Hot is discoverable without push.

## 4. Quiet hours 00:30–06:30 (Asia/Ho_Chi_Minh)

Frontend must not compute "next search" itself. Needed:
- In profile scan state (GET /api/profiles/:id/scan) and Today/first-scan payloads:
  ```ts
  quietHours: { active: boolean; endsAt: string /* ISO, next 06:30 VN */ } | null
  nextScanAt: string | null   // real scheduled slot from the backend, may equal or follow endsAt
  ```
- POST /api/profiles/:id/scan and "Lưu và tìm lại": new outcome
  `{ outcome: 'quiet_hours', resumesAt: string }` (no job created; or say if the job is queued for 06:30 instead).
- First scan / onboarding during quiet hours: is the initial job queued until 06:30 (frontend shows
  "Lượt tìm đầu tiên sẽ bắt đầu lúc 06:30") or rejected?
- A job already running at 00:30: does it finish, or is it cancelled?

## 5. What ships without Codex

- Search-profile description copy (done on `claude/hot-lead-ux`).
- PWA install explanation reusing existing `install-prompt.ts` / `push-client.ts`, shown only after the user has real leads.
- UI components for Hot / quiet hours / `not_interested` can be built against synthetic fixtures, but they stay
  unwired (and unreleased) until the fields above exist.
