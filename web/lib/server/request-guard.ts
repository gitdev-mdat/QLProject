import 'server-only';
import type { NextRequest } from 'next/server';

/** Same-origin check for state-changing requests (Origin must match Host). */
export function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get('host');
  try { return Boolean(host) && new URL(request.headers.get('origin') ?? '').host === host; } catch { return false; }
}
