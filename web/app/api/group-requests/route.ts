import { NextResponse, type NextRequest } from 'next/server';
import { createRequest, GroupRequestError, listRequestsForUser } from '../../../../src/group-requests';
import { db } from '@/lib/server/db';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';

/** The signed-in customer's own Facebook group suggestions. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ requests: await listRequestsForUser(db(), session.userId) }, { headers: { 'Cache-Control': 'no-store' } });
}

/** Records a suggestion for Admin review. The URL is only validated as text; QLead does not open it. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null) as { url?: unknown; note?: unknown } | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_request', message: 'Dữ liệu gửi lên không hợp lệ.' }, { status: 400 });
  try {
    const created = await createRequest(db(), session.userId, { url: body.url, note: body.note });
    return NextResponse.json({ request: created }, { status: 201 });
  } catch (error) {
    if (error instanceof GroupRequestError) return NextResponse.json({ error: error.code, message: error.message, existing: error.existing ?? null }, { status: error.status });
    console.error('Group request failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'internal_error', message: 'Chưa gửi được. Thử lại sau.' }, { status: 500 });
  }
}
