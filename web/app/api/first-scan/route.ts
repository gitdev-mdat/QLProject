import { NextResponse } from 'next/server';
import { getFirstScanForUser } from '@/lib/server/first-scan';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Current first-scan state for the signed-in user, polled by the first-discovery view. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ scan: await getFirstScanForUser(session.userId) }, { headers: { 'cache-control': 'no-store' } });
}
