import { AuthScreen } from '@/components/auth-screen';
import { getSession } from '@/lib/server/session';
import { pageMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';
export const metadata = pageMetadata({
  title: 'Tạo tài khoản QLead',
  description: 'Tạo tài khoản QLead để bắt đầu tìm khách hàng tiềm năng từ bài đăng Facebook.',
  path: '/dang-ky',
  indexable: false,
});

/**
 * An existing session is shown, never silently reused: registering replaces it with the new account.
 * `?tu=thu-tim` = the visitor came from the landing search; the same form, with copy about the leads they just saw.
 */
export default async function Register({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const fromLanding = (await searchParams).tu === 'thu-tim';
  const session = await getSession().catch(() => null);
  return <AuthScreen mode="register" signedInAs={session?.displayName ?? null} context={fromLanding ? 'landing' : null}/>;
}
