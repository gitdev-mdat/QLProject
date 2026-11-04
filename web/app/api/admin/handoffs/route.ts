import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prepareHandoff } from '../../../../../src/handoff';
import { adminApiGuard, errorResponse, withTx } from '@/lib/server/admin';

const body = z.object({ sourceId: z.string().uuid(), destinationId: z.string().uuid() }).strict();

/** Step 1 of a handoff in either direction: records the operational snapshot. Workers are not changed yet. */
export async function POST(request: NextRequest) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const id = await withTx(client => prepareHandoff(client, { ...parsed.data, userId: guard.userId }));
    return NextResponse.json({ id });
  } catch (error) { return errorResponse(error); }
}
