import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { listNotifications } from '@/lib/server/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The signed-in account's own notifications (newest first) and its unread count. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    return NextResponse.json(await listNotifications(session.userId), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
