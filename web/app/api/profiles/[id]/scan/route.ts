import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { changeProfile, getProfileScan } from '@/lib/server/profiles';

export const dynamic = 'force-dynamic';

/** Stored progress of the latest scan of one of the signed-in user's profiles. Foreign ids return 404. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const result = await getProfileScan(session.userId, id);
  if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
}

/**
 * "Tìm lại ngay": queues one scan with the latest saved configuration, or reports the scan already open, a
 * cooldown, the daily limit or a paused profile. Never starts a search directly.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const result = await changeProfile(session.userId, id, { kind: 'rescan' });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ scan: result.scan }, { status: result.scan?.outcome === 'queued' ? 201 : 200 });
}
