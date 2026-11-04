import { LeadResultsPage } from '@/components/lead-results';
import { DiscoveryNotice } from '@/components/discovery-notice';
import { requireSession } from '@/lib/server/session';
import { listLeadsForUser } from '@/lib/server/leads';
import { listProfilesForUser } from '@/lib/server/profiles';
import { getWorkflowForUser } from '@/lib/server/workflow';
import { getFirstScanForUser } from '@/lib/server/first-scan';
import { discoveryView } from '@/lib/first-discovery';

/** `?nhu-cau=<profile id | legacy>` preselects the search filter; it only filters rows already scoped to this user. */
export default async function PostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const [records, profiles, params, firstScan] = await Promise.all([listLeadsForUser(session.userId, 200), listProfilesForUser(session.userId), searchParams, getFirstScanForUser(session.userId)]);
  const workflow = await getWorkflowForUser(session.userId, records.map(record => record.id));
  const source = typeof params['nhu-cau'] === 'string' ? params['nhu-cau'] : 'all';
  // While QLead is still looking further for the first need (or just finished doing so), the list says so in one line.
  const view = firstScan ? discoveryView(firstScan) : null;
  const relevant = source === 'all' || source === firstScan?.profile.id;
  const notice = firstScan && view && relevant && (view.stage === 'more' || view.moreFinishedAt) ? <DiscoveryNotice initial={firstScan} place="list"/> : null;
  return <LeadResultsPage records={records} workflow={workflow} profiles={profiles.map(({ id, name }) => ({ id, name }))} initialSource={source} notice={notice}/>;
}
