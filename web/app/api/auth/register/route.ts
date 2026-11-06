import { NextResponse, type NextRequest } from 'next/server';
import { allowRegistrationAttempt, requestAddress } from '@/lib/auth-rate-limit';
import { registerAccount, registerInput } from '@/lib/server/accounts';
import { isSameOrigin } from '@/lib/server/request-guard';
import { createSession } from '@/lib/server/session';

/** Creates a customer account and signs it in, replacing any session the browser already had. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const parsed = registerInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  if (!allowRegistrationAttempt(parsed.data.email, requestAddress(request.headers))) {
    return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 });
  }
  const result = await registerAccount(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await createSession(result.userId, 'password', 'register');
  return NextResponse.json({ redirect: '/bat-dau' }, { status: 201 });
}
