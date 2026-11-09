import type { Lead } from './lead-source';
import type { LeadDistributionSummary } from './server/leads';

/**
 * Customer view of the bounded lead delivery (Codex contract docs/lead-delivery-api-contract.md). Pure helpers only:
 * every number here comes from GET /api/leads or the server-rendered list, nothing is estimated in the browser.
 */
export type DeliverySummary = LeadDistributionSummary;

/** The leads of the most recent delivery: one delivery transaction stamps every lead it gives with the same time. */
export type LatestDelivery = { at: string; ids: string[] };

export function latestDelivery(leads: Array<Pick<Lead, 'id' | 'deliveredAt'>>): LatestDelivery | null {
  let at: string | null = null;
  for (const lead of leads) if (lead.deliveredAt && (!at || lead.deliveredAt > at)) at = lead.deliveredAt;
  if (!at) return null;
  return { at, ids: leads.filter(lead => lead.deliveredAt === at).map(lead => lead.id) };
}

/** "lúc 14:30" today, "lúc 14:30 ngày 7/11" on another day (Vietnam time). */
export function deliveryClock(iso: string, now = Date.now()): string {
  const zone = 'Asia/Ho_Chi_Minh';
  const day = (value: number | string) => new Intl.DateTimeFormat('vi-VN', { timeZone: zone, day: 'numeric', month: 'numeric' }).format(new Date(value));
  const time = new Intl.DateTimeFormat('vi-VN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return day(iso) === day(now) ? `lúc ${time}` : `lúc ${time} ngày ${day(iso)}`;
}

/**
 * The one sentence about leads QLead holds back for later deliveries. Only when the backend reports some, and the
 * time is the backend's next cycle boundary: it is when the next batch can be given, not a promise of a new search.
 */
export function heldBackLine(delivery: Pick<DeliverySummary, 'queued' | 'nextCycleAt' | 'status' | 'maxLeadsPerCycle'> | null | undefined, now = Date.now()): string | null {
  if (!delivery || delivery.queued <= 0) return null;
  if (delivery.status === 'paused' || delivery.status === 'suspended') return `QLead đang giữ thêm ${delivery.queued} cơ hội khác cho nhu cầu này.`;
  const when = delivery.nextCycleAt ? ` từ ${deliveryClock(delivery.nextCycleAt, now)}` : ' ở lượt gửi sau';
  return `QLead giữ thêm ${delivery.queued} cơ hội khác và sẽ gửi tiếp${when}, tối đa ${delivery.maxLeadsPerCycle || 10} khách mỗi lượt.`;
}
