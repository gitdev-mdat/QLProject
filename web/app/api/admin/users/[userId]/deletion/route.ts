import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard } from '@/lib/server/admin';
import { deleteUserAccount, previewUserDeletion, UserDeletionError } from '@/lib/server/user-deletion';
import { userDeletionHttpStatus } from '../../../../../../../src/user-deletion';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
const uuid = z.string().uuid();
const bodySchema = z.object({ confirmUserId: z.string().uuid() }).strict();

function deletionError(error: unknown) {
  if (error instanceof UserDeletionError) {
    const status = userDeletionHttpStatus(error.code);
    return NextResponse.json({ error: error.code, message: error.message, impact: error.impact }, { status, headers: noStore });
  }
  console.error('Admin account deletion failed:', error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'internal_error', message: 'Không thể xóa tài khoản. Không có thay đổi nào được lưu.' }, { status: 500, headers: noStore });
}

/** Read-only deletion preview. Counts are rechecked in the deletion transaction. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await adminApiGuard(request, false);
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  try { return NextResponse.json(await previewUserDeletion(userId), { headers: noStore }); }
  catch (error) { return deletionError(error); }
}

/** Permanently deletes the selected account after an exact immutable-ID confirmation. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const guard = await adminApiGuard(request, true);
  if (guard instanceof NextResponse) return guard;
  const { userId } = await params;
  if (!uuid.safeParse(userId).success) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_confirmation' }, { status: 400, headers: noStore });
  try {
    const impact = await deleteUserAccount(guard.userId, userId, parsed.data.confirmUserId);
    return NextResponse.json({ deleted: true, impact }, { headers: noStore });
  } catch (error) { return deletionError(error); }
}
