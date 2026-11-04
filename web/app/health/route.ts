import { db } from '@/lib/server/db';

// Same contract as the Fastify /health used by Muse connector checks.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db().query('SELECT 1');
    return Response.json({ status: 'ok', database: 'connected' }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ status: 'degraded', database: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
