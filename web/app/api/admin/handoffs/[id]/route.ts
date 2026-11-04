import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { cancelHandoff, confirmWithoutWork, cutover, failHandoff, refreshHandoff, startDrain } from '../../../../../../src/handoff';
import { adminApiGuard, errorResponse, withTx } from '@/lib/server/admin';

const body = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['drain', 'cutover', 'cutover_emergency', 'cancel', 'confirm', 'refresh']) }).strict(),
  z.object({ action: z.literal('fail'), reason: z.string().trim().min(1).max(500) }).strict(),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Advances one handoff. Every transition is transactional and appended to the handoff's event log. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const input = parsed.data;
  try {
    const result = await withTx(async client => {
      switch (input.action) {
        case 'drain': await startDrain(client, id); return {};
        case 'cutover': return cutover(client, id, { emergency: false });
        case 'cutover_emergency': return cutover(client, id, { emergency: true });
        case 'cancel': await cancelHandoff(client, id); return {};
        case 'confirm': await confirmWithoutWork(client, id); return {};
        case 'refresh': return { status: await refreshHandoff(client, id) };
        case 'fail': await failHandoff(client, id, input.reason); return {};
      }
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return errorResponse(error); }
}
