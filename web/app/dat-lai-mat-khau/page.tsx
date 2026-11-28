import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth-screen';
import { ResetLinkInvalid, ResetPasswordForm } from '@/components/password-reset-forms';
import { resetLinkUsable } from '@/lib/server/password-reset';
import { pageMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';
// The link token is in the URL: never send it to another site in a Referer header.
export const metadata: Metadata = {
  ...pageMetadata({ title: 'Đặt mật khẩu mới · QLead', description: 'Đặt mật khẩu mới cho tài khoản QLead.', path: '/dat-lai-mat-khau', indexable: false }),
  referrer: 'no-referrer',
};

export default async function ResetPassword({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).ma;
  const token = typeof raw === 'string' ? raw : '';
  const usable = token ? await resetLinkUsable(token).catch(() => false) : false;
  return <AuthShell title={usable ? 'Đặt mật khẩu mới' : 'Đặt lại mật khẩu'} subtitle={usable ? 'Chọn mật khẩu mới cho tài khoản QLead của bạn.' : 'Link trong email chỉ dùng được một lần và trong thời gian ngắn.'}>
    {usable ? <ResetPasswordForm token={token}/> : <ResetLinkInvalid/>}
    <p className="auth-switch"><Link href="/dang-nhap">Quay lại đăng nhập</Link></p>
  </AuthShell>;
}
