import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { changeProfile, profileInput } from '@/lib/server/profiles';

const body = z.union([
  z.object({ action: z.enum(['pause', 'resume']) }).strict(),
  // base_version: the configuration version the form was opened on. rescan: "Lưu và tìm lại".
  z.object({ profile: profileInput, base_version: z.number().int().positive().optional(), rescan: z.boolean().optional() }).strict(),
]);

/** Edits, pauses or resumes one of the signed-in user's profiles. Unknown and foreign ids both return 404. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const { id } = await params;
  const data = parsed.data;
  const change = 'action' in data
    ? { kind: 'enabled' as const, enabled: data.action === 'resume' }
    : { kind: 'edit' as const, input: data.profile, baseVersion: data.base_version, rescan: data.rescan };
  const result = await changeProfile(session.userId, id, change);
  if (result.ok) return NextResponse.json({ ok: true, version: result.version, scan: result.scan ?? null });
  return NextResponse.json({ error: result.error }, { status: result.error === 'stale' ? 409 : 404 });
}
