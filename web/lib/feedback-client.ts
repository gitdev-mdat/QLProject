'use client';

/**
 * Browser side of the one-time feedback invitation. Nothing here decides eligibility: the server does. These helpers
 * only keep requests off the critical path (source-open clicks) and avoid asking the server again once it said "never".
 */
import { announceLeadReview } from './engagement-gate';

const reported = new Set<string>();

/**
 * Called from the "Xem bài Facebook" click. Does not prevent or wait for anything: the link opens normally, and the
 * request (keepalive, so it survives the tab switching to Facebook) is sent in a microtask. Each lead once per page.
 */
export function reportSourceOpen(leadId: string): void {
  if (reported.has(leadId)) return;
  reported.add(leadId);
  queueMicrotask(() => {
    try {
      void fetch(`/api/leads/${encodeURIComponent(leadId)}/source-open`, { method: 'POST', keepalive: true, credentials: 'same-origin' })
        .then(response => { if (response.ok) announceLeadReview(); else if (response.status >= 500) reported.delete(leadId); })
        .catch(() => reported.delete(leadId));
    } catch { reported.delete(leadId); }
  });
}

const DONE_KEY = (owner: string) => `qlead:feedback-done:${owner}`;
const CLAIM_KEY = 'qlead:feedback-claim';

/** A hint (not a rule) that this account answered or declined: skip the claim request. The server stays the authority. */
export const feedbackHint = {
  isDone(owner: string | null): boolean { try { return Boolean(owner && window.localStorage.getItem(DONE_KEY(owner))); } catch { return false; } },
  markDone(owner: string | null): void { try { if (owner) window.localStorage.setItem(DONE_KEY(owner), '1'); } catch { /* private mode */ } },
  claimToken(): string | null { try { return window.sessionStorage.getItem(CLAIM_KEY); } catch { return null; } },
  setClaimToken(token: string | null): void { try { if (token) window.sessionStorage.setItem(CLAIM_KEY, token); else window.sessionStorage.removeItem(CLAIM_KEY); } catch { /* ignore */ } },
};

export type FeedbackDraft = { easeRating: number | null; needsRating: number | null; unmetReason: string; improvement: string };
export const emptyDraft: FeedbackDraft = { easeRating: null, needsRating: null, unmetReason: '', improvement: '' };
export const draftHasAnswer = (draft: FeedbackDraft) => draft.easeRating !== null || draft.needsRating !== null || Boolean(draft.unmetReason.trim()) || Boolean(draft.improvement.trim());

export type SubmitOutcome = 'saved' | 'network' | 'rate_limited' | 'invalid';

/** Same submissionId for every retry of one form, so the server keeps exactly one row. */
export async function sendFeedback(submissionId: string, context: 'invitation' | 'voluntary', draft: FeedbackDraft): Promise<SubmitOutcome> {
  const response = await fetch('/api/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ submissionId, context, easeRating: draft.easeRating, needsRating: draft.needsRating, unmetReason: draft.unmetReason || null, improvement: draft.improvement || null }),
  }).catch(() => null);
  if (!response) return 'network';
  if (response.ok) return 'saved';
  if (response.status === 429) return 'rate_limited';
  if (response.status === 400 || response.status === 409) return 'invalid';
  return 'network';
}

export async function invitationRequest(body: { action: 'claim'; token: string | null } | { action: 'decline' }): Promise<{ show?: boolean; token?: string; final?: boolean } | null> {
  const response = await fetch('/api/feedback/invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body), keepalive: body.action === 'decline' }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}
