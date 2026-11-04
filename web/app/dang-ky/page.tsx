import { AuthScreen } from '@/components/auth-screen';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** An existing session is shown, never silently reused: registering replaces it with the new account. */
export default async function Register() {
  const session = await getSession().catch(() => null);
  return <AuthScreen mode="register" signedInAs={session?.displayName ?? null}/>;
}
