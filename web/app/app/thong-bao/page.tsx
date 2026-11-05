import type { Metadata } from 'next';
import { AppSettingsPage } from '@/components/pwa-settings';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Ứng dụng và thông báo · QLead' };

/** Install QLead on this device and turn new-lead notifications on or off. Everything here is per device. */
export default async function NotificationsPage() {
  await requireSession();
  return <AppSettingsPage/>;
}
