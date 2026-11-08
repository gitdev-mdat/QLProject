import 'server-only';
import { createAttemptLimiter } from '../auth-rate-limit';

const limiter = createAttemptLimiter();
const MINUTE = 60_000;

/**
 * Abuse limits for the anonymous landing search. The search only reads QLead's stored showcase posts (it never starts
 * a Facebook search), so the cost of a request is one cached ranking plus one small insert; the limits stop scripted
 * floods and keep the endpoint cheap. Per server instance, like the sign-in limits.
 */
export function allowLandingSearch(address: string, now = Date.now()): boolean {
  const minute = limiter.allow(`landing:search:min:${address}`, 12, MINUTE, now);
  const hour = limiter.allow(`landing:search:hour:${address}`, 80, 60 * MINUTE, now);
  return minute && hour;
}

export function allowLandingEvent(address: string, now = Date.now()): boolean {
  return limiter.allow(`landing:event:${address}`, 90, MINUTE, now);
}

export function allowLandingUnlock(userId: string, now = Date.now()): boolean {
  return limiter.allow(`landing:unlock:${userId}`, 30, MINUTE, now);
}

/** Back-pressure: beyond this many landing searches in flight on one instance, new ones get "busy" (503). */
const MAX_IN_FLIGHT = 24;
let inFlight = 0;
export async function withLandingCapacity<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  if (inFlight >= MAX_IN_FLIGHT) return { ok: false };
  inFlight += 1;
  try { return { ok: true, value: await work() }; } finally { inFlight -= 1; }
}
