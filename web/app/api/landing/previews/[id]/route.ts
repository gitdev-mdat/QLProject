import { NextResponse, type NextRequest } from 'next/server';
import { allowLandingUnlock } from '@/lib/server/landing-guard';
import { unlockLandingPreview } from '@/lib/server/landing-search';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';
const noStore = { 'cache-control': 'no-store' };

/** Full details of the leads one landing search showed. Signed-in accounts only (free, no payment). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  if (!allowLandingUnlock(session.userId)) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: noStore });
  const { id } = await params;
  const result = await unlockLandingPreview(id, session.userId);
  if (result.status === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  if (result.status !== 'ok') return NextResponse.json({ error: 'expired' }, { status: 410, headers: noStore });
  return NextResponse.json({ leads: result.leads, expiresAt: result.expiresAt }, { headers: noStore });
}
