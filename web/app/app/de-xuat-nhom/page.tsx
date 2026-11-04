import '../../group-requests.css';
import { listRequestsForUser } from '../../../../src/group-requests';
import { GroupRequestPage } from '@/components/group-requests';
import { db } from '@/lib/server/db';
import { requireSession } from '@/lib/server/session';

export const metadata = { title: 'Đề xuất nhóm Facebook · QLead' };

export default async function GroupRequestsPage() {
  const session = await requireSession();
  return <GroupRequestPage initial={await listRequestsForUser(db(), session.userId)}/>;
}
