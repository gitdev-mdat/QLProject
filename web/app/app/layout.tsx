import { redirect } from 'next/navigation';
import { SessionProvider } from '@/components/app-shell';
import { needsOnboarding } from '@/lib/server/accounts';
import { isAdmin } from '@/lib/server/admin';
import { requireSession } from '@/lib/server/session';

/**
 * Every /app route requires a valid server-side session; otherwise redirect to the login page. A newly registered
 * customer who has not saved a first search request is sent back to onboarding. Admins (server-side allowlist) are
 * not forced through customer onboarding, so /app/admin and the shell's Admin link work for a fresh admin account.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const admin = isAdmin(session.userId);
  if (!admin && session.leadMonitoringStatus === 'active' && await needsOnboarding(session.userId)) redirect('/bat-dau');
  return <SessionProvider user={{ displayName: session.displayName, isDevSession: session.createdVia === 'dev_quick_login', leadMonitoringStatus: session.leadMonitoringStatus, isAdmin: admin }}>{children}</SessionProvider>;
}
