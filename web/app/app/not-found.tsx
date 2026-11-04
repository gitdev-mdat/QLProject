import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { GoatMascot } from '@/components/goat-mascot';

export default function AppNotFound() {
  return <AppShell active="Danh sách lead"><div className="empty-state"><GoatMascot size="sm"/><h1>Không tìm thấy lead</h1><p>Lead này không tồn tại hoặc không thuộc tài khoản của bạn.</p><Link className="btn btn-outline" href="/app/bai-viet">Về danh sách lead</Link></div></AppShell>;
}
