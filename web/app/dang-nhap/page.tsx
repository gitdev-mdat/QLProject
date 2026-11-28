import { headers } from 'next/headers';
import { AuthScreen } from '@/components/auth-screen';
import { evaluateDevLogin, headersToRecord } from '@/lib/dev-login-gate';
import { devQuickLoginUsers } from '@/lib/server/dev-users';
import { getSession } from '@/lib/server/session';
import { safeAppPath } from '@/lib/safe-return';
import { pageMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';
export const metadata = pageMetadata({
  title: 'Đăng nhập QLead',
  description: 'Đăng nhập tài khoản QLead để tiếp tục theo dõi khách hàng tiềm năng từ Facebook.',
  path: '/dang-nhap',
  indexable: false,
});

/** `?tiep=/app/…` (from a notification tap while signed out) is where a successful sign-in continues. */
export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeAppPath(params.tiep);
  const session = await getSession().catch(() => null);
  const requestHeaders = await headers();
  const gate = evaluateDevLogin({
    nodeEnv: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_QUICK_LOGIN,
    host: requestHeaders.get('host'), headers: headersToRecord(requestHeaders),
  });
  const devUsers = gate.allowed ? devQuickLoginUsers().map(({ key, label }) => ({ key, label })) : [];
  return <AuthScreen mode="login" devUsers={devUsers} signedInAs={session?.displayName ?? null} returnTo={returnTo} notice={params['doi-mat-khau'] === '1' ? 'password_changed' : null}/>;
}
