'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Brand, Icon } from './visuals';
import { PwaIcon } from './pwa-icons';
import { InstallHint, PwaRuntime } from './pwa-runtime';
import { releaseSubscriptionOnLogout } from '@/lib/push-client';
import '@/lib/install-prompt';
import './pwa.css';

export type ShellUser = { displayName: string; isDevSession: boolean; leadMonitoringStatus: 'active' | 'suspended'; isAdmin?: boolean; pushOwner?: string };
const SessionContext = createContext<ShellUser | null>(null);

/** Set by app/app/layout.tsx from the server-side session; client pages read it for the shell. */
/** Which account this device's push subscription was turned on for (see lib/push-client.ts). */
export function usePushOwner(): string | null {
  return useContext(SessionContext)?.pushOwner ?? null;
}

/** True while an admin has stopped new lead searches for this account; saved leads and settings stay available. */
export function useMonitoringSuspended(): boolean {
  return useContext(SessionContext)?.leadMonitoringStatus === 'suspended';
}

export function SessionProvider({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [current, setCurrent] = useState(user);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/account/monitoring', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { status?: 'active' | 'suspended' };
        if (live && (data.status === 'active' || data.status === 'suspended')) setCurrent(value => ({ ...value, leadMonitoringStatus: data.status! }));
      } catch { /* The server-rendered status remains available if a poll is temporarily offline. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  return <SessionContext.Provider value={current}>{children}</SessionContext.Provider>;
}

const navItems = [
  { href: '/app', icon: 'today', label: 'Hôm nay' },
  { href: '/app/bai-viet', icon: 'list', label: 'Danh sách lead' },
  { href: '/app/bo-loc', icon: 'target', label: 'Nhu cầu theo dõi' },
  { href: '/app/de-xuat-nhom', icon: 'group', label: 'Đề xuất nhóm' },
] as const;
export type NavLabel = typeof navItems[number]['label'];

function LogoutButton({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    // This device stops receiving the account's lead notifications before the session ends (bounded, never blocks logout).
    try { await releaseSubscriptionOnLogout(); await fetch('/api/auth/logout', { method: 'POST' }); } finally { window.location.assign('/dang-nhap'); }
  }
  return <button type="button" className={`btn btn-ghost ${compact ? 'btn-sm' : 'btn-sm logout-btn'}`} onClick={logout} disabled={busy}>{busy ? 'Đang thoát…' : 'Đăng xuất'}</button>;
}

/** Which main navigation item a path belongs to (scan history and the first-search view live under Hôm nay). */
export function navLabelFor(path: string): NavLabel {
  return navItems.find(item => item.href !== '/app' && (path === item.href || path.startsWith(`${item.href}/`)))?.label ?? 'Hôm nay';
}

/** True inside the persistent frame rendered by app/app/layout.tsx; page-level AppShell wrappers then render only their content. */
const FrameContext = createContext(false);

/**
 * The persistent application frame for every /app route: sidebar, top bar, banners and bottom navigation stay mounted
 * while only <main> changes. The active item follows the URL, and switches on click (before the server answers), so a
 * navigation gives feedback within a frame even when the destination's data is still loading.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [pending, setPending] = useState<string | null>(null);
  // The optimistic item only bridges the click and the URL change (the loading boundary commits the new URL within a
  // frame or two). It is dropped as soon as the URL changes, and on back/forward, which can cancel a navigation before
  // it commits; a navigation that fails falls back to a full page load, which resets it as well.
  useEffect(() => { setPending(null); }, [path]);
  useEffect(() => {
    const clear = () => setPending(null);
    window.addEventListener('popstate', clear);
    return () => window.removeEventListener('popstate', clear);
  }, []);
  const active = navLabelFor(pending ?? path);
  const onNav = (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks open a new tab or window; this tab does not navigate.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setPending(href);
  };
  return <FrameContext.Provider value={true}><PwaRuntime/><ShellChrome active={active} onNav={onNav}>{path === '/app' && <InstallHint/>}{children}</ShellChrome></FrameContext.Provider>;
}

/**
 * Pages call AppShell with their nav item. Under /app the layout's AppFrame already draws the shell, so this only
 * passes the content through; outside a frame (none today) it draws a static shell itself.
 */
export function AppShell({ children, active = 'Hôm nay' }: { children: React.ReactNode; active?: NavLabel }) {
  const framed = useContext(FrameContext);
  if (framed) return <>{children}</>;
  return <ShellChrome active={active}>{children}</ShellChrome>;
}

function ShellChrome({ children, active, onNav }: { children: React.ReactNode; active: NavLabel; onNav?: (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => void }) {
  const user = useContext(SessionContext);
  const path = usePathname();
  return <div className="app-layout">
    <a className="skip-link" href="#app-content">Bỏ qua điều hướng</a>
    <aside className="sidebar" aria-label="Điều hướng chính">
      <Brand href="/app"/>
      <nav className="side-nav">{navItems.map(item => <Link key={item.href} href={item.href} onClick={onNav?.(item.href)} className={active === item.label ? 'active' : ''} aria-current={active === item.label ? 'page' : undefined}><Icon name={item.icon}/>{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        <div className="profile"><span className="avatar" aria-hidden="true"><Icon name="user" size={16}/></span><span><b>{user?.displayName ?? 'Khách'}</b><small>{user?.isDevSession ? 'Phiên DEV' : 'Đã đăng nhập'}</small></span></div>
        <Link className={`side-settings${path === '/app/thong-bao' ? ' active' : ''}`} href="/app/thong-bao" aria-current={path === '/app/thong-bao' ? 'page' : undefined}><PwaIcon name="bell" size={18}/>Ứng dụng và thông báo</Link>
        {user?.isAdmin && <Link className="btn btn-outline btn-sm admin-entry" href="/admin/workers"><Icon name="lock" size={16}/>Quản trị</Link>}
        <LogoutButton/>
      </div>
    </aside>
    <div className="app-main">
      <header className="app-topbar"><Brand href="/app"/><Link className="topbar-bell" href="/app/thong-bao" aria-label="Ứng dụng và thông báo" aria-current={path === '/app/thong-bao' ? 'page' : undefined}><PwaIcon name="bell" size={20}/></Link>{user?.isAdmin && <Link className="btn btn-ghost btn-sm" href="/admin/workers">Quản trị</Link>}<LogoutButton compact/></header>
      {user?.isDevSession && <div className="preview-strip" role="note"><Icon name="info" size={16}/><span><b>Phiên đăng nhập nhanh DEV</b> · {user.displayName}. Dữ liệu thật từ Postgres cục bộ.</span></div>}
      {user?.leadMonitoringStatus === 'suspended' && <div className="monitoring-suspended" role="status"><Icon name="info" size={16}/><span><b>Tính năng tìm lead của tài khoản đang tạm dừng.</b> Bạn vẫn có thể xem lead và lịch sử đã lưu. Lượt tìm mới sẽ không được tạo.</span></div>}
      <main className="app-content" id="app-content">{children}</main>
    </div>
    <nav className="bottom-nav" aria-label="Điều hướng chính">{navItems.map(item => <Link key={item.href} href={item.href} onClick={onNav?.(item.href)} className={active === item.label ? 'active' : ''} aria-current={active === item.label ? 'page' : undefined}><Icon name={item.icon} size={20}/><span>{item.label === 'Danh sách lead' ? 'Lead' : item.label === 'Nhu cầu theo dõi' ? 'Theo dõi' : item.label === 'Đề xuất nhóm' ? 'Đề xuất' : item.label}</span></Link>)}</nav>
  </div>;
}
