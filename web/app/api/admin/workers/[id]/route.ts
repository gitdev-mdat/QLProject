import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { HandoffError, OPEN_HANDOFF, setWorkerStatus } from '../../../../../../src/handoff';
import { releaseWorkerJobs } from '../../../../../../src/jobs';
import { adminApiGuard, errorResponse, newCredential, withTx } from '@/lib/server/admin';

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('unavailable'), release: z.boolean() }).strict(),
  z.object({ action: z.literal('activate') }).strict(),
  z.object({ action: z.literal('rotate') }).strict(),
  z.object({ action: z.literal('update'), sources: z.array(z.string().trim().min(1).max(200)).min(1).max(20), maxJobs: z.number().int().min(1).max(10) }).strict(),
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Direct worker actions. Activation is only allowed when no other worker is active; moving work from one active
 * worker to another always goes through the handoff workflow so in-flight jobs are handled safely.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await adminApiGuard(request, true); if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const input = parsed.data;
  try {
    const result = await withTx(async client => {
      const { rows: [worker] } = await client.query('SELECT id, status FROM muse_workers WHERE id = $1 FOR UPDATE', [id]);
      if (!worker) throw new HandoffError('worker_not_found', 'Không tìm thấy tài khoản Muse này.');
      const { rows: [open] } = await client.query(`SELECT id FROM worker_handoffs WHERE status = ANY($1::text[]) AND (source_worker_id = $2 OR destination_worker_id = $2)`, [[...OPEN_HANDOFF], id]);
      if (open && input.action !== 'update' && input.action !== 'rotate') throw new HandoffError('handoff_in_progress', 'Tài khoản này đang nằm trong một lượt chuyển đổi. Hãy thao tác trong lượt chuyển đổi đó.');
      switch (input.action) {
        case 'pause': await setWorkerStatus(client, id, 'paused'); return {};
        case 'unavailable': {
          await setWorkerStatus(client, id, 'unavailable');
          return { released: input.release ? await releaseWorkerJobs(client, id) : 0 };
        }
        case 'activate': {
          const { rows: [active] } = await client.query(`SELECT name FROM muse_workers WHERE status IN ('active', 'draining') AND id <> $1 LIMIT 1`, [id]);
          if (active) throw new HandoffError('other_worker_active', `${active.name} đang hoạt động. Hãy dùng "Chuẩn bị chuyển đổi" để chuyển việc an toàn.`);
          await setWorkerStatus(client, id, 'active'); return {};
        }
        case 'rotate': {
          const { token, hash } = newCredential();
          // The old credential stops working immediately; the account must be verified again with the new one.
          await client.query(`UPDATE muse_workers SET credential_hash = $2, credential_status = 'active', connection_verified_at = NULL WHERE id = $1`, [id, hash]);
          return { credential: token };
        }
        case 'update':
          await client.query('UPDATE muse_workers SET authorized_sources = $2, max_jobs_per_claim = $3 WHERE id = $1', [id, JSON.stringify(input.sources), input.maxJobs]);
          return {};
      }
    });
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
