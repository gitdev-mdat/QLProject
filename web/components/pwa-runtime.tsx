'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PwaIcon } from './pwa-icons';
import { promptInstall, useInstallPrompt } from '@/lib/install-prompt';
import { detectPlatform, isIosSafari, isStandalone, localFlag } from '@/lib/pwa';
import { PushError, registerServiceWorker, syncSubscription } from '@/lib/push-client';
import { usePushOwner } from './app-shell';

const DISMISSED_KEY = 'qlead.installHint.dismissed';
const VISITS_KEY = 'qlead.visits';
const VISIT_COUNTED_KEY = 'qlead.visitCounted';

/**
 * Mounted once by the /app frame. After the page has loaded and gone idle it registers the push-only worker (no
 * fetch handler, so navigation speed is untouched) and makes sure a browser subscription left over from another
 * account on this device does not keep delivering that account's leads.
 */
export function PwaRuntime() {
  const owner = usePushOwner();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    const run = async () => {
      await registerServiceWorker();
      if (cancelled || !('Notification' in window) || Notification.permission !== 'granted') return;
      // Only an explicit server answer changes anything; an outage or a backend that is not deployed yet leaves it as is.
      try { await syncSubscription(owner); } catch (error) { if (!(error instanceof PushError)) throw error; }
    };
    // Two seconds after load keeps registration off the critical path of the first paint and of route switches.
    let timer = 0;
    const schedule = () => { timer = window.setTimeout(() => { void run().catch(() => undefined); }, 2000); };
    if (document.readyState === 'complete') schedule(); else window.addEventListener('load', schedule, { once: true });
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('load', schedule); };
  }, [owner]);
  return null;
}

/**
 * One slim, dismissible line on Hôm nay, for phones only. It never appears on the first visit, never once QLead is
 * installed, only where the browser really offers an install path (Chromium's prompt, or Safari on iOS), and "Để sau"
 * hides it for good on this device; the same option stays available in Ứng dụng và thông báo.
 */
export function InstallHint() {
  const { deferred, installed } = useInstallPrompt();
  const [eligible, setEligible] = useState<'android' | 'ios' | null>(null);

  useEffect(() => {
    let visits = Number(localFlag.get(VISITS_KEY) ?? '0') || 0;
    let counted = false;
    try { counted = window.sessionStorage.getItem(VISIT_COUNTED_KEY) === '1'; window.sessionStorage.setItem(VISIT_COUNTED_KEY, '1'); } catch { counted = true; }
    if (!counted) { visits += 1; localFlag.set(VISITS_KEY, String(visits)); }
    const platform = detectPlatform();
    const phone = platform === 'ios' || platform === 'android';
    if (!phone || visits < 2 || isStandalone() || localFlag.get(DISMISSED_KEY)) return;
    setEligible(platform === 'ios' ? (isIosSafari() ? 'ios' : null) : 'android');
  }, []);

  if (!eligible || installed) return null;
  if (eligible === 'android' && !deferred) return null;

  const dismiss = () => { localFlag.set(DISMISSED_KEY, new Date().toISOString()); setEligible(null); };
  return <aside className="install-hint" aria-label="Cài QLead trên điện thoại">
    <img src="/icons/icon-192.png" alt="" width={36} height={36}/>
    <div className="install-hint-text"><b>Cài QLead trên điện thoại</b><span>Mở nhanh QLead và nhận thông báo khi có khách hàng tiềm năng mới.</span></div>
    <div className="install-hint-actions">
      {eligible === 'android'
        ? <button type="button" className="btn btn-primary btn-sm" onClick={() => void promptInstall()}><PwaIcon name="download" size={16}/>Cài QLead</button>
        : <Link className="btn btn-primary btn-sm" href="/app/thong-bao#cai-dat">Cài QLead</Link>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss}>Để sau</button>
    </div>
  </aside>;
}
