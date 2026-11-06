'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './visuals';
import { PwaIcon } from './pwa-icons';
import { useInstallPrompt } from '@/lib/install-prompt';
import { InstallButton } from './install-guide';
import { detectPlatform, isStandalone, pushBlocker, type Platform } from '@/lib/pwa';
import { disablePush, enablePush, fetchPushConfig, PushError, reportPushFailure, sendTestPush, syncSubscription } from '@/lib/push-client';
import { usePushOwner } from './app-shell';

type Env = { platform: Platform; standalone: boolean };

/** Browser facts are read after mount; the server render shows a neutral loading state instead of guessing. */
function useEnv(): Env | null {
  const [env, setEnv] = useState<Env | null>(null);
  useEffect(() => {
    const read = () => setEnv({ platform: detectPlatform(), standalone: isStandalone() });
    read();
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener?.('change', read);
    return () => media.removeEventListener?.('change', read);
  }, []);
  return env;
}

export function AppSettingsPage({ embedded = false }: { embedded?: boolean }) {
  const env = useEnv();
  const { installed } = useInstallPrompt();
  // Running as the installed app: nothing about installing is shown, only this device's notifications.
  const appMode = env?.standalone === true;
  const title = appMode ? 'Thông báo trên thiết bị này' : 'Ứng dụng và thông báo trên thiết bị này';
  const intro = appMode
    ? 'Bật để biết ngay khi QLead tìm thấy khách hàng tiềm năng mới.'
    : 'Cài QLead để mở nhanh như một ứng dụng và nhận thông báo khi có khách hàng tiềm năng mới.';
  // iPhone only offers notifications to the Home Screen app, so installing comes first there.
  const installFirst = env?.platform === 'ios' && !appMode;
  const install = env && !appMode ? <InstallCard env={env} installed={installed}/> : null;
  return <div className="pwa-page">
    {embedded
      ? <header className="pwa-section-head"><h2>{title}</h2><p>{intro}</p></header>
      : <header className="page-head"><div><h1>{title}</h1><p>{intro}</p></div></header>}
    <div className="pwa-grid">
      {installFirst && install}
      <PushCard env={env}/>
      {!installFirst && install}
    </div>
  </div>;
}

/* ───────────────────────────── Install ───────────────────────────── */

function InstallCard({ env, installed }: { env: Env; installed: boolean }) {
  const [note, setNote] = useState('');
  // The browser said QLead was just installed, but this page is still the browser tab.
  if (installed) {
    return <section className="panel pwa-card" id="cai-dat" aria-labelledby="install-title">
      <div className="pwa-card-head"><span className="pwa-card-icon is-done"><Icon name="check" size={20}/></span><div><h2 id="install-title">Đã cài QLead</h2><p>Mở QLead từ biểu tượng con dê trên màn hình chính.</p></div></div>
    </section>;
  }
  const phone = env.platform === 'ios' || env.platform === 'android';
  return <section className="panel pwa-card" id="cai-dat" aria-labelledby="install-title">
    <div className="pwa-card-head">
      <span className="pwa-card-icon"><PwaIcon name="phone" size={20}/></span>
      <div><h2 id="install-title">Cài QLead</h2><p>{phone ? 'Mở QLead bằng một chạm từ màn hình chính.' : 'Mở QLead trong cửa sổ riêng, không cần tìm tab.'}</p></div>
    </div>
    <div className="pwa-actions">
      <InstallButton onOutcome={outcome => setNote(outcome === 'dismissed' ? 'Chưa cài. Nhấn Cài QLead khi bạn sẵn sàng.' : '')}/>
    </div>
    {note && <p className="pwa-hint" role="status"><span>{note}</span></p>}
  </section>;
}

/* ───────────────────────────── Push ───────────────────────────── */

/**
 * What went wrong while turning notifications on, in words the person can act on, plus a short code (step and error
 * name or HTTP status) they can send to support. Only for failures not handled as their own state.
 */
export function pushFailureText(error: unknown): string {
  const failure = error instanceof PushError ? error : null;
  const code = failure?.stage ? ` (mã: ${failure.stage}${failure.detail ? `/${failure.detail}` : ''})` : '';
  if (!failure || failure.code === 'network') return `Không kết nối được với QLead. Kiểm tra mạng rồi thử lại.${code}`;
  if (failure.code === 'device' && failure.stage === 'service_worker') return `Thiết bị chưa cài được phần nhận thông báo của QLead. Đóng hẳn QLead, mở lại từ biểu tượng trên màn hình chính rồi thử lại.${code}`;
  if (failure.code === 'device' && failure.stage === 'subscribe') return failure.detail === 'NotAllowedError'
    ? `Thiết bị đang chặn thông báo của QLead. Vào Cài đặt › Thông báo › QLead để cho phép, rồi thử lại.${code}`
    : `Dịch vụ thông báo của thiết bị chưa phản hồi. Thử lại sau ít phút.${code}`;
  if (failure.code === 'device') return `Thiết bị chưa bật được thông báo. Thử lại sau ít phút.${code}`;
  if (failure.stage === 'test' && failure.code === 'server') return `Dịch vụ thông báo của Apple/Google chưa nhận thông báo thử. QLead đã ghi lại lỗi để xử lý.${code}`;
  if (failure.code === 'forbidden') return `QLead chưa xác minh được trang đang mở. Mở QLead từ địa chỉ qlead.vn rồi thử lại.${code}`;
  return `QLead chưa lưu được thiết bị này. Thử lại sau ít phút.${code}`;
}

type PushState =
  | { kind: 'loading' }
  | { kind: 'blocked-env'; reason: 'ios-needs-install' | 'ios-too-old' | 'unsupported' }
  | { kind: 'not-configured' }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  | { kind: 'off'; key: string; dismissed?: boolean }
  | { kind: 'on'; key: string };

function PushCard({ env }: { env: Env | null }) {
  const [state, setState] = useState<PushState>({ kind: 'loading' });
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const owner = usePushOwner();
  const load = useCallback(async () => {
    const blocker = pushBlocker();
    if (blocker) { setState({ kind: 'blocked-env', reason: blocker }); return; }
    if (Notification.permission === 'denied') { setState({ kind: 'denied' }); return; }
    try {
      const config = await fetchPushConfig();
      if (!config.enabled || !config.vapidPublicKey) { setState({ kind: 'not-configured' }); return; }
      const on = Notification.permission === 'granted' ? await syncSubscription(owner) : false;
      setState(on ? { kind: 'on', key: config.vapidPublicKey } : { kind: 'off', key: config.vapidPublicKey });
    } catch (error) {
      if (error instanceof PushError && error.code === 'unauthorized') setState({ kind: 'signed-out' });
      else if (error instanceof PushError && error.code === 'not_configured') setState({ kind: 'not-configured' });
      else { setState({ kind: 'not-configured' }); setMessage({ tone: 'warn', text: 'Chưa tải được trạng thái thông báo. Kiểm tra mạng rồi tải lại trang.' }); }
    }
  }, [owner]);

  useEffect(() => { if (env) void load(); }, [env, load]);
  // Permission can change in browser settings while QLead stays open; re-read it when the person comes back.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const fail = (error: unknown) => {
    if (error instanceof PushError) {
      if (error.code === 'unauthorized') { setState({ kind: 'signed-out' }); return; }
      if (error.code === 'not_configured') { setState({ kind: 'not-configured' }); return; }
      if (error.code === 'rate_limited') { setMessage({ tone: 'warn', text: `Vừa gửi thử rồi. Đợi ${error.retryAfterSeconds ?? 30} giây rồi thử lại.` }); return; }
      if (error.code === 'not_subscribed') { void load(); setMessage({ tone: 'warn', text: 'Thiết bị này chưa được đăng ký. Hãy bật lại thông báo.' }); return; }
    }
    setMessage({ tone: 'warn', text: pushFailureText(error) });
  };

  const enable = async (key: string) => {
    setBusy('enable'); setMessage(null);
    try {
      const result = await enablePush(key, owner);
      if (result === 'granted') { setState({ kind: 'on', key }); setMessage({ tone: 'ok', text: 'Đã bật. QLead sẽ báo khi tìm thấy khách hàng tiềm năng mới.' }); }
      else if (result === 'denied') setState({ kind: 'denied' });
      else setState({ kind: 'off', key, dismissed: true });
    } catch (error) { reportPushFailure(error); fail(error); } finally { setBusy(null); }
  };

  const disable = async (key: string) => {
    setBusy('disable'); setMessage(null);
    try { await disablePush(); setState({ kind: 'off', key }); setMessage({ tone: 'ok', text: 'Đã tắt thông báo trên thiết bị này.' }); } catch (error) { fail(error); } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy('test'); setMessage(null);
    try { await sendTestPush(); setMessage({ tone: 'ok', text: 'Đã gửi. Thông báo thử sẽ đến trong vài giây.' }); } catch (error) { fail(error); } finally { setBusy(null); }
  };

  const on = state.kind === 'on';
  return <section className="panel pwa-card" id="thong-bao" aria-labelledby="push-title" aria-busy={state.kind === 'loading'}>
    <div className="pwa-card-head">
      <span className={`pwa-card-icon${on ? ' is-done' : ''}`}><PwaIcon name={on ? 'bell' : 'bellOff'} size={20}/></span>
      <div><h2 id="push-title">Thông báo lead mới</h2><p>Nhận thông báo khi QLead tìm thấy khách hàng tiềm năng mới.</p></div>
      {(state.kind === 'on' || state.kind === 'off') && <span className={`pwa-status${on ? ' is-on' : ''}`}>{on ? 'Đã bật' : 'Chưa bật'}</span>}
    </div>

    {state.kind === 'loading' && <div className="pwa-skeleton"/>}

    {state.kind === 'off' && <div className="pwa-actions">
      <button type="button" className="btn btn-primary" onClick={() => enable(state.key)} disabled={busy !== null}><PwaIcon name="bell" size={18}/>{busy === 'enable' ? 'Đang bật…' : 'Bật thông báo'}</button>
      {state.dismissed && <p className="pwa-hint" role="status"><span>Bạn chưa cho phép. Nhấn <b>Bật thông báo</b> khi bạn sẵn sàng.</span></p>}
    </div>}

    {state.kind === 'on' && <div className="pwa-actions">
      <button type="button" className="btn btn-outline btn-sm" onClick={test} disabled={busy !== null}>{busy === 'test' ? 'Đang gửi…' : 'Gửi thông báo thử'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => disable(state.key)} disabled={busy !== null}>{busy === 'disable' ? 'Đang tắt…' : 'Tắt thông báo'}</button>
    </div>}

    {state.kind === 'denied' && <DeniedHelp platform={env?.platform ?? 'other'} standalone={env?.standalone ?? false}/>}

    {state.kind === 'blocked-env' && (state.reason === 'ios-needs-install'
      ? <p className="pwa-hint"><Icon name="info" size={16}/><span>iPhone chỉ cho bật thông báo trong QLead đã cài. Nhấn <b>Cài QLead</b> ở trên, rồi mở QLead từ màn hình chính.</span></p>
      : state.reason === 'ios-too-old'
        ? <p className="pwa-hint"><Icon name="info" size={16}/><span>Thông báo trên iPhone cần iOS 16.4 trở lên. Hãy cập nhật iOS rồi thử lại.</span></p>
        : <p className="pwa-hint"><Icon name="info" size={16}/><span>Trình duyệt này chưa hỗ trợ thông báo đẩy. Hãy dùng Chrome hoặc Edge, hoặc Safari trên iPhone sau khi thêm QLead vào màn hình chính.</span></p>)}

    {state.kind === 'not-configured' && <p className="pwa-hint"><Icon name="info" size={16}/><span>Thông báo đang được chuẩn bị. Bạn sẽ bật được tại đây khi sẵn sàng.</span></p>}

    {state.kind === 'signed-out' && <p className="pwa-hint"><Icon name="info" size={16}/><span>Phiên đăng nhập đã hết hạn. <Link className="text-link" href="/dang-nhap?tiep=%2Fapp%2Fthong-bao">Đăng nhập lại</Link> để quản lý thông báo.</span></p>}

    {message && <p className={message.tone === 'ok' ? 'pwa-ok' : 'warning-line'} role={message.tone === 'ok' ? 'status' : 'alert'}><Icon name={message.tone === 'ok' ? 'check' : 'info'} size={16}/>{message.text}</p>}
  </section>;
}

/** The browser will not ask again once blocked, so this explains where to allow it instead of showing a dead button. */
function DeniedHelp({ platform, standalone }: { platform: Platform; standalone: boolean }) {
  const steps = platform === 'ios'
    ? <>Mở <b>Cài đặt</b> → <b>Thông báo</b> → <b>QLead</b> → bật <b>Cho phép thông báo</b>.</>
    : platform === 'android' && standalone
      ? <>Nhấn giữ biểu tượng QLead → <b>Thông tin ứng dụng</b> → <b>Thông báo</b> → bật thông báo.</>
      : platform === 'android'
        ? <>Nhấn biểu tượng cạnh thanh địa chỉ → <b>Quyền</b> → <b>Thông báo</b> → <b>Cho phép</b>.</>
        : <>Nhấn biểu tượng cạnh thanh địa chỉ → <b>Thông báo</b> → <b>Cho phép</b>.</>;
  return <div className="pwa-actions pwa-actions-stack">
    <p className="warning-line" role="status"><Icon name="info" size={16}/><span>Thông báo của QLead đang bị chặn trên thiết bị này. {steps}</span></p>
    <button type="button" className="btn btn-outline btn-sm" onClick={() => window.location.reload()}>Tôi đã cho phép, tải lại</button>
  </div>;
}
