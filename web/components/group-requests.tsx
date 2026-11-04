'use client';

import { useState, type FormEvent } from 'react';
import type { CustomerGroupRequest } from '../../src/group-requests';
import { customerStatusHint, customerStatusLabel } from '@/lib/group-request-labels';
import { exactTime } from '@/lib/lead-format';
import { AppShell } from './app-shell';
import { Icon } from './visuals';

/** Customers suggest Facebook groups; QLead reviews them. Shows only this user's own requests. */
export function GroupRequestPage({ initial }: { initial: CustomerGroupRequest[] }) {
  const [requests, setRequests] = useState(initial);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/group-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, note }) });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setRequests(list => [data.request, ...list]);
        setUrl(''); setNote('');
        setMessage({ kind: 'ok', text: 'Đã gửi đề xuất. QLead sẽ xem xét và cập nhật trạng thái tại đây.' });
      } else {
        setMessage({ kind: 'error', text: data.message ?? 'Chưa gửi được. Thử lại sau.' });
      }
    } catch {
      setMessage({ kind: 'error', text: 'Không kết nối được tới QLead. Thử lại sau.' });
    } finally { setBusy(false); }
  }

  return <AppShell active="Đề xuất nhóm">
    <div className="page-head"><div><h1>Đề xuất nhóm Facebook</h1><p>Bạn biết nhóm Facebook có nhiều khách hàng tiềm năng? Gửi đường dẫn để QLead xem xét bổ sung vào nguồn tìm kiếm.</p></div></div>

    <div className="group-request-grid">
      <section className="panel group-request-form" aria-labelledby="gr-form-title">
        <h2 id="gr-form-title">Gửi đề xuất</h2>
        <form onSubmit={submit} noValidate>
          <label className="field"><span>Đường dẫn nhóm Facebook <b aria-hidden="true">*</b></span>
            <input type="url" inputMode="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.facebook.com/groups/..." aria-describedby="gr-url-hint" autoComplete="off"/>
            <small id="gr-url-hint">Mở nhóm trên Facebook rồi copy đường dẫn từ thanh địa chỉ.</small>
          </label>
          <label className="field"><span>Vì sao nên thêm nhóm này? <em>(không bắt buộc)</em></span>
            <textarea rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="Ví dụ: Nhóm có nhiều chủ quán cafe, nhà hàng chuẩn bị khai trương."/>
          </label>
          {message && <p className={`form-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}><Icon name={message.kind === 'ok' ? 'check' : 'info'} size={16}/>{message.text}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>{busy ? 'Đang gửi…' : 'Gửi đề xuất'}</button>
        </form>
        <p className="muted-text small-note">QLead xem xét từng nhóm. Không phải nhóm nào cũng có thể bổ sung, ví dụ nhóm riêng tư hoặc nhóm không cho tìm kiếm bài viết.</p>
      </section>

      <section className="panel group-request-list" aria-labelledby="gr-list-title">
        <div className="panel-head"><h2 id="gr-list-title">Yêu cầu của tôi</h2><span className="muted-text">{requests.length} yêu cầu</span></div>
        {requests.length === 0
          ? <p className="watch-empty muted-text">Bạn chưa đề xuất nhóm nào.</p>
          : <ul className="request-items">{requests.map(r => <li key={r.id}>
            <div className="request-top">
              <a className="request-url" href={r.groupUrl} target="_blank" rel="noopener noreferrer nofollow">{r.groupUrl.replace('https://www.', '')}<Icon name="external" size={14}/></a>
              <span className={`request-status is-${r.status}`}>{customerStatusLabel[r.status]}</span>
            </div>
            {r.note && <p className="request-note">{r.note}</p>}
            <p className="request-hint">{customerStatusHint[r.status]}</p>
            {r.adminNote && <p className="request-reply"><b>Phản hồi từ QLead:</b> {r.adminNote}</p>}
            <span className="request-time">Gửi lúc {exactTime(r.createdAt)}{r.updatedAt !== r.createdAt ? ` · cập nhật ${exactTime(r.updatedAt)}` : ''}</span>
          </li>)}</ul>}
      </section>
    </div>
  </AppShell>;
}
