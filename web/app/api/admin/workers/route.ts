import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { adminApiGuard, errorResponse, getAdminOverview, newCredential, withTx } from '@/lib/server/admin';

const noStore = { 'Cache-Control': 'no-store' };
const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  sources: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  maxJobs: z.number().int().min(1).max(10),
}).strict();

/** Admin overview: workers, queue, open handoff (advanced from recorded evidence) and handoff history. */
export async function GET(request: NextRequest) {
  const guard = await adminApiGuard(request, false); if (guard instanceof NextResponse) return guard;
  try { return NextResponse.json(await getAdminOverview(), { headers: noStore }); } catch (error) { return errorResponse(error); }
}

/** Adds a worker. It starts paused and claims nothing. The credential is returned once and never stored in plain text. */
export async function POST(request: NextRequest) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const parsed = createBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request', message: 'Tên, nguồn hoặc số job mỗi lần chưa hợp lệ.' }, { status: 400 });
  const { token, hash } = newCredential();
  try {
    const worker = await withTx(async client => {
      const { rows: [dupe] } = await client.query('SELECT id FROM muse_workers WHERE lower(name) = lower($1)', [parsed.data.name]);
      if (dupe) return null;
      const { rows: [row] } = await client.query(`INSERT INTO muse_workers(name, credential_hash, authorized_sources, max_jobs_per_claim, lease_minutes, status)
        VALUES ($1, $2, $3, $4, 45, 'paused') RETURNING id, name`, [parsed.data.name, hash, JSON.stringify(parsed.data.sources), parsed.data.maxJobs]);
      return row;
    });
    if (!worker) return NextResponse.json({ error: 'duplicate_name', message: 'Đã có tài khoản Muse cùng tên. Hãy dùng lại tài khoản đó.' }, { status: 409 });
    return NextResponse.json({ worker, credential: token }, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}
