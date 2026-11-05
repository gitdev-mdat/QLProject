import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/server/session';
import { safeAppPath } from '@/lib/safe-return';

export const dynamic = 'force-dynamic';

/**
 * Entry point for notification taps (public/sw.js opens /mo?den=/app/…). A signed-in person goes straight to the lead
 * page; a signed-out or expired session goes to login with the destination kept, and login returns there. Only /app
 * paths are accepted (lib/safe-return.ts), so this can never redirect off QLead.
 */
export async function GET(request: NextRequest) {
  const destination = safeAppPath(request.nextUrl.searchParams.get('den')) ?? '/app/bai-viet';
  const session = await getSession().catch(() => null);
  const target = session ? destination : `/dang-nhap?tiep=${encodeURIComponent(destination)}`;
  // A relative Location keeps the redirect on whatever origin served this request (qlead.vercel.app today, qlead.vn later).
  return new NextResponse(null, { status: 303, headers: { Location: target, 'Cache-Control': 'no-store' } });
}
