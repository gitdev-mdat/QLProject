import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse, withTx } from '@/lib/server/admin';
import { setLeadMonitoringStatus } from '@/lib/server/monitoring';

export const dynamic = 'force-dynamic';
const uuid = z.string().uuid();
const body = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(1000).nullable().optional() }).strict();

/** Idempotently suspends or reactivates only lead monitoring; the customer account and history remain intact. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await adminApiGuard(request, true);
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const result = await withTx(client => setLeadMonitoringStatus(client, userId, guard.userId, parsed.data));
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
