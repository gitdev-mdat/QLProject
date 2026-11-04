import '../../group-requests.css';
import { listRequestsForAdmin } from '../../../../src/group-requests';
import { AdminGroupRequests } from '@/components/admin-group-requests';
import { requireAdmin } from '@/lib/server/admin';
import { db } from '@/lib/server/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Đề xuất nhóm · Quản trị QLead' };

export default async function AdminGroupRequestsPage() {
  // Layouts and pages render in parallel, so the page checks admin access itself before reading anything.
  await requireAdmin();
  return <AdminGroupRequests initial={await listRequestsForAdmin(db())}/>;
}
