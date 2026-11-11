import type { LeadStatus } from './lead-workflow';

/**
 * Customer side of the per-need engagement rule (backend contract: docs/lead-engagement-gate-contract.md). The server
 * owns every number and decision; this file only words them. Nothing here counts reviews or predicts eligibility.
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
  /** What happens once enough leads are handled. */
  detail: string;
  reviewed: number;
  delivered: number;
  required: number;
  remaining: number;
  pending: number;
  /** 0–100, progress toward the required count (not toward all delivered leads). */
  progress: number;
};

/** How a review is counted, in the customer's words. Kept in one place so every surface says the same thing. */
export const HOW_IT_COUNTS = 'Một khách hàng được tính là đã xử lý khi bạn bấm “Xem bài Facebook”, hoặc chọn Đã liên hệ, Quan tâm, Không quan tâm hay Không phù hợp. Chỉ mở xem chi tiết thì chưa tính.';

export function engagementView(gate: LeadEngagementGate | null | undefined): EngagementView | null {
  if (!isGated(gate)) return null;
  const reviewed = gate.reviewedCount;
  const required = Math.max(gate.requiredReviewedCount, 0);
  const remaining = Math.max(required - reviewed, 0);
  const pending = gate.pendingCount;
  const progress = required ? Math.min(100, Math.round(reviewed / required * 100)) : 100;
  const title = pending > 0
    ? `QLead đang giữ ${pending} khách hàng mới cho bạn`
    : 'Xử lý khách hàng đã nhận để QLead tìm tiếp';
  const next = pending > 0
    ? 'QLead sẽ gửi ngay các khách hàng đang giữ và tiếp tục tìm theo lịch.'
    : 'QLead sẽ tiếp tục tìm khách hàng mới theo lịch.';
  const detail = remaining > 0 ? `Xử lý thêm ${remaining} khách hàng nữa, ${next}` : next;
  return { title, detail, reviewed, delivered: gate.deliveredCount, required, remaining, pending, progress };
}

/** Request note after "Tìm lại ngay" / "Lưu và tìm lại" was refused because the need is waiting for reviews. */
export const USAGE_GATED_NOTE = 'Hãy xử lý các khách hàng đã nhận trước. QLead sẽ tìm tiếp ngay khi đủ.';

/** Browser event fired after the server accepted an action that may count as a review. */
export const LEAD_REVIEW_EVENT = 'qlead:lead-reviewed';

export function announceLeadReview(): void {
  try { window.dispatchEvent(new Event(LEAD_REVIEW_EVENT)); } catch { /* not in a browser */ }
}
