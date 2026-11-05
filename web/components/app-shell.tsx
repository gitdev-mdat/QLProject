'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { Brand, Icon } from './visuals';

export type ShellUser = { displayName: string; isDevSession: boolean; leadMonitoringStatus: 'active' | 'suspended'; isAdmin?: boolean };
const SessionContext = createContext<ShellUser | null>(null);

/** Set by app/app/layout.tsx from the server-side session; client pages read it for the shell. */
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
    try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { window.location.assign('/dang-nhap'); }
  }
  return <button type="button" className={`btn btn-ghost ${compact ? 'btn-sm' : 'btn-sm logout-btn'}`} onClick={logout} disabled={busy}>{busy ? 'Đang thoát…' : 'Đăng xuất'}</button>;
}

export function AppShell({ children, active = 'Hôm nay' }: { children: React.ReactNode; active?: NavLabel }) {
  const user = useContext(SessionContext);
  return <div className="app-layout">
    <a className="skip-link" href="#app-content">Bỏ qua điều hướng</a>
    <aside className="sidebar" aria-label="Điều hướng chính">
      <Brand href="/app"/>
      <nav className="side-nav">{navItems.map(item => <Link key={item.href} href={item.href} className={active === item.label ? 'active' : ''} aria-current={active === item.label ? 'page' : undefined}><Icon name={item.icon}/>{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        <div className="profile"><span className="avatar" aria-hidden="true"><Icon name="user" size={16}/></span><span><b>{user?.displayName ?? 'Khách'}</b><small>{user?.isDevSession ? 'Phiên DEV' : 'Đã đăng nhập'}</small></span></div>
        {user?.isAdmin && <Link className="btn btn-outline btn-sm admin-entry" href="/admin/workers"><Icon name="lock" size={16}/>Quản trị</Link>}
        <LogoutButton/>
      </div>
    </aside>
    <div className="app-main">
      <header className="app-topbar"><Brand href="/app"/>{user?.isAdmin && <Link className="btn btn-ghost btn-sm" href="/admin/workers">Quản trị</Link>}<LogoutButton compact/></header>
      {user?.isDevSession && <div className="preview-strip" role="note"><Icon name="info" size={16}/><span><b>Phiên đăng nhập nhanh DEV</b> · {user.displayName}. Dữ liệu thật từ Postgres cục bộ.</span></div>}
      {user?.leadMonitoringStatus === 'suspended' && <div className="monitoring-suspended" role="status"><Icon name="info" size={16}/><span><b>Tính năng tìm lead của tài khoản đang tạm dừng.</b> Bạn vẫn có thể xem lead và lịch sử đã lưu. Lượt tìm mới sẽ không được tạo.</span></div>}
      <main className="app-content" id="app-content">{children}</main>
    </div>
    <nav className="bottom-nav" aria-label="Điều hướng chính">{navItems.map(item => <Link key={item.href} href={item.href} className={active === item.label ? 'active' : ''} aria-current={active === item.label ? 'page' : undefined}><Icon name={item.icon} size={20}/><span>{item.label === 'Danh sách lead' ? 'Lead' : item.label === 'Nhu cầu theo dõi' ? 'Theo dõi' : item.label === 'Đề xuất nhóm' ? 'Đề xuất' : item.label}</span></Link>)}</nav>
  </div>;
}
