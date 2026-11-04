'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminHandoff, AdminOverview, AdminWorker } from '@/lib/server/admin';
import { hookActivationPrompt, hookDeactivationPrompt, runPrompt, setupPrompt } from '@/lib/admin-prompts';
import { Icon } from './visuals';

const TZ = 'Asia/Ho_Chi_Minh';
const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const at = (value: string | null | undefined) => (value ? timeFmt.format(new Date(value)) : 'Chưa có');

const STATE_LABEL: Record<string, string> = {
  active: 'Tài khoản đang hoạt động', ready: 'Tài khoản dự phòng · sẵn sàng', paused: 'Tạm dừng · chưa xác minh kết nối',
  draining: 'Đang ngừng nhận việc', unavailable: 'Không khả dụng',
};
const DB_STATUS_LABEL: Record<string, string> = {
  active: 'ACTIVE · QLead cho phép claim', draining: 'DRAINING · từ chối claim mới',
  paused: 'PAUSED · không cho claim', unavailable: 'UNAVAILABLE · không cho claim',
};
const HANDOFF_LABEL: Record<string, string> = {
  preparing: 'Chuẩn bị chuyển đổi', draining: 'Đang chờ tài khoản cũ xử lý xong', awaiting_worker_start: 'Chờ Muse mới bắt đầu',
  verifying: 'Đang kiểm tra Muse mới', completed: 'Chuyển đổi hoàn tất', failed: 'Thất bại · cần xử lý', cancelled: 'Đã huỷ',
};
const STEPS = [
  { key: 'preparing', label: 'Chuẩn bị' }, { key: 'draining', label: 'Ngừng nhận việc' }, { key: 'cutover', label: 'Chuyển sang tài khoản mới' },
  { key: 'awaiting_worker_start', label: 'Chờ Muse mới bắt đầu' }, { key: 'verifying', label: 'Kiểm tra' }, { key: 'completed', label: 'Hoàn tất' },
];
const stepIndex = (status: string) => ({ preparing: 0, draining: 1, awaiting_worker_start: 3, verifying: 4, completed: 5 } as Record<string, number>)[status] ?? -1;

async function call(url: string, body?: unknown): Promise<any> {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message ?? 'Không thực hiện được.'), { data });
  return data;
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="copy-block">
    <div className="copy-block-head"><span>{label}</span>
      <button type="button" className="btn btn-outline btn-sm" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        <Icon name={copied ? 'check' : 'copy'} size={16}/>{copied ? 'Đã copy' : 'Copy'}</button></div>
    <pre>{text}</pre>
  </div>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}>✕</button></div>
      <div className="modal-body">{children}</div>
    </div>
  </div>;
}

type Confirm = { title: string; lines: React.ReactNode; confirmLabel: string; danger?: boolean; needsReason?: boolean; run: (reason: string) => Promise<void> };

export function AdminWorkers({ initial }: { initial: AdminOverview }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ workerName: string; credential: string } | null>(null);
  const [setupFor, setSetupFor] = useState<AdminWorker | null>(null);
  const [hookFor, setHookFor] = useState<AdminWorker | null>(null);

  const reload = useCallback(async () => {
    try { setData(await call('/api/admin/workers')); } catch (e) { setError((e as Error).message); }
  }, []);
  const open = data.openHandoff;
  useEffect(() => {
    const id = setInterval(reload, open ? 10_000 : 60_000);
    return () => clearInterval(id);
  }, [reload, open]);

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(success); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setConfirm(null); setReason(''); await reload(); }
  }

  const active = data.workers.find(w => w.status === 'active' || w.status === 'draining');
  const baseUrl = data.publicUrl;

  return <div className="admin-page">
    <div className="page-head">
      <div><h1>Tài khoản Muse</h1><p>Tài khoản Muse chỉ là nơi thực thi tìm kiếm. Dữ liệu, nhu cầu theo dõi và lịch sử của khách luôn nằm trong QLead.</p></div>
      <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plug" size={18}/>Thêm tài khoản Muse</button>
    </div>

    {error && <div className="admin-alert admin-alert-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>Đóng</button></div>}
    {notice && <div className="admin-alert admin-alert-ok" role="status"><Icon name="check" size={18}/><span>{notice}</span></div>}
    {!baseUrl && <div className="admin-alert admin-alert-warn" role="note"><Icon name="info" size={18}/><span>Chưa cấu hình QLEAD_WORKER_PUBLIC_URL nên prompt Muse chưa có địa chỉ QLead. Thêm biến này vào môi trường của web rồi tải lại trang.</span></div>}

    {open ? <HandoffPanel handoff={open} workers={data.workers} baseUrl={baseUrl} busy={busy}
      onAction={(action, label, extra) => act(() => call(`/api/admin/handoffs/${open.id}`, { action, ...extra }), label)}
      onConfirm={setConfirm}/>
      : <StartHandoff workers={data.workers} busy={busy} onError={setError} onConfirm={setConfirm}
        onPrepare={(sourceId, destinationId) => act(() => call('/api/admin/handoffs', { sourceId, destinationId }), 'Đã tạo bản chuẩn bị chuyển đổi. Chưa có tài khoản nào bị thay đổi.')}/>}

    <section className="admin-section" aria-labelledby="workers-h">
      <h2 id="workers-h">Danh sách tài khoản</h2>
      {data.workers.length === 0 ? <p className="muted-text">Chưa có tài khoản Muse nào. Bấm "Thêm tài khoản Muse" để bắt đầu.</p>
        : <div className="worker-grid">{data.workers.map(w => <WorkerCard key={w.id} worker={w} inHandoff={Boolean(open && (open.sourceId === w.id || open.destinationId === w.id))} anyActive={Boolean(active && active.id !== w.id)} busy={busy}
          onSetup={() => setSetupFor(w)}
          onHook={() => setHookFor(w)}
          onConfirm={setConfirm}
          onAction={(body, label) => act(async () => { const r = await call(`/api/admin/workers/${w.id}`, body); if (r.credential) setSecret({ workerName: w.name, credential: r.credential }); }, label)}/>)}</div>}
    </section>

    <section className="admin-section" aria-labelledby="queue-h">
      <h2 id="queue-h">Công việc cần tiếp tục</h2>
      <dl className="stat-grid">
        <div><dt>Đang chờ chạy</dt><dd>{data.queue.pending}</dd></div>
        <div><dt>Công việc đang xử lý</dt><dd>{data.queue.claimed}</dd></div>
        <div><dt>Cần chạy lại</dt><dd>{data.queue.retry}</dd></div>
        <div><dt>Bị chặn / cần cấp lại quyền</dt><dd>{data.queue.blocked + data.queue.needsReauth}</dd></div>
        <div><dt>Thất bại 24 giờ</dt><dd>{data.queue.failed24h}</dd></div>
        <div><dt>Nhu cầu đang bật</dt><dd>{data.profiles.active}</dd></div>
      </dl>
      <p className="muted-text small">Lượt chờ lâu nhất: {at(data.queue.oldestPendingSlot)}. {data.profiles.withGap > 0
        ? <b className="warn-text">{data.profiles.withGap} nhu cầu chưa có lượt quét thành công trong 2 chu kỳ gần nhất, nghĩa là việc theo dõi đang bị gián đoạn.</b>
        : 'Mọi nhu cầu đang bật đều có lượt quét thành công gần đây.'} Lượt 30 phút bị lỡ không được chạy bù. Mỗi nhu cầu giữ tối đa một việc đang chờ, và việc đó được chạy khi có tài khoản hoạt động.</p>
    </section>

    <section className="admin-section" aria-labelledby="history-h">
      <h2 id="history-h">Lịch sử chuyển đổi</h2>
      {data.history.length === 0 ? <p className="muted-text">Chưa có lượt chuyển đổi nào.</p>
        : <ol className="handoff-history">{data.history.map(h => <li key={h.id}>
          <span className={`pill pill-${h.status}`}>{HANDOFF_LABEL[h.status] ?? h.status}</span>
          <span><b>{h.sourceName}</b> → <b>{h.destinationName}</b>{h.mode === 'emergency' ? ' · khẩn cấp' : ''}</span>
          <span className="muted-text">Tạo {at(h.createdAt)}{h.cutoverAt ? ` · chuyển ${at(h.cutoverAt)}` : ''}{h.firstSuccessAt ? ` · job đầu tiên xong ${at(h.firstSuccessAt)}` : ''}{h.failureReason ? ` · ${h.failureReason}` : ''}</span>
        </li>)}</ol>}
    </section>

    {adding && <AddWorker busy={busy} onClose={() => setAdding(false)} onCreated={async (name, credential) => { setAdding(false); setSecret({ workerName: name, credential }); await reload(); }} onError={setError}/>}
    {secret && <Modal title="Credential mới (chỉ hiện một lần)" onClose={() => setSecret(null)}>
      <p>Copy credential của <b>{secret.workerName}</b> rồi dán thẳng vào <b>Secure Credentials Store</b> của connector "QLead Worker" trong Muse. Không dán vào chat, prompt hay file. Đóng hộp thoại này thì không xem lại được nữa; nếu làm mất, hãy tạo lại credential.</p>
      <CopyBlock text={secret.credential} label="Credential"/>
      <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>Tôi đã lưu vào Muse</button></div>
    </Modal>}
    {setupFor && <Modal title={`Kết nối ${setupFor.name} với QLead (một lần)`} onClose={() => setSetupFor(null)}>
      <SetupGuide worker={setupFor} baseUrl={baseUrl}/>
    </Modal>}
    {hookFor && <Modal title={`Muse Personal Agent Hook · ${hookFor.name}`} onClose={() => setHookFor(null)}>
      <HookGuide worker={hookFor} baseUrl={baseUrl}/>
    </Modal>}
    {confirm && <Modal title={confirm.title} onClose={() => { setConfirm(null); setReason(''); }}>
      <div className="confirm-lines">{confirm.lines}</div>
      {confirm.needsReason && <label className="field"><span>Lý do</span><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ví dụ: Muse 02 không gọi QLead sau 20 phút"/></label>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => { setConfirm(null); setReason(''); }}>Quay lại</button>
        <button type="button" className={`btn ${confirm.danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (confirm.needsReason && !reason.trim())} onClick={() => confirm.run(reason.trim())}>{busy ? 'Đang thực hiện…' : confirm.confirmLabel}</button>
      </div>
    </Modal>}
  </div>;
}

function WorkerCard({ worker: w, inHandoff, anyActive, busy, onSetup, onHook, onAction, onConfirm }: {
  worker: AdminWorker; inHandoff: boolean; anyActive: boolean; busy: boolean; onSetup: () => void;
  onHook: () => void;
  onAction: (body: unknown, label: string) => void; onConfirm: (c: Confirm) => void;
}) {
  return <article className={`worker-card state-${w.state}`} aria-label={w.name}>
    <header><h3>{w.name}</h3><span className={`pill pill-${w.state}`}>{STATE_LABEL[w.state] ?? w.state}</span></header>
    {w.standbyContact && <p className="warn-box"><Icon name="info" size={16}/>Tài khoản này vẫn gọi nhận việc lúc {at(w.lastClaimAt)} dù đang không hoạt động. Có thể lịch chạy trong Muse chưa tắt và đang tốn quota.</p>}
    <dl className="worker-facts">
      <div><dt>Trạng thái worker trong QLead</dt><dd>{DB_STATUS_LABEL[w.status] ?? w.status}</dd></div>
      <div><dt>Connector / credential</dt><dd>{w.credentialStatus !== 'active' ? 'Credential đã bị thu hồi' : w.connectionVerifiedAt ? <>Đã xác minh {at(w.connectionVerifiedAt)}<small>Kiểm tra một lần trước đó; không chứng minh Muse đang trực tuyến.</small></> : 'Chưa xác minh'}</dd></div>
      <div><dt>Muse Personal Agent Hook</dt><dd>Không được QLead quan sát<small>Trạng thái cần xác nhận thủ công trong Muse main account; ACTIVE trong PostgreSQL không có nghĩa Hook đang bật.</small></dd></div>
      <div><dt>Gọi endpoint /claim gần nhất</dt><dd>{at(w.lastClaimAt)}<small>Có thể là lần gọi không nhận được job.</small></dd></div>
      <div><dt>Nhận job thành công gần nhất</dt><dd>{at(w.lastSuccessfulClaimAt)}<small>Thời điểm QLead ghi nhận một attempt được giao cho worker này.</small></dd></div>
      <div><dt>Liên hệ gần nhất</dt><dd>{at(w.lastSeenAt)}</dd></div>
      <div><dt>Job thành công gần nhất</dt><dd>{at(w.lastSuccessAt)}</dd></div>
      <div><dt>Đang xử lý</dt><dd>{w.inFlight} job</dd></div>
      <div><dt>Đã hoàn tất</dt><dd>{w.completedAttempts} job{w.avgSeconds != null ? <small>trung bình {w.avgSeconds} giây/job (từ lúc nhận tới lúc nộp)</small> : null}</dd></div>
      <div><dt>Lỗi 24 giờ</dt><dd>{w.failedAttempts24h}</dd></div>
      <div><dt>Nguồn được phép</dt><dd>{w.authorizedSources.join(', ')}</dd></div>
      <div><dt>Mỗi lần nhận</dt><dd>tối đa {w.maxJobsPerClaim} job · lease {w.leaseMinutes} phút</dd></div>
    </dl>
    {w.recentErrors.length > 0 && <details className="worker-errors"><summary>Lỗi gần đây ({w.recentErrors.length})</summary>
      <ul>{w.recentErrors.map((e, i) => <li key={i}>{at(e.at)} · {e.outcome === 'expired' ? 'Hết lease' : e.code ?? e.outcome}{e.message ? `: ${e.message}` : ''}</li>)}</ul></details>}
    <p className="muted-text small">Không hiển thị quota còn lại vì Muse không có cách được hỗ trợ để QLead đọc số này.</p>
    <div className="worker-actions">
      <button type="button" className="btn btn-outline btn-sm" onClick={onSetup}>Hướng dẫn kết nối</button>
      <button type="button" className="btn btn-outline btn-sm" onClick={onHook}>Hướng dẫn Hook</button>
      {!inHandoff && w.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onConfirm({
        title: `Tạm dừng ${w.name}?`, confirmLabel: 'Tạm dừng', danger: true,
        lines: <><p>{w.name} sẽ không nhận việc mới. {w.inFlight} job đang xử lý vẫn được phép nộp kết quả.</p><p>Nếu không có tài khoản nào khác hoạt động, việc theo dõi của khách sẽ bị gián đoạn. Muốn chuyển việc sang tài khoản khác thì dùng "Chuẩn bị chuyển đổi".</p></>,
        run: async () => onAction({ action: 'pause' }, `${w.name} đã tạm dừng nhận việc.`),
      })}>Tạm dừng</button>}
      {!inHandoff && w.status !== 'active' && !anyActive && w.credentialStatus === 'active' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onConfirm({
        title: `Kích hoạt ${w.name}?`, confirmLabel: 'Kích hoạt trong QLead',
        lines: <><p>QLead sẽ cho phép {w.name} nhận việc. Việc này <b>không</b> tự bật Muse: bạn vẫn cần bật lịch chạy trong Muse.</p></>,
        run: async () => onAction({ action: 'activate' }, `${w.name} đã được kích hoạt trong QLead. Hãy bật lịch chạy trong Muse.`),
      })}>Kích hoạt</button>}
      {!inHandoff && w.status !== 'unavailable' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onConfirm({
        title: `Đánh dấu ${w.name} không khả dụng?`, confirmLabel: 'Đánh dấu và trả việc về hàng chờ', danger: true,
        lines: <><p>{w.inFlight} job đang giao cho {w.name} sẽ được trả về hàng chờ. Nếu sau đó tài khoản này nộp kết quả của các job đó, QLead sẽ từ chối.</p></>,
        run: async () => onAction({ action: 'unavailable', release: true }, `${w.name} được đánh dấu không khả dụng.`),
      })}>Không khả dụng</button>}
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onConfirm({
        title: `Tạo lại credential cho ${w.name}?`, confirmLabel: 'Tạo credential mới', danger: true,
        lines: <><p>Credential cũ ngừng hoạt động ngay. Muse sẽ bị từ chối cho tới khi bạn dán credential mới vào connector "QLead Worker" và kiểm tra lại kết nối.</p></>,
        run: async () => onAction({ action: 'rotate' }, `Đã tạo credential mới cho ${w.name}.`),
      })}>Tạo lại credential</button>
    </div>
  </article>;
}

function SetupGuide({ worker, baseUrl }: { worker: AdminWorker; baseUrl: string | null }) {
  const url = baseUrl ?? '<QLEAD_WORKER_PUBLIC_URL>';
  return <ol className="guide-steps">
    <li><b>Tạo connector trong {worker.name}.</b> Vào Muse → Connectors → tạo Custom Connector tên <code>QLead Worker</code>, Base URL <code>{url}</code>. Không sửa connector "Local Lead Bridge".</li>
    <li><b>Nhập credential an toàn.</b> Dán credential đã nhận lúc tạo tài khoản vào Secure Credentials Store của connector, dùng làm Bearer token. Nếu đã mất credential, bấm "Tạo lại credential".</li>
    <li><b>Kiểm tra kết nối một lần.</b> Dán prompt dưới đây vào {worker.name}. Muse chỉ gửi một request kiểm tra, không nhận việc, không tìm Facebook và không tạo lịch.
      <CopyBlock text={setupPrompt(worker.name, url)} label="Prompt kiểm tra kết nối"/></li>
    <li><b>Xem kết quả tại đây.</b> Khi Muse gọi thành công, mục "Kết nối" sẽ ghi "Đã xác minh" kèm thời gian. Tài khoản vẫn ở trạng thái tạm dừng, nên khi ở chế độ dự phòng thì không tạo lịch chạy nào trong Muse.</li>
    <li><b>Lưu sẵn prompt làm việc</b> (chưa bật lịch). Dùng khi tài khoản này được chuyển sang hoạt động.
      <CopyBlock text={runPrompt(worker.name, url, worker.maxJobsPerClaim)} label="Prompt một chu kỳ làm việc"/></li>
  </ol>;
}

function HookGuide({ worker, baseUrl }: { worker: AdminWorker; baseUrl: string | null }) {
  const url = baseUrl ?? '<QLEAD_WORKER_PUBLIC_URL>';
  return <>
    <p className="info-box"><Icon name="info" size={16}/>QLead không có kết nối để đọc hoặc bật/tắt Muse Hook. Trạng thái dưới đây phải được kiểm tra thủ công trong Muse main account. Chỉ bật khi worker đang ACTIVE trong QLead; Hook standby phải tắt để không polling/tốn quota.</p>
    <h3 className="sub-h">Kích hoạt hoặc bật lại cho {worker.name}</h3>
    <CopyBlock text={hookActivationPrompt(worker.name, url)} label="Prompt kích hoạt Hook thường trực · Muse main account"/>
    <h3 className="sub-h">Tắt Hook nhưng giữ connector và trạng thái dedupe</h3>
    <CopyBlock text={hookDeactivationPrompt(worker.name)} label="Prompt tắt Hook · Muse main account"/>
  </>;
}

function StartHandoff({ workers, busy, onPrepare, onConfirm, onError }: {
  workers: AdminWorker[]; busy: boolean; onPrepare: (s: string, d: string) => Promise<void>; onConfirm: (c: Confirm) => void; onError: (m: string) => void;
}) {
  const active = workers.find(w => w.status === 'active' || w.status === 'draining');
  const standby = workers.find(w => w.id !== active?.id && w.state === 'ready') ?? workers.find(w => w.id !== active?.id);
  const [source, setSource] = useState(active?.id ?? workers[0]?.id ?? '');
  const [destination, setDestination] = useState(standby?.id ?? '');
  if (workers.length < 2) return <section className="admin-section handoff-start"><h2>Chuẩn bị chuyển đổi</h2><p className="muted-text">Cần ít nhất hai tài khoản Muse để chuyển việc.</p></section>;
  async function review() {
    try {
      const s = await call('/api/admin/handoffs/preview', { sourceId: source, destinationId: destination });
      onConfirm({
        title: `Chuẩn bị chuyển từ ${s.source.name} sang ${s.destination.name}`, confirmLabel: 'Tạo bản chuẩn bị',
        lines: <SummaryView summary={s} note="Bước này chỉ ghi lại hiện trạng. Chưa có tài khoản nào bị thay đổi và QLead không gọi Muse."/>,
        run: async () => onPrepare(source, destination),
      });
    } catch (e) { onError((e as Error).message); }
  }
  return <section className="admin-section handoff-start" aria-labelledby="start-h">
    <h2 id="start-h">Chuẩn bị chuyển đổi</h2>
    <p className="muted-text">Chọn tài khoản nguồn và tài khoản đích, xem lại hiện trạng công việc rồi xác nhận. Có thể chuẩn bị trước (ví dụ 23:30) và chuyển vào lúc nửa đêm.</p>
    <div className="handoff-pick">
      <label className="field"><span>Từ tài khoản</span><select value={source} onChange={e => setSource(e.target.value)}>{workers.map(w => <option key={w.id} value={w.id}>{w.name} · {STATE_LABEL[w.state]}</option>)}</select></label>
      <span className="handoff-arrow" aria-hidden="true"><Icon name="arrow" size={20}/></span>
      <label className="field"><span>Sang tài khoản</span><select value={destination} onChange={e => setDestination(e.target.value)}>{workers.map(w => <option key={w.id} value={w.id}>{w.name} · {STATE_LABEL[w.state]}</option>)}</select></label>
      <button type="button" className="btn btn-primary" disabled={busy || !source || !destination || source === destination} onClick={review}>Xem lại công việc</button>
    </div>
  </section>;
}

function SummaryView({ summary: s, note }: { summary: any; note?: string }) {
  if (!s?.jobs) return null;
  return <div className="summary-view">
    {note && <p>{note}</p>}
    <dl className="stat-grid compact">
      <div><dt>Đã hoàn tất</dt><dd>{s.jobs.completed_total}</dd></div>
      <div><dt>Đang chờ chạy</dt><dd>{s.jobs.pending}</dd></div>
      <div><dt>Tài khoản cũ đang xử lý</dt><dd>{s.jobs.in_flight_source}</dd></div>
      <div><dt>Đã trả về hàng chờ</dt><dd>{s.jobs.released_waiting}</dd></div>
      <div><dt>Cần chạy lại</dt><dd>{s.jobs.retryable}</dd></div>
      <div><dt>Bị chặn / cần cấp lại quyền</dt><dd>{s.jobs.blocked + s.jobs.needs_reauthorization}</dd></div>
      <div><dt>Nhu cầu đang bật</dt><dd>{s.profiles.active}</dd></div>
      <div><dt>Đang gián đoạn theo dõi</dt><dd>{s.profiles.monitoring_gaps}</dd></div>
    </dl>
    <p className="small">Lần chạy thành công gần nhất của {s.source.name}: {at(s.source.last_success_at)} · Việc chờ lâu nhất: {at(s.jobs.oldest_pending_slot)}</p>
    <ul className="check-list">{s.checks.map((c: any) => <li key={c.key} className={c.ok ? 'ok' : c.blocking ? 'bad' : 'warn'}><Icon name={c.ok ? 'check' : 'info'} size={16}/>{c.message}</li>)}</ul>
    {s.in_flight_source.length > 0 && <p className="small">Job đang xử lý: {s.in_flight_source.map((j: any) => `${j.job_id.slice(0, 8)} (lần ${j.attempt_no}, lease hết ${at(j.lease_expires_at)})`).join(' · ')}</p>}
    {s.next_jobs.length > 0 && <details><summary>Việc sẽ chạy tiếp ({s.next_jobs.length})</summary>
      <ul className="next-jobs">{s.next_jobs.map((j: any) => <li key={j.job_id}><code>{j.job_id.slice(0, 8)}</code> · lượt {at(j.scheduled_for)} · {j.status}{j.attempts ? ` · đã thử ${j.attempts} lần` : ''}</li>)}</ul></details>}
  </div>;
}

function HandoffPanel({ handoff: h, workers, baseUrl, busy, onAction, onConfirm }: {
  handoff: AdminHandoff; workers: AdminWorker[]; baseUrl: string | null; busy: boolean;
  onAction: (action: string, label: string, extra?: Record<string, unknown>) => Promise<void>; onConfirm: (c: Confirm) => void;
}) {
  const destination = workers.find(w => w.id === h.destinationId);
  const source = workers.find(w => w.id === h.sourceId);
  const summary = h.cutoverSummary ?? h.preparedSummary;
  const current = stepIndex(h.status);
  const [waitedMinutes, setWaited] = useState<number | null>(null);
  useEffect(() => {
    if (!h.cutoverAt) return;
    const tick = () => setWaited(Math.floor((Date.now() - new Date(h.cutoverAt!).getTime()) / 60_000));
    tick(); const id = setInterval(tick, 30_000); return () => clearInterval(id);
  }, [h.cutoverAt]);
  const inFlight = summary?.jobs?.in_flight_source ?? 0;
  const url = baseUrl ?? '<QLEAD_WORKER_PUBLIC_URL>';
  const cutoverConfirm = (emergency: boolean): Confirm => ({
    title: emergency ? 'Chuyển khẩn cấp sang tài khoản mới?' : 'Chuyển sang tài khoản mới?',
    confirmLabel: emergency ? 'Chuyển khẩn cấp' : 'Chuyển sang tài khoản mới', danger: emergency,
    lines: <>
      <p><b>{h.sourceName}</b> sẽ {emergency ? 'bị đánh dấu không khả dụng' : 'tạm dừng'}; <b>{h.destinationName}</b> được phép nhận việc trong QLead.</p>
      {emergency ? <p>Các job {h.sourceName} đang giữ sẽ được trả về hàng chờ để {h.destinationName} chạy lại thành một lần thử mới. Kết quả nộp muộn từ {h.sourceName} sẽ bị từ chối, nên không có kết quả trùng.</p>
        : <p>Nếu {h.sourceName} vẫn còn job đang xử lý, QLead sẽ từ chối bước này để không bỏ dở công việc hợp lệ.</p>}
      <p>Trước khi xác nhận, hãy bảo đảm Hook nguồn đã được tắt thủ công trong Muse main account. QLead không thể tắt Hook và sẽ không tự bật Hook đích.</p>
      <p>Việc này <b>không</b> tự bật Muse Hook. Sau khi chuyển, hãy bật Hook cho worker mới trong Muse main account và giữ Hook của worker cũ tắt.</p>
      <SummaryView summary={summary}/>
    </>,
    run: async () => onAction(emergency ? 'cutover_emergency' : 'cutover', `Đã chuyển trong QLead. Đang chờ ${h.destinationName} bắt đầu.`),
  });
  return <section className={`admin-section handoff-panel status-${h.status}`} aria-labelledby="handoff-h">
    <div className="handoff-head">
      <div><h2 id="handoff-h">{h.sourceName} → {h.destinationName}</h2><p className="muted-text">Tạo lúc {at(h.createdAt)}{h.mode === 'emergency' ? ' · chế độ khẩn cấp' : ''}</p></div>
      <span className={`pill pill-${h.status}`}>{HANDOFF_LABEL[h.status]}</span>
    </div>
    <ol className="stepper">{STEPS.map((s, i) => <li key={s.key} className={i < current || (s.key === 'cutover' && h.cutoverAt) ? 'done' : i === current ? 'current' : ''}><span>{i + 1}</span>{s.label}</li>)}</ol>

    {(h.status === 'preparing' || h.status === 'draining') && <>
      <h3 className="sub-h">Tắt Hook của worker nguồn trong Muse main account</h3>
      <p className="muted-text small">Tắt polling trước khi drain. Giữ lại Hook và generation state để lần chuyển ngược không phải cấu hình lại; không xoá connector hay credential. Job đã được claim vẫn được phép hoàn tất.</p>
      <CopyBlock text={hookDeactivationPrompt(h.sourceName)} label={`Prompt tắt Hook · ${h.sourceName}`}/>
      <SummaryView summary={summary}/>
      {h.status === 'draining' && <p className="info-box"><Icon name="clock" size={16}/>{h.sourceName} không nhận việc mới từ {at(h.drainStartedAt)}. {inFlight > 0 ? `Còn ${inFlight} job đang xử lý; hãy chờ các job này xong hoặc hết lease. Bấm "Kiểm tra lại" để cập nhật.` : 'Không còn job nào đang xử lý, có thể chuyển ngay.'}</p>}
      <div className="handoff-actions">
        {h.status === 'preparing' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAction('drain', `${h.sourceName} đã ngừng nhận việc mới.`)}>Ngừng nhận việc ở {h.sourceName}</button>}
        <button type="button" className={`btn ${h.status === 'draining' ? 'btn-primary' : 'btn-outline'}`} disabled={busy} onClick={() => onConfirm(cutoverConfirm(false))}>Chuyển sang tài khoản mới</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onConfirm(cutoverConfirm(true))}>Chuyển khẩn cấp</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onAction('refresh', 'Đã cập nhật.')}>Kiểm tra lại</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onConfirm({ title: 'Huỷ lượt chuyển đổi?', confirmLabel: 'Huỷ chuyển đổi', lines: <p>{h.status === 'draining' ? `${h.sourceName} sẽ được nhận việc lại như trước.` : 'Không có gì bị thay đổi.'}</p>, run: async () => onAction('cancel', 'Đã huỷ lượt chuyển đổi.') })}>Huỷ</button>
      </div>
    </>}

    {(h.status === 'awaiting_worker_start' || h.status === 'verifying') && <>
      <div className={`info-box ${h.status === 'awaiting_worker_start' && waitedMinutes !== null && waitedMinutes >= 15 ? 'warn' : ''}`}>
        <Icon name={h.status === 'verifying' ? 'radar' : 'clock'} size={16}/>
        {h.status === 'awaiting_worker_start'
          ? <span>QLead đã chuyển lúc {at(h.cutoverAt)}, nhưng <b>{h.destinationName} chưa gọi QLead</b>{waitedMinutes !== null ? ` (đã ${waitedMinutes} phút)` : ''}. Chuyển đổi chưa hoàn tất cho tới khi Muse mới thật sự bắt đầu. Trong lúc này, việc theo dõi đang tạm dừng.</span>
          : <span>{h.destinationName} đã liên hệ lúc {at(h.firstContactAt)}{h.firstClaimAt ? ` và nhận việc lúc ${at(h.firstClaimAt)}` : ''}. Đang chờ job đầu tiên hoàn tất.</span>}
      </div>
      <h3 className="sub-h">Bật Hook cho {h.destinationName} trong Muse main account</h3>
      <p className="muted-text small">Chỉ bật sau khi QLead xác nhận {h.destinationName} là ACTIVE. Giữ nguyên generation state của Hook qua lần chuyển worker.</p>
      <CopyBlock text={hookActivationPrompt(h.destinationName, url)} label={`Prompt kích hoạt Hook · ${h.destinationName}`}/>
      <h3 className="sub-h">Giữ {h.sourceName} ở chế độ dự phòng</h3>
      <p className="muted-text small">Hook nguồn phải tiếp tục tắt. Connector và credential vẫn giữ nguyên để chuyển về sau không cần onboarding lại.</p>
      {source && <CopyBlock text={hookDeactivationPrompt(h.sourceName)} label={`Prompt xác nhận Hook tắt · ${h.sourceName}`}/>}
      <SummaryView summary={summary}/>
      <div className="handoff-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAction('refresh', 'Đã kiểm tra lại.')}>Kiểm tra lại</button>
        {h.status === 'verifying' && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onConfirm({ title: 'Xác nhận hoàn tất khi không có việc?', confirmLabel: 'Xác nhận hoàn tất', lines: <p>Chỉ dùng khi {h.destinationName} đã gọi nhận việc sau thời điểm chuyển nhưng hàng chờ đang trống. QLead sẽ kiểm tra lại bằng chứng này trước khi ghi nhận.</p>, run: async () => onAction('confirm', 'Đã ghi nhận chuyển đổi hoàn tất.') })}>Xác nhận hoàn tất (không có việc)</button>}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onConfirm({ title: 'Đánh dấu chuyển đổi thất bại?', confirmLabel: 'Đánh dấu thất bại', danger: true, needsReason: true,
          lines: <p>Trạng thái các tài khoản không bị thay đổi tự động. Sau đó bạn có thể tạo lượt chuyển mới, ví dụ chuyển về {h.sourceName}. Công việc đang chờ vẫn được giữ nguyên.</p>,
          run: async reason => onAction('fail', 'Đã ghi nhận thất bại. Hãy chọn tài khoản để tiếp tục chạy.', { reason }) })}>Muse mới không khởi động được</button>
      </div>
    </>}
  </section>;
}

function AddWorker({ busy, onClose, onCreated, onError }: { busy: boolean; onClose: () => void; onCreated: (name: string, credential: string) => Promise<void>; onError: (m: string) => void }) {
  const [name, setName] = useState('Muse Worker 02');
  const [sources, setSources] = useState('social.search');
  const [maxJobs, setMaxJobs] = useState(2);
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setSaving(true);
    try {
      const r = await call('/api/admin/workers', { name: name.trim(), sources: sources.split(',').map(s => s.trim()).filter(Boolean), maxJobs });
      await onCreated(r.worker.name, r.credential);
    } catch (err) { onError((err as Error).message); onClose(); } finally { setSaving(false); }
  }
  return <Modal title="Thêm tài khoản Muse" onClose={onClose}>
    <form className="add-worker" onSubmit={submit}>
      <p>Mỗi tài khoản Muse chỉ cần kết nối một lần. Tài khoản mới ở trạng thái <b>tạm dừng</b> và không nhận việc cho tới khi bạn chuyển việc sang nó.</p>
      <label className="field"><span>Tên tài khoản</span><input value={name} onChange={e => setName(e.target.value)} required maxLength={200}/></label>
      <label className="field"><span>Nguồn được phép</span><input value={sources} onChange={e => setSources(e.target.value)} required/><small>Chỉ ghi những nguồn Facebook mà tài khoản này thật sự truy cập được, phân cách bằng dấu phẩy. Tài khoản mới không kế thừa quyền Facebook của tài khoản cũ.</small></label>
      <label className="field"><span>Số job tối đa mỗi lần nhận</span><input type="number" min={1} max={10} value={maxJobs} onChange={e => setMaxJobs(Number(e.target.value))}/></label>
      <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>Huỷ</button><button type="submit" className="btn btn-primary" disabled={busy || saving}>{saving ? 'Đang tạo…' : 'Tạo tài khoản'}</button></div>
    </form>
  </Modal>;
}
