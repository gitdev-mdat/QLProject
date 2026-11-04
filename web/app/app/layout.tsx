import { redirect } from 'next/navigation';
import { SessionProvider } from '@/components/app-shell';
import { needsOnboarding } from '@/lib/server/accounts';
import { requireSession } from '@/lib/server/session';

/**
 * Every /app route requires a valid server-side session; otherwise redirect to the login page. A newly registered
 * customer who has not saved a first search request is sent back to onboarding.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (session.leadMonitoringStatus === 'active' && await needsOnboarding(session.userId)) redirect('/bat-dau');
  return <SessionProvider user={{ displayName: session.displayName, isDevSession: session.createdVia === 'dev_quick_login', leadMonitoringStatus: session.leadMonitoringStatus }}>{children}</SessionProvider>;
}
