import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse, withTx } from '@/lib/server/admin';
import { setLeadMonitoringStatus } from '@/lib/server/monitoring';
import { drainPushNotifications } from '../../../../../../../src/push-notifications';

export const dynamic = 'force-dynamic';
const uuid = z.string().uuid();
// reason: Admin-only internal note. publicReason: optional text shown to the customer exactly as written (suspension only).
const body = z.discriminatedUnion('status', [
  z.object({ status: z.literal('suspended'), reason: z.string().trim().max(1000).nullable().optional(), publicReason: z.string().trim().max(500).nullable().optional() }).strict(),
  z.object({ status: z.literal('active'), reason: z.string().max(1000).nullable().optional() }).strict(),
]);

/**
 * Idempotently suspends or reactivates only lead monitoring; the customer account and history remain intact. A real
 * change also records one customer notification in the same transaction (a retried request changes nothing, so it adds none).
 */
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
    const { pushOutboxId, notificationId, ...response } = result;
    // Push delivery happens after the response; a push failure never affects the status change.
    if (pushOutboxId) { try { after(() => drainPushNotifications({ outboxId: pushOutboxId, limit: 5 }).catch(() => undefined)); } catch { /* outside a request scope */ } }
    return NextResponse.json({ ...response, notified: Boolean(notificationId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
