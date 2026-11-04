import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { addLeadNote } from '@/lib/server/workflow';

const body = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

/** Adds a private note to one of the signed-in user's leads. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { id } = await params;
  const note = await addLeadNote(session.userId, id, parsed.data.body);
  return note ? NextResponse.json({ note }, { status: 201 }) : NextResponse.json({ error: 'not_found' }, { status: 404 });
}
