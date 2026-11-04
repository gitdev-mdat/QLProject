'use client';

import { useMemo, useState } from 'react';
import { ALLOWED_TRANSITIONS, type AdminGroupRequest, type GroupRequestStatus } from '../../src/group-requests';
import { adminStatusLabel, customerStatusLabel } from '@/lib/group-request-labels';
import { Icon } from './visuals';

const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const at = (value: string | null) => (value ? timeFmt.format(new Date(value)) : '—');
type Filter = 'open' | 'all' | GroupRequestStatus;

/** Admin review of customer group suggestions. Decisions only; joining and verifying a group is done by hand. */
export function AdminGroupRequests({ initial }: { initial: AdminGroupRequest[] }) {
  const [requests, setRequests] = useState(initial);
  const [filter, setFilter] = useState<Filter>('all'); // open requests are sorted first; a saved row stays in view
  const shown = useMemo(() => requests.filter(r => filter === 'all' || (filter === 'open' ? r.status === 'pending' || r.status === 'reviewing' : r.status === filter)), [requests, filter]);
  const count = (f: Filter) => requests.filter(r => f === 'all' || (f === 'open' ? r.status === 'pending' || r.status === 'reviewing' : r.status === f)).length;

  return <div className="admin-page">
    <div className="page-head"><div><h1>Đề xuất nhóm Facebook</h1><p>Khách hàng gửi nhóm để QLead xem xét. Hãy tự kiểm tra và tham gia nhóm khi phù hợp. Chỉ chọn "Đã bổ sung" sau khi đã xác minh worker thật sự tìm được bài trong nhóm.</p></div></div>
    <div className="status-tabs" role="tablist" aria-label="Lọc theo trạng thái">
      {(['all', 'open', 'pending', 'reviewing', 'approved', 'added', 'rejected'] as Filter[]).map(f => <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
        {f === 'open' ? 'Cần xử lý' : f === 'all' ? 'Tất cả' : adminStatusLabel[f]}<span>{count(f)}</span></button>)}
    </div>
    {shown.length === 0 ? <section className="admin-section"><p className="muted-text">Không có đề xuất nào trong mục này.</p></section>
      : <ul className="gr-admin-list">{shown.map(r => <RequestRow key={r.id} request={r} onSaved={updated => setRequests(list => list.map(x => x.id === updated.id ? { ...x, ...updated } : x))}/>)}</ul>}
  </div>;
}

function RequestRow({ request: r, onSaved }: { request: AdminGroupRequest; onSaved: (r: Partial<AdminGroupRequest> & { id: string }) => void }) {
  const options = [r.status, ...ALLOWED_TRANSITIONS[r.status]];
  const [status, setStatus] = useState<GroupRequestStatus>(r.status);
  const [note, setNote] = useState(r.adminNote ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const changed = status !== r.status || note.trim() !== (r.adminNote ?? '');

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/admin/group-requests/${r.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ status, adminNote: note }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage({ kind: 'error', text: data.message ?? 'Không lưu được.' }); return; }
      onSaved({ ...data.request, reviewedAt: new Date().toISOString() });
      setMessage({ kind: 'ok', text: `Đã lưu. Khách hàng thấy: "${customerStatusLabel[data.request.status as GroupRequestStatus]}".` });
    } catch { setMessage({ kind: 'error', text: 'Không kết nối được. Thử lại.' }); }
    finally { setBusy(false); }
  }

  return <li className="admin-section gr-admin-item" aria-label={`Đề xuất ${r.groupUrl}`}>
    <div className="gr-admin-top">
      <a className="request-url" href={r.groupUrl} target="_blank" rel="noopener noreferrer nofollow">{r.groupUrl.replace('https://www.', '')}<Icon name="external" size={14}/></a>
      <span className={`pill pill-gr-${r.status}`}>{adminStatusLabel[r.status]}</span>
    </div>
    <dl className="gr-admin-facts">
      <div><dt>Người đề xuất</dt><dd>{r.requester}</dd></div>
      <div><dt>Gửi lúc</dt><dd>{at(r.createdAt)}</dd></div>
      <div><dt>Số khách đề xuất nhóm này</dt><dd>{r.sameGroupRequests}</dd></div>
      <div><dt>Duyệt gần nhất</dt><dd>{r.reviewedAt ? `${at(r.reviewedAt)}${r.reviewer ? ` · ${r.reviewer}` : ''}` : '—'}</dd></div>
    </dl>
    {r.note && <p className="request-note"><b>Ghi chú của khách:</b> {r.note}</p>}
    {r.submittedUrl !== r.groupUrl && <p className="muted-text small">Đường dẫn gốc: <span className="break-all">{r.submittedUrl}</span></p>}
    <div className="gr-admin-edit">
      <label className="field"><span>Trạng thái</span><select value={status} onChange={e => setStatus(e.target.value as GroupRequestStatus)}>{options.map(o => <option key={o} value={o}>{adminStatusLabel[o]}</option>)}</select></label>
      <label className="field"><span>Ghi chú gửi khách {status === 'rejected' ? '(nên ghi lý do)' : '(không bắt buộc)'}</span><textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder={status === 'rejected' ? 'Ví dụ: Nhóm riêng tư, chưa thể tham gia.' : ''}/></label>
      <button type="button" className="btn btn-primary" disabled={busy || !changed} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu quyết định'}</button>
    </div>
    {message && <p className={`form-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </li>;
}
