import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { LEAD_STATUSES } from '@/lib/lead-workflow';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { setLeadStatus } from '@/lib/server/workflow';

const body = z.object({ status: z.enum(LEAD_STATUSES), onlyIfNew: z.boolean().optional() }).strict();

/** Updates the signed-in user's follow-up status for one of their leads. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { id } = await params;
  const ok = await setLeadStatus(session.userId, id, parsed.data.status, parsed.data.onlyIfNew);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 });
}
