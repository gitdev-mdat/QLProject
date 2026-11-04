'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminOverview, AdminWorker } from '@/lib/server/admin';
import { museConnectPrompt } from '@/lib/admin-prompts';
import { connectionState, copiedKey, primaryWorker, WAIT_WINDOW_MS, type ConnectionState } from '@/lib/muse-connect';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';
import './muse-connect.css';

const TZ = 'Asia/Ho_Chi_Minh';
const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const at = (value: string | number | null | undefined) => (value ? timeFmt.format(new Date(value)) : null);

const TONE: Record<ConnectionState, 'idle' | 'wait' | 'warn' | 'ok' | 'bad'> = {
  none: 'idle', not_connected: 'idle', waiting: 'wait', paused: 'warn', ready: 'ok', busy: 'ok', stalled: 'warn', error: 'bad',
};
const BADGE: Record<ConnectionState, string> = {
  none: 'Chưa có worker', not_connected: 'Chưa kết nối', waiting: 'Đang chờ Muse xác minh', paused: 'Đã xác minh · đang tạm dừng',
  ready: 'Sẵn sàng nhận việc', busy: 'Đang xử lý', stalled: 'Muse chưa nhận việc', error: 'Lỗi kết nối',
};

export type MuseConnectActions = {
  busy: boolean;
  onAdd: () => void;
  onActivate: (worker: AdminWorker) => void;
  onNewCredential: (worker: AdminWorker) => void;
  onReload: () => Promise<void>;
};

function readCopied(id: string | undefined): number | null {
  if (!id) return null;
  try { const v = Number(window.localStorage.getItem(copiedKey(id))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}

export function MuseConnect({ data, actions }: { data: AdminOverview; actions: MuseConnectActions }) {
  const worker = primaryWorker(data.workers);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => { setCopiedAt(readCopied(worker?.id)); setNow(Date.now()); }, [worker?.id]);

  const view = connectionState(worker, data.queue, copiedAt, now || Date.parse(data.generatedAt));
  const isProd = data.environment === 'production';
  const envLabel = isProd ? 'Production' : 'Local';
  const prompt = useMemo(() => (worker && data.publicUrl
    ? museConnectPrompt({ environment: data.environment, baseUrl: data.publicUrl, workerName: worker.name, dispatchRelaysLocal: data.dispatchRelaysLocal })
    : null), [worker, data.publicUrl, data.environment, data.dispatchRelaysLocal]);

  // Refresh fast only while QLead is genuinely waiting for Muse; the wait has a hard end (WAIT_WINDOW_MS).
  const { onReload } = actions;
  useEffect(() => {
    const period = view.state === 'waiting' ? 5000 : view.state === 'busy' || view.state === 'paused' ? 15_000 : 0;
    if (!period) return;
    const id = window.setInterval(() => { setNow(Date.now()); void onReload(); }, period);
    return () => window.clearInterval(id);
  }, [view.state, onReload]);
  useEffect(() => {
    if (view.state !== 'waiting' || !copiedAt) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, copiedAt + WAIT_WINDOW_MS - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [view.state, copiedAt]);

  async function copy() {
    if (!prompt || !worker) return;
    try { await navigator.clipboard.writeText(prompt); setCopyState('done'); }
    catch { setCopyState('failed'); setShowPrompt(true); return; }
    const t = Date.now();
    // Only a not-yet-verified worker waits for a verification; for a verified one the copy is a re-check.
    if (!worker.connectionVerifiedAt) { try { window.localStorage.setItem(copiedKey(worker.id), String(t)); } catch { /* the wait then lasts this view only */ } setCopiedAt(t); }
    setNow(t);
    window.setTimeout(() => setCopyState('idle'), 2500);
  }

  let title: string; let text: ReactNode; let next: ReactNode = null;
  switch (view.state) {
    case 'none':
      title = 'Chưa có worker Muse'; text = `QLead ${envLabel} chưa có worker nào để Muse làm việc.`;
      next = 'Tạo worker trước, sau đó sao chép prompt kết nối.'; break;
    case 'not_connected':
      title = 'Muse chưa kết nối'; text = view.reason ?? `${worker!.name} chưa từng xác minh với QLead ${envLabel}.`;
      next = <>Sao chép prompt và dán vào <b>Muse MAIN</b>. Muse tự làm các bước nó làm được, và chỉ nhờ bạn khi thật sự cần, ví dụ nhập mã bảo mật vào ô bí mật của connector.</>; break;
    case 'waiting':
      title = 'Đang chờ Muse xác minh'; text = <>Đã sao chép prompt lúc {at(copiedAt)}. Trang tự cập nhật khi Muse gọi QLead.</>;
      next = <>Nếu Muse báo cần mã bảo mật, bấm <b>Tạo mã bảo mật</b> rồi nhập mã vào ô bí mật của connector trong Muse, không dán vào chat.</>; break;
    case 'paused':
      title = 'Đã xác minh, chưa nhận việc'; text = <>Muse đã kết nối thành công lúc {at(worker!.connectionVerifiedAt)}. {view.reason ?? `${worker!.name} đang tạm dừng nên chưa nhận lượt tìm nào.`}</>;
      next = <>Bấm <b>Cho phép nhận việc</b>, rồi dán lại prompt vào Muse MAIN để Muse kiểm tra Hook.</>; break;
    case 'ready':
      title = 'Sẵn sàng nhận việc'; text = <>{worker!.name} đã xác minh và được phép nhận việc.{worker!.lastClaimAt ? <> Muse gọi nhận việc gần nhất lúc {at(worker!.lastClaimAt)}.</> : ' QLead chưa ghi nhận lần gọi nhận việc nào.'}</>; break;
    case 'busy':
      title = 'Đang xử lý lượt tìm'; text = <>{worker!.name} đang xử lý {worker!.inFlight} lượt tìm.</>; break;
    case 'stalled':
      title = 'Có việc chờ nhưng Muse chưa nhận'; text = <>{data.queue.pending} lượt tìm đang chờ từ {at(data.queue.oldestPendingSlot)}, nhưng {worker!.name} {worker!.lastClaimAt ? `chưa gọi nhận việc từ ${at(worker!.lastClaimAt)}` : 'chưa từng gọi nhận việc'}.</>;
      next = <>Thường là Hook trong Muse chưa trỏ về QLead {envLabel} hoặc đang tắt. Dán lại prompt vào Muse MAIN để Muse kiểm tra Hook.</>; break;
    case 'error':
      title = 'Kết nối đang gặp lỗi'; text = view.reason; break;
  }

  const allowed = worker ? (worker.status === 'active' ? 'Được phép' : worker.status === 'draining' ? 'Đang ngừng' : 'Tạm dừng') : '—';
  const showCredential = worker && (view.state === 'not_connected' || view.state === 'waiting' || (view.state === 'error' && worker.credentialStatus !== 'active'));

  return <section className={`mc-card tone-${TONE[view.state]}`} aria-labelledby="mc-title" data-state={view.state}>
    <div className="mc-main">
      <div className="mc-mascot" aria-hidden="true"><GoatMascot size="sm" animate={view.state === 'ready' || view.state === 'busy'}/></div>
      <div className="mc-copy">
        <p className="mc-badge" role="status"><span className="mc-dot" aria-hidden="true"/>{BADGE[view.state]}</p>
        <h2 id="mc-title">{title}</h2>
        {text && <p className="mc-text">{text}</p>}
      </div>
    </div>

    {worker && <dl className="mc-facts">
      <div><dt>Worker</dt><dd>{worker.name}</dd></div>
      <div><dt>Xác minh gần nhất</dt><dd>{at(worker.connectionVerifiedAt) ?? 'Chưa có'}</dd></div>
      <div><dt>Nhận việc</dt><dd>{allowed}</dd></div>
      <div><dt>Lượt tìm đang chờ</dt><dd>{data.queue.pending}</dd></div>
    </dl>}

    {!data.publicUrl && <p className="mc-note is-warn"><Icon name="info" size={16}/>Chưa cấu hình địa chỉ công khai của QLead (QLEAD_WORKER_PUBLIC_URL) nên chưa tạo được prompt.</p>}
    {next && <p className="mc-next">{next}</p>}

    <div className="mc-actions">
      {view.state === 'none'
        ? <button type="button" className="btn btn-primary btn-lg" onClick={actions.onAdd}><Icon name="plug" size={18}/>Tạo worker Muse</button>
        : <button type="button" className="btn btn-primary btn-lg mc-copy-btn" disabled={!prompt} onClick={copy}>
          <Icon name={copyState === 'done' ? 'check' : 'copy'} size={18}/>{copyState === 'done' ? 'Đã sao chép prompt' : 'Sao chép prompt kết nối Muse'}</button>}
      {view.state === 'paused' && worker!.status === 'paused' && <button type="button" className="btn btn-outline btn-lg" disabled={actions.busy} onClick={() => actions.onActivate(worker!)}>Cho phép nhận việc</button>}
      {showCredential && <button type="button" className="btn btn-ghost" disabled={actions.busy} onClick={() => actions.onNewCredential(worker!)}><Icon name="lock" size={16}/>Tạo mã bảo mật</button>}
    </div>
    {copyState === 'failed' && <p className="mc-note is-warn" role="alert"><Icon name="info" size={16}/>Trình duyệt không cho sao chép tự động. Hãy chọn toàn bộ nội dung bên dưới và sao chép thủ công.</p>}

    {prompt && <details className="mc-prompt" open={showPrompt} onToggle={e => setShowPrompt((e.target as HTMLDetailsElement).open)}>
      <summary>Xem nội dung prompt</summary>
      <p className="mc-note"><Icon name="lock" size={16}/>Prompt không chứa mã bảo mật. Mã chỉ được nhập vào ô bí mật của connector trong Muse.</p>
      <textarea readOnly value={prompt} rows={14} aria-label="Nội dung prompt kết nối Muse" onFocus={e => e.currentTarget.select()}/>
    </details>}

    <p className="mc-foot"><Icon name="info" size={14}/>QLead không đọc được trạng thái Hook trong Muse. QLead chỉ biết Muse đang chạy khi Muse thật sự gọi nhận việc.</p>
  </section>;
}
