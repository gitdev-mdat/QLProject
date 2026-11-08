'use client';

/**
 * Browser side of the landing search: a random visitor id for funnel counting, fire-and-forget events, and the
 * hand-off that carries a visitor's search through sign-up so they never type it again.
 */
import type { LandingPreviewLead } from './landing-search';

export type LandingEvent = 'landing_search_started' | 'landing_search_results_shown' | 'landing_search_empty' | 'landing_search_failed'
  | 'landing_preview_opened' | 'landing_signup_clicked';
export type LandingTrigger = 'auto' | 'user' | 'suggestion';
export type LandingFailure = 'timeout' | 'rate_limited' | 'overloaded' | 'network' | 'server';

const VISITOR_KEY = 'qlead:visitor';
const HANDOFF_KEY = 'qlead:landing-handoff';

function visitorId(): string | null {
  try {
    let id = window.localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = crypto.randomUUID();
      window.localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch { return null; }
}

/** Never blocks the UI and never throws: analytics must not break the search. keepalive only for the click that leaves the page. */
export function trackLanding(event: LandingEvent, extra: { previewId?: string | null; trigger?: LandingTrigger; resultCount?: number; clientMs?: number; reason?: LandingFailure } = {}): void {
  try {
    const body = JSON.stringify({ event, visitorId: visitorId(), previewId: extra.previewId ?? null, trigger: extra.trigger ?? null,
      resultCount: extra.resultCount ?? null, clientMs: extra.clientMs === undefined ? null : Math.min(600_000, Math.max(0, Math.round(extra.clientMs))), reason: extra.reason ?? null });
    void fetch('/api/landing/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: event === 'landing_signup_clicked' }).catch(() => undefined);
  } catch { /* ignore */ }
}

export type LandingSearchResponse = { previewId: string; outcome: 'found' | 'empty'; leads: LandingPreviewLead[]; expiresAt: string; serverMs: number; member: boolean };

/** What survives sign-up: the visitor's words and the id of the preview they saw (opened again after sign-up). */
export type LandingHandoff = { query: string; previewId: string; resultCount: number; expiresAt: string; savedAt: string };

export function saveLandingHandoff(handoff: Omit<LandingHandoff, 'savedAt'>): void {
  try { window.localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...handoff, savedAt: new Date().toISOString() })); } catch { /* storage unavailable */ }
}

export function readLandingHandoff(): LandingHandoff | null {
  try {
    const raw = window.localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LandingHandoff>;
    if (typeof value.query !== 'string' || typeof value.previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.previewId)) return null;
    // A week-old hand-off is no longer what the person came for.
    if (Date.parse(value.savedAt ?? '') < Date.now() - 7 * 24 * 3600_000) return null;
    return { query: value.query.slice(0, 300), previewId: value.previewId, resultCount: Number(value.resultCount) || 0, expiresAt: String(value.expiresAt ?? ''), savedAt: String(value.savedAt) };
  } catch { return null; }
}

export function clearLandingHandoff(): void {
  try { window.localStorage.removeItem(HANDOFF_KEY); } catch { /* ignore */ }
}
