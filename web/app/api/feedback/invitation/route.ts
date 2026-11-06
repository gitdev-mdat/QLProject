import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { claimInvitation, declineInvitation } from '@/lib/server/feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), token: z.string().uuid().nullable().optional() }).strict(),
  z.object({ action: z.literal('decline') }).strict(),
]);

/**
 * claim: a tab is at a natural moment and asks whether to show the one-time invitation. The server alone decides
 * (eligibility, suspension, one claim per account). decline: X or "Không, cảm ơn" — final, never shown again.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
  try {
    if (parsed.data.action === 'decline') { await declineInvitation(session.userId); return NextResponse.json({ ok: true }, { headers }); }
    return NextResponse.json(await claimInvitation(session.userId, parsed.data.token ?? null), { headers });
  } catch {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
  }
}
