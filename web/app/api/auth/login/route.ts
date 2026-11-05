import { NextResponse, type NextRequest } from 'next/server';
import { allowLoginAttempt, requestAddress } from '@/lib/auth-rate-limit';
import { loginInput, needsOnboarding, verifyLogin } from '@/lib/server/accounts';
import { isAdmin } from '@/lib/server/admin';
import { isSameOrigin } from '@/lib/server/request-guard';
import { createSession } from '@/lib/server/session';

/** Email + password sign-in. The same error is returned for an unknown email and a wrong password. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const parsed = loginInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const client = requestAddress(request.headers);
  if (!allowLoginAttempt(`${parsed.data.email}|${client}`)) return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
  const userId = await verifyLogin(parsed.data);
  if (!userId) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  await createSession(userId, 'password');
  // Admins land in Admin; customers continue to onboarding or the app. Admin pages re-check the allowlist themselves.
  if (isAdmin(userId)) return NextResponse.json({ redirect: '/admin/workers' });
  return NextResponse.json({ redirect: await needsOnboarding(userId) ? '/bat-dau' : '/app' });
}
