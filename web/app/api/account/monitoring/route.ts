import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { unreadNotificationCount } from '@/lib/server/notifications';

export const dynamic = 'force-dynamic';

/** Returns only the signed-in account's effective monitoring status and its unread notification count (one shell poll). */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const unread = await unreadNotificationCount(session.userId).catch(() => null);
  return NextResponse.json({ status: session.leadMonitoringStatus, ...(unread === null ? {} : { unread }) }, { headers: { 'Cache-Control': 'no-store' } });
}
