import { ScanHistoryView } from '@/components/scan-history-page';
import { requireSession } from '@/lib/server/session';
import { listScanHistoryPage } from '@/lib/server/leads';
import { getLegacySummaryForUser, listProfilesForUser } from '@/lib/server/profiles';
import { dayKey } from '@/lib/scan-history';

/**
 * Every scan of this user's searches, a page at a time. `?nhu-cau=<profile id | legacy>` narrows to one search,
 * `?bai-moi=1` to scans that added posts, `?trang=<n>` picks the page; all of them only filter the user's own rows.
 */
export default async function ScanHistoryRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const params = await searchParams;
  const [profiles, legacy] = await Promise.all([listProfilesForUser(session.userId), getLegacySummaryForUser(session.userId)]);
  const requested = typeof params['nhu-cau'] === 'string' ? params['nhu-cau'] : null;
  // An unknown or someone else's id falls back to all of this user's searches.
  const profileId = profiles.some(profile => profile.id === requested) || (requested === 'legacy' && legacy) ? requested : null;
  const onlyNew = params['bai-moi'] === '1';
  const page = Number(typeof params.trang === 'string' ? params.trang : 1) || 1;
  const history = await listScanHistoryPage(session.userId, { profileId, onlyNew, page });
  const now = Date.now();
  return <ScanHistoryView history={history} profiles={profiles.map(({ id, name, enabled }) => ({ id, name, enabled }))} hasLegacy={Boolean(legacy)}
    profileId={profileId} onlyNew={onlyNew} today={dayKey(now)} yesterday={dayKey(now - 86_400_000)}/>;
}
