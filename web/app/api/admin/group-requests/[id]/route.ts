import { NextResponse, type NextRequest } from 'next/server';
import { GroupRequestError, updateRequestStatus } from '../../../../../../src/group-requests';
import { adminApiGuard, withTx } from '@/lib/server/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin review decision for one group suggestion. Records the decision only; nothing joins or crawls the group. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = await request.json().catch(() => null) as { status?: unknown; adminNote?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const updated = await withTx(client => updateRequestStatus(client, guard.userId, id, { status: body.status, adminNote: body.adminNote }));
    return NextResponse.json({ request: updated });
  } catch (error) {
    if (error instanceof GroupRequestError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('Group request review failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'internal_error', message: 'Không lưu được. Thử lại sau.' }, { status: 500 });
  }
}
