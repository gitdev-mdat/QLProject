import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/server/session';
import { isSameOrigin } from '@/lib/server/request-guard';
import { markRead } from '@/lib/server/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(30) }).strict();

/** Marks notifications the customer has actually seen as read. Ids that are not this account's are ignored. Idempotent. */
export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
  try {
    return NextResponse.json({ unread: await markRead(session.userId, parsed.data.ids) }, { headers });
  } catch {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
  }
}
