import type { HotLeadAssessment, Lead } from './lead-source';

/**
 * Hot Lead presentation helpers. QLead's backend decides what is Hot (per search profile, with a reason and an
 * expiry); this file never classifies a lead itself. It only picks which server assessment to show and hides a Hot
 * label once the server's own `expiresAt` has passed while the page stayed open.
 */

/** The live Hot assessment of a lead, if the server marked one as `hot` and its window has not ended yet. */
export function activeHot(lead: Lead, now: number, profileId?: string): HotLeadAssessment | null {
  const live = (lead.hotAssessments ?? []).filter(item => item.status === 'hot' && (!item.expiresAt || !now || new Date(item.expiresAt).getTime() > now));
  if (!live.length) return null;
  // On a list scoped to one need, only that need's assessment counts: a post can be Hot for one need and not another.
  if (profileId) return live.find(item => item.profileId === profileId) ?? null;
  return live[0];
}

/** A Hot Lead whose urgent window has ended (server status `historical`, or `hot` past its expiry on an open page). */
export function wasHot(lead: Lead, now: number, profileId?: string): HotLeadAssessment | null {
  if (activeHot(lead, now, profileId)) return null;
  const scoped = (lead.hotAssessments ?? []).filter(item => !profileId || item.profileId === profileId);
  return scoped.find(item => item.status === 'historical' || item.status === 'hot') ?? null;
}

export function hotLeads(leads: Lead[], now: number, profileId?: string): Lead[] {
  return leads.filter(lead => activeHot(lead, now, profileId))
    .sort((a, b) => time(b.published_at) - time(a.published_at));
}

const time = (value: string | null | undefined) => (value ? new Date(value).getTime() : 0);

/** The server's reason, or a plain fallback when an older record carries no reason text. */
export function hotReason(assessment: HotLeadAssessment): string {
  return assessment.reasonVi?.trim() || 'Bài đăng còn rất mới và nêu rõ nhu cầu khớp với nhu cầu tìm kiếm của bạn.';
}

/** "Ưu tiên liên hệ trước 14:35" — the end of the server's urgent window, in Vietnam time. */
export function hotUntil(assessment: HotLeadAssessment): string | null {
  if (!assessment.expiresAt) return null;
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(assessment.expiresAt));
}

/**
 * Celebration bookkeeping: each Hot Lead is celebrated at most once per device, so a refresh, a route change or a
 * second tab never replays it. Storage failures (private mode) mean "already celebrated", never a repeat.
 */
const CELEBRATED_KEY = 'qlead:hot-celebrated';
const MAX_REMEMBERED = 200;

function readCelebrated(): string[] | null {
  try {
    const raw = window.localStorage.getItem(CELEBRATED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch { return null; }
}

/** Ids not celebrated yet on this device, and marks them as celebrated in the same step. */
export function claimCelebration(ids: string[]): string[] {
  const seen = readCelebrated();
  if (seen === null) return [];
  const fresh = ids.filter(id => !seen.includes(id));
  if (!fresh.length) return [];
  try { window.localStorage.setItem(CELEBRATED_KEY, JSON.stringify([...seen, ...fresh].slice(-MAX_REMEMBERED))); } catch { return []; }
  return fresh;
}

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}
