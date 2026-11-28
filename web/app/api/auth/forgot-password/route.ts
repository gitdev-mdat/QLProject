import { after, NextResponse, type NextRequest } from 'next/server';
import { allowPasswordResetRequest, requestAddress } from '@/lib/auth-rate-limit';
import { forgotPasswordInput, sendPasswordResetLink } from '@/lib/server/password-reset';
import { isSameOrigin } from '@/lib/server/request-guard';

export const dynamic = 'force-dynamic';

/**
 * "Quên mật khẩu": always answers 202 with the same body, whether or not the email has an account. Looking up the
 * account, creating the link and sending the email all happen after the response, so timing does not tell either.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const parsed = forgotPasswordInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  if (!allowPasswordResetRequest(parsed.data.email, requestAddress(request.headers))) {
    return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
  }
  const origin = request.nextUrl.origin;
  after(() => sendPasswordResetLink(parsed.data.email, origin));
  return NextResponse.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}
