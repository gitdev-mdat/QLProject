import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requestAddress } from '@/lib/auth-rate-limit';
import { LANDING_QUERY_MAX, LANDING_QUERY_MIN } from '@/lib/landing-search';
import { allowLandingSearch, withLandingCapacity } from '@/lib/server/landing-guard';
import { runLandingSearch } from '@/lib/server/landing-search';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const body = z.object({ query: z.string().trim().min(LANDING_QUERY_MIN).max(LANDING_QUERY_MAX) }).strict();
const noStore = { 'cache-control': 'no-store' };

/**
 * Landing "Tìm khách hàng": at most two real leads from QLead's showcase searches. Open to visitors who are not signed
 * in; the server decides how many leads and which fields leave it (no URL, author or contact). The response never
 * waits on Muse: it reads stored posts only.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: noStore });
  // The body is read before any early answer, so the connection never carries an unread request body.
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!allowLandingSearch(requestAddress(request.headers))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...noStore, 'retry-after': '60' } });
  }
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: noStore });
  const session = await getSession().catch(() => null);
  try {
    const result = await withLandingCapacity(() => runLandingSearch(parsed.data.query, session?.userId ?? null));
    if (!result.ok) return NextResponse.json({ error: 'busy' }, { status: 503, headers: { ...noStore, 'retry-after': '15' } });
    return NextResponse.json(result.value, { headers: noStore });
  } catch (error) {
    console.error('landing search failed', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: noStore });
  }
}
