import { NextResponse, type NextRequest } from 'next/server';
import { allowPasswordResetAttempt, requestAddress } from '@/lib/auth-rate-limit';
import { resetPasswordInput, resetPasswordWithLink } from '@/lib/server/password-reset';
import { isSameOrigin } from '@/lib/server/request-guard';

export const dynamic = 'force-dynamic';

/** Sets a new password through an emailed link. The link works once; every signed-in device is signed out. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const parsed = resetPasswordInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  if (!allowPasswordResetAttempt(requestAddress(request.headers))) return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
  if (!await resetPasswordWithLink(parsed.data.token, parsed.data.password)) return NextResponse.json({ error: 'link_invalid' }, { status: 410 });
  return NextResponse.json({ redirect: '/dang-nhap?doi-mat-khau=1' }, { headers: { 'Cache-Control': 'no-store' } });
}
