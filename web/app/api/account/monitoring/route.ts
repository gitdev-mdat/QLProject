import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Returns only the signed-in account's effective monitoring status. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json({ status: session.leadMonitoringStatus }, { headers: { 'Cache-Control': 'no-store' } });
}
