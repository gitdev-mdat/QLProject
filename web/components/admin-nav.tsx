'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/admin/users', label: 'Khách hàng' },
  { href: '/admin/workers', label: 'Tài khoản Muse' },
  { href: '/admin/group-requests', label: 'Đề xuất nhóm' },
];

export function AdminNav() {
  const path = usePathname();
  return <nav className="admin-nav" aria-label="Quản trị">{items.map(item => <Link key={item.href} href={item.href} aria-current={path.startsWith(item.href) ? 'page' : undefined}>{item.label}</Link>)}</nav>;
}
