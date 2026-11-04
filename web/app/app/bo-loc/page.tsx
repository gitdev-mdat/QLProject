import '@/components/profiles-page.css';
import { ProfilesPage } from '@/components/profiles-page';
import { requireSession } from '@/lib/server/session';
import { getLegacySummaryForUser, listProfilesForUser } from '@/lib/server/profiles';

export default async function FiltersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const [profiles, legacy, params] = await Promise.all([listProfilesForUser(session.userId), getLegacySummaryForUser(session.userId), searchParams]);
  return <ProfilesPage profiles={profiles} legacy={legacy} startCreating={params.tao === '1'}/>;
}
