'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './visuals';
import { PwaIcon } from './pwa-icons';
import { promptInstall, useInstallPrompt } from '@/lib/install-prompt';
import { installGuide, safariMajor, type InstallGuide } from '@/lib/pwa';

/**
 * The one "Cài QLead" button. Where the browser offers its own install dialog (Chromium's beforeinstallprompt), a tap
 * opens that dialog and nothing else. Everywhere else (iPhone, Samsung Internet, Firefox, in-app browsers) a tap opens
 * a short sheet with the real steps for that browser. Nothing here claims QLead was installed: only the browser's
 * `appinstalled` event or an accepted prompt does.
 */
export function InstallButton({ className = 'btn btn-primary', onOutcome, children }: {
  className?: string;
  onOutcome?: (outcome: 'accepted' | 'dismissed') => void;
  children?: ReactNode;
}) {
  const { deferred } = useInstallPrompt();
  const [guide, setGuide] = useState<InstallGuide | null>(null);
  const press = async () => {
    if (deferred) {
      const outcome = await promptInstall();
      if (outcome !== 'unavailable') { onOutcome?.(outcome); return; }
    }
    setGuide(installGuide());
  };
  return <>
    <button type="button" className={className} onClick={() => void press()}>
      {children ?? <><PwaIcon name="download" size={18}/>Cài QLead</>}
    </button>
    {guide && <InstallGuideSheet guide={guide} onClose={() => setGuide(null)}/>}
  </>;
}

const titles: Record<InstallGuide, string> = {
  'ios-safari': 'Thêm QLead vào màn hình chính',
  'ios-browser': 'Thêm QLead vào màn hình chính',
  android: 'Cài QLead',
  'android-samsung': 'Cài QLead',
  'in-app': 'Mở QLead bằng trình duyệt',
  desktop: 'Cài QLead',
};

/** A bottom sheet (centered on wide screens) with at most three steps. Esc, the backdrop and × all close it. */
export function InstallGuideSheet({ guide, onClose }: { guide: InstallGuide; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) { try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); } }
    const close = () => onClose();
    dialog.addEventListener('close', close);
    return () => dialog.removeEventListener('close', close);
  }, [onClose]);
  const shut = () => ref.current?.close();
  return <dialog ref={ref} className="install-sheet" aria-labelledby="install-sheet-title"
    onClick={event => { if (event.target === ref.current) shut(); }}>
    <div className="install-sheet-body">
      <header className="install-sheet-head">
        <img src="/icons/icon-192.png" alt="" width={40} height={40}/>
        <h2 id="install-sheet-title">{titles[guide]}</h2>
        <button type="button" className="install-sheet-close" onClick={shut} aria-label="Đóng"><PwaIcon name="close" size={20}/></button>
      </header>
      <GuideSteps guide={guide}/>
      <button type="button" className="btn btn-outline install-sheet-done" onClick={shut}>Đã hiểu</button>
    </div>
  </dialog>;
}

const Key = ({ children, label }: { children: ReactNode; label?: string }) =>
  <span className="pwa-inline-icon" aria-label={label} role={label ? 'img' : undefined}>{children}</span>;

function GuideSteps({ guide }: { guide: InstallGuide }) {
  if (guide === 'ios-safari') {
    const newSafari = (safariMajor() ?? 0) >= 26;
    return <ol className="pwa-steps">
      {newSafari && <li><span className="pwa-step-num">1</span><span>Nhấn <Key label="nút ba chấm"><b>•••</b></Key> ở thanh dưới của Safari.</span></li>}
      <li><span className="pwa-step-num">{newSafari ? 2 : 1}</span><span>Nhấn <b>Chia sẻ</b> <Key><PwaIcon name="share" size={16}/></Key></span></li>
      <li><span className="pwa-step-num">{newSafari ? 3 : 2}</span><span>Chọn <b>Thêm vào MH chính</b> <Key><PwaIcon name="plusSquare" size={16}/></Key>, rồi nhấn <b>Thêm</b>.</span></li>
      {!newSafari && <li><span className="pwa-step-num">3</span><span>Mở QLead từ biểu tượng con dê để bật thông báo.</span></li>}
    </ol>;
  }
  if (guide === 'ios-browser') return <ol className="pwa-steps">
    <li><span className="pwa-step-num">1</span><span>Nhấn <b>Chia sẻ</b> <Key><PwaIcon name="share" size={16}/></Key> của trình duyệt <small>(trên thanh địa chỉ, hoặc trong menu <b>⋯</b>)</small></span></li>
    <li><span className="pwa-step-num">2</span><span>Chọn <b>Thêm vào MH chính</b> <Key><PwaIcon name="plusSquare" size={16}/></Key>, rồi nhấn <b>Thêm</b>.</span></li>
    <li><span className="pwa-step-num">3</span><span>Mở QLead từ biểu tượng con dê để bật thông báo.</span></li>
  </ol>;
  if (guide === 'android') return <ol className="pwa-steps">
    <li><span className="pwa-step-num">1</span><span>Nhấn <Key label="menu ba chấm"><b>⋮</b></Key> ở góc trên của trình duyệt.</span></li>
    <li><span className="pwa-step-num">2</span><span>Chọn <b>Cài đặt ứng dụng</b> hoặc <b>Thêm vào màn hình chính</b>.</span></li>
    <li><span className="pwa-step-num">3</span><span>Nhấn <b>Cài đặt</b> để xác nhận.</span></li>
  </ol>;
  if (guide === 'android-samsung') return <ol className="pwa-steps">
    <li><span className="pwa-step-num">1</span><span>Nhấn <Key label="menu"><b>≡</b></Key> ở thanh dưới.</span></li>
    <li><span className="pwa-step-num">2</span><span>Chọn <b>Thêm trang vào</b> → <b>Màn hình chính</b>.</span></li>
    <li><span className="pwa-step-num">3</span><span>Nhấn <b>Thêm</b> để xác nhận.</span></li>
  </ol>;
  if (guide === 'in-app') return <OpenInBrowser/>;
  return <ol className="pwa-steps">
    <li><span className="pwa-step-num">1</span><span>Trên Chrome hoặc Edge, nhấn biểu tượng <b>Cài đặt</b> <Key><PwaIcon name="download" size={16}/></Key> ở cuối thanh địa chỉ.</span></li>
    <li><span className="pwa-step-num">2</span><span>Hoặc mở <b>qlead.vn</b> trên điện thoại để thêm QLead vào màn hình chính.</span></li>
  </ol>;
}

/** Facebook, Zalo and other in-app browsers cannot add to the Home Screen: send the person to the real browser. */
function OpenInBrowser() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/app`); setCopied(true); } catch { setCopied(false); }
  };
  return <div className="pwa-actions-stack pwa-actions">
    <ol className="pwa-steps">
      <li><span className="pwa-step-num">1</span><span>Nhấn <b>⋯</b> ở góc màn hình, chọn <b>Mở bằng trình duyệt</b> <small>(iPhone: Safari)</small>.</span></li>
      <li><span className="pwa-step-num">2</span><span>Không thấy? Sao chép liên kết rồi dán vào Safari hoặc Chrome.</span></li>
    </ol>
    <button type="button" className="btn btn-outline btn-sm" onClick={() => void copy()}><Icon name="copy" size={16}/>{copied ? 'Đã sao chép liên kết' : 'Sao chép liên kết'}</button>
  </div>;
}
