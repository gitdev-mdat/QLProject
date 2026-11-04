import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildSummary } from '../../../../../../src/handoff';
import { adminApiGuard, errorResponse, withTx } from '@/lib/server/admin';

const body = z.object({ sourceId: z.string().uuid(), destinationId: z.string().uuid() }).strict();

/** Read-only pre-switch summary for the confirmation dialog. Does not contact Muse or change anything. */
export async function POST(request: NextRequest) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.sourceId === parsed.data.destinationId) return NextResponse.json({ error: 'invalid_request', message: 'Hãy chọn hai tài khoản khác nhau.' }, { status: 400 });
  try { return NextResponse.json(await withTx(client => buildSummary(client, parsed.data.sourceId, parsed.data.destinationId))); }
  catch (error) { return errorResponse(error); }
}
