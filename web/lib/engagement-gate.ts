import type { LeadStatus } from './lead-workflow';

/**
 * Customer side of the per-need engagement rule (backend contract: docs/lead-engagement-gate-contract.md). The server
 * owns every number and decision; this file only words them. Nothing here counts reviews or predicts eligibility.
 *
 * Wording: a counted review is "khám phá" (never "xem"), because the lead status "Đã xem" (opening the detail) does not
 * count and must not be confused with it. The tone invites; it never says locked, not eligible or required.
 */
export type LeadEngagementGate = {
  policyActive: boolean;
  completedDiscoveryScans: number;
  deliveredCount: number;
  reviewedCount: number;
  requiredReviewedCount: number;
  reviewedPercent: number;
  thresholdPercent: number;
  pendingCount: number;
  gateState: 'first_two_scans' | 'eligible' | 'holding_third_scan_results' | 'awaiting_review';
  mayStartNewScan: boolean;
  mayReceivePendingLeads: boolean;
  nextAction: 'none' | 'review_leads' | 'deliver_pending';
};

/** Manual statuses the server records as a review. 'new' and 'seen' (opening the detail) do not count. */
export const REVIEW_STATUSES: readonly LeadStatus[] = ['contacted', 'interested', 'not_interested', 'not_fit'];

/** True only when the server says this need is waiting for the customer before QLead searches or sends more. */
export function isGated(gate: LeadEngagementGate | null | undefined): gate is LeadEngagementGate {
  return Boolean(gate?.policyActive && !gate.mayStartNewScan);
}

export type EngagementView = {
  title: string;
  /** "Bạn đã khám phá r/d khách hàng." */
  progressLine: string;
  /** "Khám phá thêm X khách hàng để nhận lượt tiếp theo." */
  nextLine: string;
  reviewed: number;
  delivered: number;
  remaining: number;
  /** Positive only when the server confirms held candidates. Details are never shown before delivery. */
  pending: number;
  /** Floored, so 79.9% never reads as the 80% target. */
  percent: number;
  target: number;
};

/** How a review is counted, in the customer's words. One place, so every surface says the same thing. */
export const HOW_IT_COUNTS = 'Bấm “Xem bài Facebook”, hoặc chọn Đã liên hệ, Quan tâm, Không quan tâm hay Không phù hợp. Mỗi khách hàng chỉ tính một lần; chỉ mở xem chi tiết thì chưa tính.';

export function engagementView(gate: LeadEngagementGate | null | undefined): EngagementView | null {
  if (!isGated(gate)) return null;
  const reviewed = gate.reviewedCount;
  const delivered = gate.deliveredCount;
  const remaining = Math.max(gate.requiredReviewedCount - reviewed, 0);
  const pending = Math.max(gate.pendingCount, 0);
  return {
    title: pending > 0 ? 'QLead đã lưu thêm cơ hội cho bạn' : 'Khám phá thêm cơ hội đang có nhé!',
    progressLine: `Bạn đã khám phá ${reviewed}/${delivered} khách hàng.`,
    nextLine: `Khám phá thêm ${remaining} khách hàng để nhận lượt tiếp theo.`,
    reviewed, delivered, remaining, pending,
    percent: Math.floor(Math.max(0, Math.min(100, gate.reviewedPercent))),
    target: gate.thresholdPercent,
  };
}

/** Pill on a need card while it waits for the customer. Distinct from paused, suspended and overnight. */
export function engagementPill(gate: LeadEngagementGate | null | undefined): string | null {
  const view = engagementView(gate);
  return view ? (view.pending > 0 ? 'Có cơ hội đang chờ' : 'Chờ bạn khám phá thêm') : null;
}

/** Request note after "Tìm lại ngay" / "Lưu và tìm lại" was not started because the need waits for the customer. */
export const USAGE_GATED_NOTE = 'Khám phá thêm các khách hàng hiện có để QLead tìm lượt tiếp theo.';

/** Browser event fired after the server accepted an action that may count as a review. */
export const LEAD_REVIEW_EVENT = 'qlead:lead-reviewed';

export function announceLeadReview(): void {
  try { window.dispatchEvent(new Event(LEAD_REVIEW_EVENT)); } catch { /* not in a browser */ }
}

/** List URL for one need, opened on its unread leads ("Chưa xem") when it still has some. */
export function unreviewedHref(profileId: string): string {
  return `/app/bai-viet?nhu-cau=${encodeURIComponent(profileId)}&chua-xem=1`;
}
