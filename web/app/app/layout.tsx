import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { AppFrame, SessionProvider } from '@/components/app-shell';
import { needsOnboarding } from '@/lib/server/accounts';
import { isAdmin } from '@/lib/server/admin';
import { requireSession } from '@/lib/server/session';

/**
 * Every /app route requires a valid server-side session; otherwise redirect to the login page. A newly registered
 * customer who has not saved a first search request is sent back to onboarding. Admins (server-side allowlist) are
 * not forced through customer onboarding, so /app/admin and the shell's Admin link work for a fresh admin account.
 * The navigation frame lives here so it stays mounted between /app routes; pages render only their content, and
 * loading.tsx below fills <main> while a destination's data loads. Each page still checks the session itself.
 */
/** Opaque per-account tag for this device's push subscription (lib/push-client.ts); not a secret, not the user id. */
const pushOwnerKey = (userId: string) => createHash('sha256').update(`qlead-push-owner:${userId}`).digest('hex').slice(0, 24);

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const admin = isAdmin(session.userId);
  if (!admin && session.leadMonitoringStatus === 'active' && await needsOnboarding(session.userId)) redirect('/bat-dau');
  return <SessionProvider user={{ displayName: session.displayName, isDevSession: session.createdVia === 'dev_quick_login', leadMonitoringStatus: session.leadMonitoringStatus, isAdmin: admin, pushOwner: pushOwnerKey(session.userId) }}><AppFrame>{children}</AppFrame></SessionProvider>;
}
