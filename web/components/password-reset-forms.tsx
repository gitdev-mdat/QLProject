'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './visuals';

const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Step 1 of "Quên mật khẩu": the customer enters an email. The server answers the same way whether or not the email
 * has an account, so the confirmation is worded "nếu email này có tài khoản".
 */
export function ForgotPasswordForm({ linkMinutes }: { linkMinutes: number }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function send(target: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: target }) });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (response.status === 429) throw new Error('Bạn đã yêu cầu quá nhiều lần. Hãy đợi khoảng một giờ rồi thử lại.');
      if (response.status === 400) throw new Error('Email chưa đúng định dạng. Kiểm tra lại giúp QLead.');
      if (!response.ok || !data.ok) throw new Error('Chưa gửi được. Thử lại sau ít phút.');
      setSentTo(target.trim());
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chưa gửi được. Thử lại sau ít phút.');
    } finally { setBusy(false); }
  }

  if (sentTo) return <div className="auth-sent" role="status">
    <span className="auth-sent-icon"><Icon name="mail" size={26}/></span>
    <h2>Kiểm tra hộp thư của bạn</h2>
    <p>Nếu <b>{sentTo}</b> có tài khoản QLead, chúng tôi vừa gửi link đặt lại mật khẩu. Link dùng được một lần và hết hạn sau {linkMinutes} phút.</p>
    <p className="auth-sent-tip">Không thấy email sau vài phút? Hãy xem thư mục Spam hoặc Quảng cáo.</p>
    <div className="auth-sent-actions">
      <button type="button" className="btn btn-outline full" disabled={busy || cooldown > 0} onClick={() => send(sentTo)}>
        {busy ? 'Đang gửi…' : cooldown > 0 ? `Gửi lại sau ${cooldown} giây` : 'Gửi lại email'}
      </button>
      <button type="button" className="auth-link-button" onClick={() => { setSentTo(null); setError(''); }}>Dùng email khác</button>
    </div>
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
  </div>;

  return <form className="auth-form" onSubmit={event => { event.preventDefault(); void send(email); }}>
    <label className="field">Email đã đăng ký<span className="input-adorned"><Icon name="mail" size={18}/><input type="email" autoComplete="email" placeholder="ban@congty.vn" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} required autoFocus/></span></label>
    <button className="btn btn-primary btn-lg full" type="submit" disabled={busy}>{busy ? 'Đang gửi…' : 'Gửi link đặt lại mật khẩu'} {!busy && <Icon name="arrow" size={18}/>}</button>
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
  </form>;
}

/** Shown when a link is unknown, expired, already used or replaced by a newer one. */
export function ResetLinkInvalid() {
  return <div className="auth-sent" role="status">
    <span className="auth-sent-icon is-warning"><Icon name="clock" size={26}/></span>
    <h2>Link không còn dùng được</h2>
    <p>Link đặt lại mật khẩu đã hết hạn, đã được dùng, hoặc đã có link mới hơn. Hãy yêu cầu link mới.</p>
    <div className="auth-sent-actions">
      <Link className="btn btn-primary btn-lg full" href="/quen-mat-khau">Gửi link mới <Icon name="arrow" size={18}/></Link>
    </div>
  </div>;
}

/** Step 2: the page the emailed link opens. The token is removed from the address bar as soon as the page loads. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) { setError('Mật khẩu mới cần ít nhất 8 ký tự.'); return; }
    if (password !== confirm) { setError('Hai mật khẩu chưa khớp nhau.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
      const data = await response.json().catch(() => ({})) as { redirect?: string; error?: string };
      if (response.status === 410) { setInvalid(true); return; }
      if (response.status === 429) throw new Error('Bạn đã thử quá nhiều lần. Hãy đợi một lúc rồi thử lại.');
      if (!response.ok || !data.redirect) throw new Error('Chưa đổi được mật khẩu. Thử lại sau ít phút.');
      window.location.assign(data.redirect);
      return;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chưa đổi được mật khẩu.');
    }
    setBusy(false);
  }

  if (invalid) return <ResetLinkInvalid/>;
  const toggle = <button className="input-toggle" type="button" aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={show} onClick={() => setShow(value => !value)}><Icon name={show ? 'eyeOff' : 'eye'} size={18}/></button>;
  return <form className="auth-form" onSubmit={submit}>
    <label className="field">Mật khẩu mới<span className="input-adorned"><Icon name="lock" size={18}/><input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={200} placeholder="Ít nhất 8 ký tự" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={tooShort} required autoFocus/>{toggle}</span>
      {tooShort && <small>Cần ít nhất 8 ký tự.</small>}</label>
    <label className="field">Nhập lại mật khẩu mới<span className="input-adorned"><Icon name="lock" size={18}/><input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={200} placeholder="Nhập lại để chắc chắn" value={confirm} onChange={event => setConfirm(event.target.value)} aria-invalid={mismatch} required/></span>
      {mismatch && <small>Hai mật khẩu chưa khớp nhau.</small>}</label>
    <button className="btn btn-primary btn-lg full" type="submit" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu mật khẩu mới'} {!busy && <Icon name="check" size={18}/>}</button>
    <p className="auth-note"><Icon name="info" size={16}/><span>Sau khi đổi, QLead đăng xuất tài khoản trên mọi thiết bị. Bạn đăng nhập lại bằng mật khẩu mới.</span></p>
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
  </form>;
}
