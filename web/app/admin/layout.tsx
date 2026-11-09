import Link from 'next/link';
import { Brand } from '@/components/visuals';
import { AdminNav } from '@/components/admin-nav';
import { requireAdmin } from '@/lib/server/admin';
import { noIndexMetadata } from '@/lib/seo';
import './admin.css';

export const dynamic = 'force-dynamic';
export const metadata = noIndexMetadata();

/** Every /admin route requires a signed-in user on the server-side admin allowlist; others get a 404. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  return <div className="admin-layout">
    <header className="admin-topbar">
      <div className="admin-topbar-inner">
        <Brand href="/admin/workers"/>
        <span className="admin-tag">Quản trị</span>
        <AdminNav/>
        <span className="admin-user">{session.displayName}</span>
        <Link className="btn btn-ghost btn-sm" href="/app">Về ứng dụng</Link>
      </div>
    </header>
    <main className="admin-content" id="admin-content">{children}</main>
  </div>;
}
