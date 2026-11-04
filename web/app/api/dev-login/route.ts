import { NextResponse, type NextRequest } from 'next/server';
import { evaluateDevLogin, headersToRecord } from '@/lib/dev-login-gate';
import { devQuickLoginUsers } from '@/lib/server/dev-users';
import { createSession } from '@/lib/server/session';

/**
 * DEV ONLY. Creates a real web session for a configured local test user.
 * Rejected (404) unless `next dev`, ENABLE_DEV_QUICK_LOGIN=true, a loopback Host, no proxy headers,
 * a same-origin Origin and the custom CSRF header all hold. Production builds always answer 404.
 */
export async function POST(request: NextRequest) {
  const gate = evaluateDevLogin({
    nodeEnv: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_QUICK_LOGIN,
    host: request.headers.get('host'), origin: request.headers.get('origin'),
    headers: headersToRecord(request.headers), mutating: true,
  });
  if (!gate.allowed) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = await request.json().catch(() => null) as { user?: unknown } | null;
  const user = devQuickLoginUsers().find(item => item.key === body?.user);
  if (!user) return NextResponse.json({ error: 'unknown_test_user' }, { status: 400 });

  const exists = await user.verify();
  if (!exists) return NextResponse.json({ error: 'test_user_missing', message: 'Test user id from DEV_QUICK_LOGIN_USERS was not found in the database.' }, { status: 409 });

  await createSession(user.userId, 'dev_quick_login');
  return NextResponse.json({ redirect: '/app' });
}
