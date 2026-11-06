import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse } from '@/lib/server/admin';
import { getLoginHistory } from '@/lib/server/login-history';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
const uuid = z.string().uuid();
const query = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1), filter: z.enum(['all', 'active']).default('all') });

/** One customer's sign-in history (Admin only). Read-only; never returns tokens, hashes, cookies or IP addresses. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await adminApiGuard(request, false);
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  const parsed = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400, headers: noStore });
  try {
    const history = await getLoginHistory(userId, parsed.data);
    return history ? NextResponse.json(history, { headers: noStore }) : NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  } catch (error) { return errorResponse(error); }
}
