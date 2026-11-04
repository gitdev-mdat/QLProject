import { headers } from 'next/headers';
import { AuthScreen } from '@/components/auth-screen';
import { evaluateDevLogin, headersToRecord } from '@/lib/dev-login-gate';
import { devQuickLoginUsers } from '@/lib/server/dev-users';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export default async function Login() {
  const session = await getSession().catch(() => null);
  const requestHeaders = await headers();
  const gate = evaluateDevLogin({
    nodeEnv: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_QUICK_LOGIN,
    host: requestHeaders.get('host'), headers: headersToRecord(requestHeaders),
  });
  const devUsers = gate.allowed ? devQuickLoginUsers().map(({ key, label }) => ({ key, label })) : [];
  return <AuthScreen mode="login" devUsers={devUsers} signedInAs={session?.displayName ?? null}/>;
}
