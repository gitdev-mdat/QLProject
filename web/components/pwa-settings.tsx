'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from './visuals';
import { PwaIcon } from './pwa-icons';
import { promptInstall, useInstallPrompt } from '@/lib/install-prompt';
import { detectPlatform, isIosSafari, isStandalone, pushBlocker, type Platform } from '@/lib/pwa';
import { disablePush, enablePush, fetchPushConfig, PushError, sendTestPush, syncSubscription } from '@/lib/push-client';
import { usePushOwner } from './app-shell';

type Env = { platform: Platform; standalone: boolean; iosSafari: boolean };

/** Browser facts are read after mount; the server render shows a neutral loading state instead of guessing. */
function useEnv(): Env | null {
  const [env, setEnv] = useState<Env | null>(null);
  useEffect(() => {
    const read = () => setEnv({ platform: detectPlatform(), standalone: isStandalone(), iosSafari: isIosSafari() });
    read();
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener?.('change', read);
    return () => media.removeEventListener?.('change', read);
  }, []);
  return env;
}

export function AppSettingsPage() {
  const env = useEnv();
  return <div className="pwa-page">
    <header className="page-head"><div><h1>Ứng dụng và thông báo</h1><p>Mở QLead nhanh như một ứng dụng và biết ngay khi có khách hàng tiềm năng mới.</p></div></header>
    {/* On an iPhone tab, installing comes first: iOS only offers notifications to the Home Screen app. */}
    <div className={`pwa-grid${env?.platform === 'ios' && !env.standalone ? ' install-first' : ''}`}>
      <PushCard env={env}/>
      <InstallCard env={env}/>
    </div>
  </div>;
}

/* ───────────────────────────── Install ───────────────────────────── */

function InstallCard({ env }: { env: Env | null }) {
  const { deferred, installed } = useInstallPrompt();
  const [note, setNote] = useState('');
  if (!env) return <section className="panel pwa-card" aria-busy="true"><div className="pwa-skeleton"/></section>;

  const isInstalled = installed || env.standalone;
  if (isInstalled) {
    return <section className="panel pwa-card" id="cai-dat" aria-labelledby="install-title">
      <div className="pwa-card-head"><span className="pwa-card-icon is-done"><Icon name="check" size={20}/></span><div><h2 id="install-title">QLead đã được cài</h2><p>{env.standalone ? 'Bạn đang mở QLead từ màn hình chính.' : 'Mở QLead từ biểu tượng con dê trên màn hình chính hoặc danh sách ứng dụng.'}</p></div></div>
    </section>;
  }

  const install = async () => {
    setNote('');
    const outcome = await promptInstall();
    if (outcome === 'dismissed') setNote('Bạn có thể cài sau từ menu trình duyệt.');
  };

  const mobile = env.platform === 'ios' || env.platform === 'android';
  return <section className="panel pwa-card" id="cai-dat" aria-labelledby="install-title">
    <div className="pwa-card-head">
      <span className="pwa-card-icon"><PwaIcon name="phone" size={20}/></span>
      <div><h2 id="install-title">{mobile || !deferred ? 'Cài QLead trên điện thoại' : 'Cài QLead trên máy tính'}</h2><p>Mở nhanh QLead và nhận thông báo khi có khách hàng tiềm năng mới.</p></div>
    </div>
    {deferred
      ? <div className="pwa-actions"><button type="button" className="btn btn-primary" onClick={install}><PwaIcon name="download" size={18}/>Cài QLead</button></div>
      : env.platform === 'ios' && env.iosSafari ? <IosSteps/>
      : env.platform === 'ios' ? <IosOpenInSafari/>
      : env.platform === 'android' ? <p className="pwa-hint"><span>Mở menu <b aria-label="ba chấm">⋮</b> của trình duyệt, chọn <b>Thêm vào màn hình chính</b> hoặc <b>Cài đặt ứng dụng</b>.</span></p>
      : <p className="pwa-hint"><span>Mở <b>{typeof window !== 'undefined' ? window.location.host : 'QLead'}</b> trên điện thoại để thêm QLead vào màn hình chính.</span></p>}
    {note && <p className="pwa-hint" role="status"><span>{note}</span></p>}
  </section>;
}

/** Safari's real Add to Home Screen path. iOS 26 moved Share behind the "•••" button, so both entries are named. */
function IosSteps() {
  return <ol className="pwa-steps" aria-label="Cách thêm QLead vào màn hình chính">
    <li><span className="pwa-step-num">1</span><span>Nhấn nút <b>Chia sẻ</b> <span className="pwa-inline-icon" aria-hidden="true"><PwaIcon name="share" size={16}/></span> trên thanh Safari <small>(iOS 26: nhấn <b>•••</b> rồi chọn <b>Chia sẻ</b>)</small></span></li>
    <li><span className="pwa-step-num">2</span><span>Chọn <b>Thêm vào MH chính</b> <span className="pwa-inline-icon" aria-hidden="true"><PwaIcon name="plusSquare" size={16}/></span> <small>(kéo xuống nếu chưa thấy)</small></span></li>
    <li><span className="pwa-step-num">3</span><span>Nhấn <b>Thêm</b>, rồi mở QLead từ biểu tượng con dê.</span></li>
  </ol>;
}

function IosOpenInSafari() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/app`); setCopied(true); } catch { setCopied(false); }
  };
  return <div className="pwa-actions pwa-actions-stack">
    <p className="pwa-hint"><span>Trên iPhone, mở QLead bằng <b>Safari</b> để thêm vào màn hình chính.</span></p>
    <button type="button" className="btn btn-outline btn-sm" onClick={copy}><Icon name="copy" size={16}/>{copied ? 'Đã sao chép liên kết' : 'Sao chép liên kết'}</button>
  </div>;
}

/* ───────────────────────────── Push ───────────────────────────── */

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
    setMessage({ tone: 'warn', text: 'Không kết nối được với QLead. Thử lại sau ít phút.' });
  };

  const enable = async (key: string) => {
    setBusy('enable'); setMessage(null);
    try {
      const result = await enablePush(key, owner);
      if (result === 'granted') { setState({ kind: 'on', key }); setMessage({ tone: 'ok', text: 'Đã bật. QLead sẽ báo khi tìm thấy khách hàng tiềm năng mới.' }); }
      else if (result === 'denied') setState({ kind: 'denied' });
      else setState({ kind: 'off', key, dismissed: true });
    } catch (error) { fail(error); } finally { setBusy(null); }
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
      {(state.kind === 'on' || state.kind === 'off') && <span className={`pwa-status${on ? ' is-on' : ''}`}>{on ? 'Đang bật' : 'Đang tắt'}</span>}
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
      ? <p className="pwa-hint"><Icon name="info" size={16}/><span>Trên iPhone, hãy <a className="text-link" href="#cai-dat">thêm QLead vào màn hình chính</a> trước, rồi mở QLead từ biểu tượng đó để bật thông báo.</span></p>
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
