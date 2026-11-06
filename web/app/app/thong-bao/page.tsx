import type { Metadata } from 'next';
import { NotificationCenter } from '@/components/notification-center';
import { AppSettingsPage } from '@/components/pwa-settings';
import { FeedbackEntry } from '@/components/customer-feedback';
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
    {/* The customer's own way to send feedback (also in the desktop sidebar); it never opens by itself. */}
    <section className="fb-entry-card" aria-label="Góp ý cho QLead">
      <p><b>Góp ý cho QLead</b>Điều gì dễ dùng, điều gì cần tốt hơn? QLead đọc mọi góp ý.</p>
      <FeedbackEntry owner={null} className="btn btn-outline">Gửi góp ý</FeedbackEntry>
    </section>
  </div>;
}
