import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/server/session';
import { listLeadPageForUser, type LeadScope } from '@/lib/server/leads';

export const dynamic = 'force-dynamic';

/** Customer-scoped lead list. Reading it may deliver one due backlog batch; profile cycle keys make refresh idempotent. */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  const requested = request.nextUrl.searchParams.get('profile_id');
  const scope: LeadScope = requested === 'legacy' ? { kind: 'legacy' }
    : requested ? { kind: 'profile', profileId: requested } : { kind: 'all' };
  const parsedLimit = Number(request.nextUrl.searchParams.get('limit') ?? 200);
  const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(200, parsedLimit)) : 200;
  const page = await listLeadPageForUser(session.userId, scope, limit);
  return NextResponse.json({ leads: page.leads, total: page.total, delivery: page.delivery }, { headers: { 'cache-control': 'no-store' } });
}
