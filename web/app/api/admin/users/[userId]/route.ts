import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse } from '@/lib/server/admin';
import { getAdminUserMonitoring } from '@/lib/server/monitoring';

export const dynamic = 'force-dynamic';
const uuid = z.string().uuid();

/** Reads one customer's account-level monitoring state and operational summary. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await adminApiGuard(request, false);
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try {
    const user = await getAdminUserMonitoring(userId);
    return user ? NextResponse.json(user, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
