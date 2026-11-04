import { AdminUsers } from '@/components/admin-users';
import { USERS_PAGE_SIZE } from '@/lib/admin-users';
import { requireAdmin } from '@/lib/server/admin';
import { listAdminUsers } from '@/lib/server/monitoring';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Khách hàng · Quản trị QLead' };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Layouts and pages render in parallel, so the page checks admin access itself before reading anything.
  const admin = await requireAdmin();
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q : '').trim().slice(0, 200);
  const page = Math.min(1_000_000, Math.max(1, Number.parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1));
  const initial = await listAdminUsers(q, USERS_PAGE_SIZE, (page - 1) * USERS_PAGE_SIZE).catch(() => null);
  return <AdminUsers initial={initial} initialQuery={q} initialPage={page} currentAdminId={admin.userId}/>;
}
