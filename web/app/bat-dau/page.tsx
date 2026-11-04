import { redirect } from 'next/navigation';
import { Onboarding } from '@/components/onboarding';
import { needsOnboarding } from '@/lib/server/accounts';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Real onboarding for the signed-in customer: visitors without a session register first, anyone already set up goes to their own dashboard. */
export default async function StartPage() {
  const session = await getSession();
  if (!session) redirect('/dang-ky');
  if (!await needsOnboarding(session.userId)) redirect('/app');
  return <Onboarding userId={session.userId} displayName={session.displayName}/>;
}
