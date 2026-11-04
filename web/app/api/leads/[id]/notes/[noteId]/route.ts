import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { deleteLeadNote } from '@/lib/server/workflow';

/** Deletes one of the signed-in user's own notes. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, noteId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return await deleteLeadNote(session.userId, id, noteId) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 });
}
