import { createHash } from 'node:crypto';

type Entry = { count: number; resetAt: number };

/** Small per-process limiter for the single-instance, short-lived family pilot. */
export function createAttemptLimiter() {
  const entries = new Map<string, Entry>();
  let calls = 0;
  return {
    allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
      const bucket = createHash('sha256').update(key).digest('hex');
      const current = entries.get(bucket);
      const next = !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
      entries.set(bucket, next);
      if (++calls % 128 === 0) {
        for (const [id, value] of entries) if (value.resetAt <= now) entries.delete(id);
      }
      return next.count <= limit;
    },
  };
}

const limiter = createAttemptLimiter();
const HOUR = 60 * 60_000;
const LOGIN_WINDOW = 15 * 60_000;

/** Registration caps are intentionally modest but allow a small family on one shared network. */
export function allowRegistrationAttempt(email: string, address: string, now = Date.now()): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedAddress = address.trim().toLowerCase() || 'unknown';
  const emailAllowed = limiter.allow(`register:email:${normalizedEmail}`, 3, HOUR, now);
  const addressAllowed = limiter.allow(`register:ip:${normalizedAddress}`, 10, HOUR, now);
  return emailAllowed && addressAllowed;
}

/** Login cap is kept compatible with the previous limit (10 attempts per key per 15 minutes). */
export function allowLoginAttempt(key: string, now = Date.now()): boolean {
  return limiter.allow(`login:${key}`, 10, LOGIN_WINDOW, now);
}

/** Prefer Cloudflare's edge-populated address; fall back to the first proxy address or a shared unknown bucket. */
export function requestAddress(headers: Pick<Headers, 'get'>): string {
  const cloudflare = headers.get('cf-connecting-ip')?.trim();
  if (cloudflare && cloudflare.length <= 64) return cloudflare;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : 'unknown';
}
