import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { recordSourceOpen } from '@/lib/server/feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

/**
 * The customer clicked "Xem bài Facebook" on one of their leads. Sent in the background (fetch keepalive) while the
 * browser is already opening Facebook, so it never delays the link. Records only the click, once per lead.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  const { id } = await params;
  try {
    return await recordSourceOpen(session.userId, id)
      ? new NextResponse(null, { status: 204, headers })
      : NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  } catch {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
  }
}
