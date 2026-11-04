import { NextResponse, type NextRequest } from 'next/server';
import { destroySession } from '@/lib/server/session';

/** Revokes the session server-side. Same-origin only (Origin must match Host). */
export async function POST(request: NextRequest) {
  const host = request.headers.get('host');
  let originHost: string | null = null;
  try { originHost = new URL(request.headers.get('origin') ?? '').host; } catch { originHost = null; }
  if (!host || originHost !== host) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  await destroySession();
  return NextResponse.json({ redirect: '/dang-nhap' });
}
