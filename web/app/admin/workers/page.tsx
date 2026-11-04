import { AdminWorkers } from '@/components/admin-workers';
import { getAdminOverview, requireAdmin } from '@/lib/server/admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kết nối Muse · Quản trị QLead' };

export default async function AdminWorkersPage() {
  // Layouts and pages render in parallel, so the page checks admin access itself before reading anything.
  await requireAdmin();
  return <AdminWorkers initial={await getAdminOverview()}/>;
}
