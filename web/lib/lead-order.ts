export type LeadDateOrder = 'newest' | 'oldest';

type PostedLead = { id: string; published_at: string | null };

function postedTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Orders by the original Facebook post timestamp. Unknown timestamps stay last in both directions. */
export function compareLeadByPostedAt(a: PostedLead, b: PostedLead, order: LeadDateOrder = 'newest'): number {
  const timeA = postedTime(a.published_at);
  const timeB = postedTime(b.published_at);
  if (timeA === null || timeB === null) {
    if (timeA === null && timeB !== null) return 1;
    if (timeA !== null && timeB === null) return -1;
    return a.id.localeCompare(b.id);
  }
  if (timeA !== timeB) return order === 'newest' ? timeB - timeA : timeA - timeB;
  return a.id.localeCompare(b.id);
}
