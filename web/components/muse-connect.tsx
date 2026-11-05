'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminOverview, AdminWorker } from '@/lib/server/admin';
import { museConnectPrompt } from '@/lib/admin-prompts';
import { connectionState, copiedKey, WAIT_WINDOW_MS, type ConnectionState } from '@/lib/muse-connect';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';
import './muse-connect.css';

const TZ = 'Asia/Ho_Chi_Minh';
const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** "05/11 14:30" in Vietnam time. */
const at = (value: string | number | null | undefined) => {
  if (!value) return null;
  const p = Object.fromEntries(timeFmt.formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};

const TONE: Record<ConnectionState, 'idle' | 'wait' | 'warn' | 'ok' | 'bad'> = {
  none: 'idle', not_connected: 'idle', waiting: 'wait', paused: 'warn', ready: 'ok', busy: 'ok', stalled: 'warn', error: 'bad',
};
const BADGE: Record<ConnectionState, string> = {
  none: 'Chưa có tài khoản', not_connected: 'Chưa kết nối', waiting: 'Đang chờ Muse xác minh', paused: 'Đã xác minh · chưa nhận việc',
  ready: 'Sẵn sàng nhận việc', busy: 'Đang xử lý', stalled: 'Muse chưa nhận việc', error: 'Lỗi kết nối',
};
/** The QLead-side switch, in owner words, with the database value kept visible for troubleshooting. */
export const WORKER_STATUS: Record<string, { label: string; code: string; tone: 'ok' | 'idle' | 'warn' | 'bad' }> = {
  active: { label: 'Đang nhận việc mới', code: 'ACTIVE', tone: 'ok' },
  paused: { label: 'Tạm dừng', code: 'PAUSED', tone: 'idle' },
  draining: { label: 'Đang ngừng nhận việc', code: 'DRAINING', tone: 'warn' },
  unavailable: { label: 'Không khả dụng', code: 'UNAVAILABLE', tone: 'bad' },
};

export type MuseConnectActions = {
  busy: boolean;
  onAdd: () => void;
  onActivate: (worker: AdminWorker) => void;
  onNewCredential: (worker: AdminWorker) => void;
  /** Opens the existing safe handoff review (source → destination). */
  onHandoff: (sourceId: string, destinationId: string) => void;
  onShowHandoff: () => void;
  onReload: () => Promise<void>;
};

function readCopied(id: string): number | null {
  try { const v = Number(window.localStorage.getItem(copiedKey(id))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}

function StatusPill({ worker }: { worker: AdminWorker }) {
  const s = WORKER_STATUS[worker.status] ?? { label: worker.status, code: worker.status.toUpperCase(), tone: 'idle' as const };
  return <span className={`mc-status tone-${s.tone}`}>{s.label}<small>{s.code}</small></span>;
}

export function MuseConnect({ data, selectedId, onSelect, actions }: { data: AdminOverview; selectedId: string | null; onSelect: (id: string) => void; actions: MuseConnectActions }) {
  const workers = data.workers;
  const worker = workers.find(w => w.id === selectedId) ?? null;
  const receiving = workers.find(w => w.status === 'active' || w.status === 'draining') ?? null;
  const handoff = data.openHandoff;
  const [copied, setCopied] = useState<Record<string, number | null>>({});
  const [now, setNow] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [showPrompt, setShowPrompt] = useState(false);
  const ids = workers.map(w => w.id).join(',');
  useEffect(() => { setCopied(Object.fromEntries(ids.split(',').filter(Boolean).map(id => [id, readCopied(id)]))); setNow(Date.now()); }, [ids]);
  useEffect(() => { setCopyState('idle'); setShowPrompt(false); }, [selectedId]);

  const clock = now || Date.parse(data.generatedAt);
  const stateOf = (w: AdminWorker | null) => connectionState(w, data.queue, w ? copied[w.id] ?? null : null, clock);
  const view = stateOf(worker);
  const isProd = data.environment === 'production';
  const envLabel = isProd ? 'Production' : 'Local';
  const prompt = useMemo(() => (worker && data.publicUrl
    ? museConnectPrompt({ environment: data.environment, baseUrl: data.publicUrl, workerName: worker.name })
    : null), [worker, data.publicUrl, data.environment]);

  // Refresh fast only while QLead is genuinely waiting for Muse; the wait has a hard end (WAIT_WINDOW_MS).
  const { onReload } = actions;
  const anyWaiting = workers.some(w => stateOf(w).state === 'waiting');
  // Not connected yet: a slow refresh so a verification done without copying here still shows up.
  const period = anyWaiting ? 5000 : view.state === 'busy' || view.state === 'paused' ? 15_000 : view.state === 'not_connected' ? 30_000 : 0;
  useEffect(() => {
    if (!period) return;
    const id = window.setInterval(() => { setNow(Date.now()); void onReload(); }, period);
    return () => window.clearInterval(id);
  }, [period, onReload]);
  const copiedAt = worker ? copied[worker.id] ?? null : null;
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
    if (!worker.connectionVerifiedAt) {
      try { window.localStorage.setItem(copiedKey(worker.id), String(t)); } catch { /* the wait then lasts this view only */ }
      setCopied(c => ({ ...c, [worker.id]: t }));
    }
    setNow(t);
    window.setTimeout(() => setCopyState('idle'), 2500);
  }

  const inHandoff = Boolean(worker && handoff && (handoff.sourceId === worker.id || handoff.destinationId === worker.id));
  const other = receiving && worker && receiving.id !== worker.id ? receiving : null;
  const canActivate = Boolean(worker && worker.status === 'paused' && worker.connectionVerifiedAt && worker.credentialStatus === 'active' && !other && !handoff);
  const needsHandoff = Boolean(worker && worker.status === 'paused' && worker.connectionVerifiedAt && worker.credentialStatus === 'active' && other && !handoff);

  let title = ''; let text: ReactNode = null; let next: ReactNode = null;
  if (worker) switch (view.state) {
    case 'not_connected':
      title = 'Muse chưa kết nối'; text = view.reason ?? `${worker.name} chưa từng xác minh với QLead ${envLabel}.`;
      next = <>Sao chép prompt và dán vào <b>Muse MAIN của tài khoản Muse dành cho {worker.name}</b>. Muse tự làm các bước nó làm được, và chỉ nhờ bạn khi thật sự cần, ví dụ nhập mã bảo mật vào ô bí mật của connector.</>; break;
    case 'waiting':
      title = 'Đang chờ Muse xác minh'; text = <>Đã sao chép prompt lúc {at(copiedAt)}. Trang tự cập nhật khi Muse gọi QLead.</>;
      next = <>Nếu Muse báo cần mã bảo mật, bấm <b>Tạo mã bảo mật</b> rồi nhập mã vào ô bí mật của connector trong Muse, không dán vào chat.</>; break;
    case 'paused':
      title = 'Đã xác minh, chưa nhận việc'; text = <>Muse đã kết nối thành công lúc {at(worker.connectionVerifiedAt)}. {view.reason ?? `${worker.name} đang tạm dừng nên chưa nhận lượt tìm nào.`}</>;
      next = handoff && !inHandoff ? <>Đang có một lượt chuyển đổi khác. Hoàn tất hoặc huỷ lượt đó trước.</>
        : other ? <><b>{other.name}</b> đang nhận việc mới. Muốn {worker.name} nhận việc thay, hãy dùng chuyển đổi an toàn: {other.name} ngừng nhận việc mới, các lượt đang chạy được hoàn tất hoặc trả về hàng chờ, rồi {worker.name} mới nhận việc. Không lượt tìm nào bị bỏ.</>
        : <>Bấm <b>Cho phép nhận việc</b>, rồi dán lại prompt vào Muse MAIN để Muse bật Hook của tài khoản này.</>; break;
    case 'ready':
      title = 'Sẵn sàng nhận việc'; text = <>{worker.name} đã xác minh và đang nhận việc mới.{worker.lastClaimAt ? <> Muse gọi nhận việc gần nhất lúc {at(worker.lastClaimAt)}.</> : ' QLead chưa ghi nhận lần gọi nhận việc nào.'}</>;
      if (!worker.lastClaimAt) next = <>Nếu Hook của tài khoản này chưa bật, dán lại prompt vào Muse MAIN để Muse kiểm tra và bật Hook.</>; break;
    case 'busy':
      title = 'Đang xử lý lượt tìm'; text = <>{worker.name} đang xử lý {worker.inFlight} lượt tìm.</>; break;
    case 'stalled':
      title = 'Có việc chờ nhưng Muse chưa nhận'; text = <>{data.queue.pending} lượt tìm đang chờ từ {at(data.queue.oldestPendingSlot)}, nhưng {worker.name} {worker.lastClaimAt ? `chưa gọi nhận việc từ ${at(worker.lastClaimAt)}` : 'chưa từng gọi nhận việc'}.</>;
      next = <>Thường là Hook trong tài khoản Muse này chưa bật. Dán lại prompt vào Muse MAIN để Muse kiểm tra Hook.</>; break;
    case 'error':
      title = 'Kết nối đang gặp lỗi'; text = view.reason; break;
    default: break;
  }
  const showCredential = worker && (view.state === 'not_connected' || view.state === 'waiting' || (view.state === 'error' && worker.credentialStatus !== 'active'));

  return <div className="mc-layout">
    {handoff && <div className="mc-handoff-banner" role="status"><Icon name="clock" size={18}/>
      <span>Đang chuyển việc từ <b>{handoff.sourceName}</b> sang <b>{handoff.destinationName}</b>. Công việc và lịch sử được giữ nguyên.</span>
      <button type="button" className="btn btn-outline btn-sm" onClick={actions.onShowHandoff}>Xem lượt chuyển đổi</button></div>}

    <section className="mc-list" aria-labelledby="mc-list-h">
      <div className="mc-list-head">
        <h2 id="mc-list-h">Tài khoản Muse <span>({workers.length})</span></h2>
        <button type="button" className="btn btn-outline btn-sm" onClick={actions.onAdd}><Icon name="plug" size={16}/>Thêm tài khoản Muse</button>
      </div>
      <p className="mc-list-note">Mỗi tài khoản Muse là một worker riêng. Chỉ một tài khoản nhận việc mới tại một thời điểm{receiving ? <>: hiện là <b>{receiving.name}</b></> : ' (hiện chưa có tài khoản nào)'}.</p>
      {workers.length === 0 ? <p className="mc-empty">Chưa có tài khoản Muse nào trong QLead {envLabel}.</p>
        : <ul className="mc-workers">{workers.map(w => {
          const s = stateOf(w);
          return <li key={w.id}>
            <button type="button" className={`mc-worker ${w.id === selectedId ? 'is-selected' : ''}`} aria-pressed={w.id === selectedId} onClick={() => onSelect(w.id)}>
              <span className="mc-worker-top"><b>{w.name}</b><StatusPill worker={w}/></span>
              <span className={`mc-worker-conn tone-${TONE[s.state]}`}><span className="mc-dot" aria-hidden="true"/>{BADGE[s.state]}</span>
              <span className="mc-worker-meta">{w.completedAttempts} lượt tìm đã hoàn tất{w.lastSuccessAt ? ` · gần nhất ${at(w.lastSuccessAt)}` : ''}</span>
            </button>
          </li>;
        })}</ul>}
    </section>

    {!worker ? <section className="mc-card tone-idle" aria-labelledby="mc-title" data-state="none">
      <div className="mc-main">
        <div className="mc-mascot" aria-hidden="true"><GoatMascot size="sm" animate={false}/></div>
        <div className="mc-copy"><p className="mc-badge" role="status"><span className="mc-dot" aria-hidden="true"/>{BADGE.none}</p>
          <h2 id="mc-title">Thêm tài khoản Muse đầu tiên</h2>
          <p className="mc-text">Tạo một worker cho tài khoản Muse sẽ chạy QLead {envLabel}, rồi sao chép prompt kết nối.</p></div>
      </div>
      <div className="mc-actions"><button type="button" className="btn btn-primary btn-lg" onClick={actions.onAdd}><Icon name="plug" size={18}/>Thêm tài khoản Muse</button></div>
    </section>
      : <section className={`mc-card tone-${TONE[view.state]}`} aria-labelledby="mc-title" data-state={view.state} data-worker={worker.name}>
        <div className="mc-main">
          <div className="mc-mascot" aria-hidden="true"><GoatMascot key={`${worker.id}:${view.state === 'ready' || view.state === 'busy'}`} size="sm" animate={view.state === 'ready' || view.state === 'busy'}/></div>
          <div className="mc-copy">
            <p className="mc-worker-name">{worker.name} <StatusPill worker={worker}/></p>
            <p className="mc-badge" role="status"><span className="mc-dot" aria-hidden="true"/>{BADGE[view.state]}</p>
            <h2 id="mc-title">{title}</h2>
            {text && <p className="mc-text">{text}</p>}
          </div>
        </div>

        <dl className="mc-facts">
          <div><dt>Xác minh gần nhất</dt><dd>{at(worker.connectionVerifiedAt) ?? 'Chưa có'}</dd></div>
          <div><dt>Nhận việc mới</dt><dd>{worker.status === 'active' ? 'Có' : 'Không'}</dd></div>
          <div><dt>Lượt tìm đã hoàn tất</dt><dd>{worker.completedAttempts}</dd></div>
          <div><dt>Lượt tìm đang chờ</dt><dd>{data.queue.pending}</dd></div>
        </dl>

        {!data.publicUrl && <p className="mc-note is-warn"><Icon name="info" size={16}/>Chưa cấu hình địa chỉ công khai của QLead (QLEAD_WORKER_PUBLIC_URL) nên chưa tạo được prompt.</p>}
        {next && <p className="mc-next">{next}</p>}

        <div className="mc-actions">
          <button type="button" className="btn btn-primary btn-lg mc-copy-btn" disabled={!prompt} onClick={copy}>
            <Icon name={copyState === 'done' ? 'check' : 'copy'} size={18}/>{copyState === 'done' ? 'Đã sao chép prompt' : 'Sao chép prompt kết nối Muse'}</button>
          {canActivate && <button type="button" className="btn btn-outline btn-lg" disabled={actions.busy} onClick={() => actions.onActivate(worker)}>Cho phép nhận việc</button>}
          {needsHandoff && <button type="button" className="btn btn-outline btn-lg" disabled={actions.busy} onClick={() => actions.onHandoff(other!.id, worker.id)}>Chuẩn bị chuyển từ {other!.name}</button>}
          {inHandoff && <button type="button" className="btn btn-outline btn-lg" onClick={actions.onShowHandoff}>Xem lượt chuyển đổi</button>}
          {showCredential && <button type="button" className="btn btn-ghost" disabled={actions.busy} onClick={() => actions.onNewCredential(worker)}><Icon name="lock" size={16}/>Tạo mã bảo mật</button>}
        </div>
        {copyState === 'failed' && <p className="mc-note is-warn" role="alert"><Icon name="info" size={16}/>Trình duyệt không cho sao chép tự động. Hãy chọn toàn bộ nội dung bên dưới và sao chép thủ công.</p>}

        {prompt && <details className="mc-prompt" open={showPrompt} onToggle={e => setShowPrompt((e.target as HTMLDetailsElement).open)}>
          <summary>Xem nội dung prompt</summary>
          <p className="mc-note"><Icon name="lock" size={16}/>Prompt không chứa mã bảo mật. Mã chỉ được nhập vào ô bí mật của connector trong Muse.</p>
          <textarea readOnly value={prompt} rows={14} aria-label="Nội dung prompt kết nối Muse" onFocus={e => e.currentTarget.select()}/>
        </details>}

        <p className="mc-foot"><Icon name="info" size={14}/>QLead không đọc được trạng thái Hook trong Muse. QLead chỉ biết Muse đang chạy khi Muse thật sự gọi nhận việc.</p>
      </section>}
  </div>;
}
