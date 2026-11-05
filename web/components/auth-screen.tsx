'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Brand, Icon } from './visuals';
import { GoatMascot } from './goat-mascot';

const AUTH_ERRORS: Record<string, string> = {
  email_taken: 'Email này đã có tài khoản. Hãy đăng nhập.',
  invalid_credentials: 'Email hoặc mật khẩu không đúng.',
  too_many_attempts: 'Bạn đã thử quá nhiều lần. Hãy đợi một lúc rồi thử lại.',
  invalid_request: 'Kiểm tra lại thông tin: email hợp lệ, mật khẩu từ 8 ký tự.',
};

/** Real email + password form: the server creates the account or verifies it, then sets the session cookie. */
function AuthForm({ mode, returnTo = null }: { mode: 'login' | 'register'; returnTo?: string | null }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm(current => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const body = mode === 'register' ? form : { email: form.email, password: form.password };
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})) as { redirect?: string; error?: string };
      if (!response.ok || !data.redirect) throw new Error(AUTH_ERRORS[data.error ?? ''] ?? 'Không thực hiện được. Thử lại sau ít phút.');
      // A notification tap that needed a sign-in continues to its lead page; onboarding and Admin keep their own landing.
      window.location.assign(returnTo && data.redirect === '/app' ? returnTo : data.redirect);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không thực hiện được.');
      setBusy(false);
    }
  }

  return <form className="auth-form" onSubmit={submit}>
    {mode === 'register' && <label className="field">Tên của bạn<span className="input-adorned"><Icon name="user" size={18}/><input type="text" autoComplete="name" placeholder="Ví dụ: Linh Nguyễn" value={form.name} onChange={set('name')} maxLength={200} required/></span></label>}
    <label className="field">Email công việc<span className="input-adorned"><Icon name="mail" size={18}/><input type="email" autoComplete="email" placeholder="ban@congty.vn" value={form.email} onChange={set('email')} required/></span></label>
    <label className="field">Mật khẩu<span className="input-adorned"><Icon name="lock" size={18}/><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 8 : undefined} maxLength={200} placeholder={mode === 'register' ? 'Ít nhất 8 ký tự' : 'Mật khẩu của bạn'} value={form.password} onChange={set('password')} required/><button className="input-toggle" type="button" aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eyeOff' : 'eye'} size={18}/></button></span></label>
    <button className="btn btn-primary btn-lg full" type="submit" disabled={busy}>{busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'} {!busy && <Icon name="arrow" size={18}/>}</button>
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
  </form>;
}

export type DevLoginOption = { key: string; label: string };

/** Rendered only when the server-side DEV gate allows it; the API re-checks every condition on click. */
function DevQuickLogin({ users }: { users: DevLoginOption[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function login(key: string) {
    setBusy(key); setError('');
    try {
      const response = await fetch('/api/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-dev-login': '1' }, body: JSON.stringify({ user: key }) });
      const data = await response.json().catch(() => ({})) as { redirect?: string; message?: string; error?: string };
      if (!response.ok || !data.redirect) throw new Error(data.message ?? data.error ?? 'Không đăng nhập được.');
      window.location.assign(data.redirect);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không đăng nhập được.');
      setBusy(null);
    }
  }
  return <section className="dev-login" aria-labelledby="dev-login-title">
    <h2 id="dev-login-title"><span className="dev-badge">DEV</span>Đăng nhập nhanh</h2>
    <p>Chỉ có khi chạy next dev trên localhost với ENABLE_DEV_QUICK_LOGIN=true.</p>
    <div className="dev-login-buttons">{users.map(user => <button key={user.key} type="button" className="btn btn-outline" disabled={busy !== null} onClick={() => login(user.key)}>{busy === user.key ? 'Đang đăng nhập…' : user.label}</button>)}</div>
    {error && <p className="warning-line" role="alert">{error}</p>}
  </section>;
}

export function AuthScreen({ mode, devUsers = [], signedInAs = null, returnTo = null }: { mode: 'login' | 'register'; devUsers?: DevLoginOption[]; signedInAs?: string | null; returnTo?: string | null }) {
  const isLogin = mode === 'login';
  return <div className="auth-layout">
    <section className="auth-aside">
      <Brand/>
      <div className="auth-aside-body">
        <div className="auth-goat"><GoatMascot size="lg"/></div>
        <h2>{isLogin ? 'Lead mới đang chờ bạn xem.' : 'Thời gian là vàng bạc'}</h2>
        <ul>
          <li><span><Icon name="radar" size={18}/></span>Bài đăng có tín hiệu kinh doanh theo ngành bạn bán</li>
          <li><span><Icon name="eye" size={18}/></span>Biết bài nào mới đăng, bài nào chưa xem</li>
          <li><span><Icon name="external" size={18}/></span>Mở bài Facebook gốc trong một chạm</li>
        </ul>
      </div>
      <p className="auth-aside-foot">© QLead · Tìm lead từ Facebook cho đội sales</p>
    </section>
    <main className="auth-main">
      <div className="auth-mobile-brand"><Brand/></div>
      <div className="auth-card">
        <div className="auth-card-head">
          <h1>{isLogin ? 'Chào mừng trở lại' : 'Tạo tài khoản QLead'}</h1>
          <p>{isLogin ? 'Đăng nhập để tiếp tục xem lead mới của bạn.' : 'Thiết lập nhu cầu theo dõi đầu tiên trong vài phút.'}</p>
        </div>
        {signedInAs && <p className="auth-signed-in" role="status"><Icon name="info" size={16}/><span>Trình duyệt đang đăng nhập với tên <b>{signedInAs}</b>. {isLogin ? 'Đăng nhập' : 'Tạo tài khoản'} sẽ thay phiên này. <Link href={returnTo ?? '/app'}>Tiếp tục với {signedInAs}</Link></span></p>}
        <AuthForm mode={mode} returnTo={returnTo}/>
        {isLogin && devUsers.length > 0 && <DevQuickLogin users={devUsers}/>}
        <p className="auth-switch">{isLogin ? <>Chưa có tài khoản? <Link href="/dang-ky">Tạo tài khoản</Link></> : <>Đã có tài khoản? <Link href="/dang-nhap">Đăng nhập</Link></>}</p>
      </div>
    </main>
  </div>;
}
