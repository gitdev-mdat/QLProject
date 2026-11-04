import { Dashboard } from '@/components/dashboard';
import { requireSession } from '@/lib/server/session';
import { getScanTotalsForUser, listLeadsForUser, listScanHistoryForUser } from '@/lib/server/leads';
import { getLegacySummaryForUser, listProfilesForUser } from '@/lib/server/profiles';
import { getWorkflowForUser } from '@/lib/server/workflow';
import { getFirstScanForUser, isFirstRun } from '@/lib/server/first-scan';
import { discoveryView } from '@/lib/first-discovery';

/** Recent scans read for the dashboard: enough to fold a few hours of quiet 30-minute scans into its handful of rows. */
const RECENT_SCANS = 30;

export default async function DashboardPage() {
  const session = await requireSession();
  const rankingNow = Date.now();
  const [records, profiles, legacy, scans, scanTotals, firstScan] = await Promise.all([listLeadsForUser(session.userId, 200, rankingNow), listProfilesForUser(session.userId), getLegacySummaryForUser(session.userId), listScanHistoryForUser(session.userId, RECENT_SCANS), getScanTotalsForUser(session.userId), getFirstScanForUser(session.userId)]);
  const workflow = await getWorkflowForUser(session.userId, records.map(record => record.id));
  // The first discovery leads the page until there is something to look at: while the first search is open, and
  // while QLead is still looking further after a first search that found nothing. Once leads exist they lead the
  // page, and an extra search still in progress is a single line above them.
  const view = firstScan ? discoveryView(firstScan) : null;
  const leadWithDiscovery = (isFirstRun(firstScan) || (view?.stage === 'more' && !view.initialLeads)) && !legacy;
  const notice = !leadWithDiscovery && view && (view.stage === 'more' || view.moreFinishedAt) ? firstScan : null;
  return <Dashboard records={records} profiles={profiles} legacy={legacy} scans={scans} scanTotals={scanTotals} firstRun={leadWithDiscovery ? firstScan : null} discovery={notice} workflow={workflow} rankingNow={rankingNow}/>;
}
