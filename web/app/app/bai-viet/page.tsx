import { redirect } from 'next/navigation';
import { LeadResultsPage } from '@/components/lead-results';
import { DiscoveryNotice } from '@/components/discovery-notice';
import { requireSession } from '@/lib/server/session';
import { listLeadPageForUser, SCOPED_LEAD_LIMIT, type LeadScope } from '@/lib/server/leads';
import { getLegacySummaryForUser, listProfilesForUser } from '@/lib/server/profiles';
import { getWorkflowForUser } from '@/lib/server/workflow';
import { getFirstScanForUser } from '@/lib/server/first-scan';
import { discoveryView } from '@/lib/first-discovery';
import { LEGACY_FILTER } from '@/lib/lead-source';

/** Newest leads shown when no need is selected. A selected need loads all of its own leads (up to SCOPED_LEAD_LIMIT). */
const ALL_LEADS_LIMIT = 200;

/**
 * `?nhu-cau=<profile id | legacy>` is the single source of truth for the need filter: the server reads it, loads that
 * need's leads with a tenant-scoped query and passes the resolved value down; the dropdown only changes the URL. An id
 * that is not one of this user's active needs (unknown, deleted, someone else's, malformed) falls back to every need
 * with a clean URL, so nothing about other accounts is revealed.
 */
export default async function PostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const [profiles, legacy, params, firstScan] = await Promise.all([listProfilesForUser(session.userId), getLegacySummaryForUser(session.userId), searchParams, getFirstScanForUser(session.userId)]);
  const requested = params['nhu-cau'];
  let source = 'all';
  if (requested !== undefined) {
    const value = typeof requested === 'string' ? requested.trim() : null;
    const known = value !== null && (value === LEGACY_FILTER ? Boolean(legacy) : profiles.some(profile => profile.id === value));
    if (!known) redirect('/app/bai-viet');
    source = value;
  }
  const scope: LeadScope = source === 'all' ? { kind: 'all' } : source === LEGACY_FILTER ? { kind: 'legacy' } : { kind: 'profile', profileId: source };
  const { leads: records, total, delivery } = await listLeadPageForUser(session.userId, scope, scope.kind === 'all' ? ALL_LEADS_LIMIT : SCOPED_LEAD_LIMIT);
  const workflow = await getWorkflowForUser(session.userId, records.map(record => record.id));
  // While QLead is still looking further for the first need (or just finished doing so), the list says so in one line.
  const view = firstScan ? discoveryView(firstScan) : null;
  const relevant = source === 'all' || source === firstScan?.profile.id;
  const notice = firstScan && view && relevant && (view.stage === 'more' || view.moreFinishedAt) ? <DiscoveryNotice initial={firstScan} place="list"/> : null;
  return <LeadResultsPage key={source} records={records} total={total} workflow={workflow} profiles={profiles.map(({ id, name }) => ({ id, name }))} hasLegacy={Boolean(legacy?.leadCount)} source={source} notice={notice} delivery={delivery} latestOnly={params['luot'] === 'moi'} hotOnly={params['hot'] === '1'} unreadFirst={params['chua-xem'] === '1'}/>;
}
