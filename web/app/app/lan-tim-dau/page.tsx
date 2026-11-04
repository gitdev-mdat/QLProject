import { redirect } from 'next/navigation';
import { FirstScanPage } from '@/components/first-scan';
import { getFirstScanForUser } from '@/lib/server/first-scan';
import { requireSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** First-discovery view right after onboarding; reachable later too, it always reflects the stored scan state. */
export default async function FirstScanRoute() {
  const session = await requireSession();
  const scan = await getFirstScanForUser(session.userId);
  if (!scan) redirect('/app/bo-loc');
  return <FirstScanPage initial={scan}/>;
}
