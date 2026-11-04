import { db } from '@/lib/server/db';

// Same contract as the Fastify /health used by Muse connector checks.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db().query('SELECT 1');
    return Response.json({ status: 'ok', database: 'connected' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // Code + message only (never the connection string), so a misconfigured deployment is diagnosable from logs.
    console.error(JSON.stringify({ msg: 'health check failed', code: (error as any)?.code, error: error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>') : 'unknown' }));
    return Response.json({ status: 'degraded', database: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
