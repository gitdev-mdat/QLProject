import type { Metadata } from 'next';
import { NotificationCenter } from '@/components/notification-center';
import { AppSettingsPage } from '@/components/pwa-settings';
import { listNotifications } from '@/lib/server/notifications';
import { requireSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Thông báo · QLead' };

/**
 * The account's notifications (what happened, e.g. an Admin paused or resumed lead search), then this device's app and
 * push settings. The list is the signed-in account's own; nothing is marked read here until the customer has seen it.
 */
export default async function NotificationsPage() {
  const session = await requireSession();
  const initial = await listNotifications(session.userId).catch(() => null);
  return <div className="notif-page">
    <header className="page-head"><div><h1>Thông báo</h1><p>Những thay đổi quan trọng với tài khoản của bạn.</p></div></header>
    <NotificationCenter initial={initial}/>
    <AppSettingsPage embedded/>
  </div>;
}
