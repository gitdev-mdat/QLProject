import Link from 'next/link';
import { AuthShell } from '@/components/auth-screen';
import { ForgotPasswordForm } from '@/components/password-reset-forms';
import { pageMetadata } from '@/lib/seo';
import { RESET_RULES } from '../../../src/password-reset';

export const metadata = pageMetadata({
  title: 'Quên mật khẩu QLead',
  description: 'Nhận link qua email để đặt lại mật khẩu tài khoản QLead.',
  path: '/quen-mat-khau',
  indexable: false,
});

export default function ForgotPassword() {
  return <AuthShell title="Quên mật khẩu?" subtitle="Nhập email bạn dùng để đăng nhập. QLead sẽ gửi link để bạn đặt mật khẩu mới.">
    <ForgotPasswordForm linkMinutes={RESET_RULES.linkMinutes}/>
    <p className="auth-switch">Nhớ ra mật khẩu rồi? <Link href="/dang-nhap">Quay lại đăng nhập</Link></p>
  </AuthShell>;
}
