import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/server/admin';

export const dynamic = 'force-dynamic';

/**
 * Admin lives at /admin. People naturally try /app/admin, so an admin is sent there. The same server-side guard
 * runs first: signed-out users go to login, everyone else still gets the plain 404 (no hint that Admin exists).
 */
export default async function AppAdminRedirect() {
  await requireAdmin();
  redirect('/admin/workers');
}
