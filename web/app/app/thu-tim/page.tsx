import type { Metadata } from 'next';
import { LandingHandoffPage } from '@/components/landing-handoff';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Kết quả tìm thử · QLead' };

/** Where a customer who signs in from the landing search lands: the leads they just found, in full. */
export default async function LandingTryPage() {
  await requireSession();
  return <LandingHandoffPage/>;
}
