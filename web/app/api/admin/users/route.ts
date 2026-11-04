import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse } from '@/lib/server/admin';
import { listAdminUsers } from '@/lib/server/monitoring';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
const paramsSchema = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(50), q: z.string().trim().max(200).default('') });

/** Paginated customer list for the authenticated QLead Admin. */
export async function GET(request: NextRequest) {
  const guard = await adminApiGuard(request, false);
  if (guard instanceof NextResponse) return guard;
  const parsed = paramsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_query' }, { status: 400, headers: noStore });
  const { page, limit, q } = parsed.data;
  try { return NextResponse.json(await listAdminUsers(q, limit, (page - 1) * limit), { headers: noStore }); }
  catch (error) { return errorResponse(error); }
}
