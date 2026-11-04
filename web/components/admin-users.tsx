'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorText, frequencyText, MONITORING_LABEL, profileEffect, USERS_PAGE_SIZE, type AdminUserDetail, type AdminUserPage, type AdminUserRow, type MonitoringChange, type UserDeletionImpact } from '@/lib/admin-users';
import { Icon } from './visuals';

const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
const at = (value: string | null) => (value ? timeFmt.format(new Date(value)) : '—');
const clockFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
const timeOnly = (value: string) => clockFmt.format(new Date(value));
const num = new Intl.NumberFormat('vi-VN');

type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string; body?: any };

async function call<T>(url: string, what: 'list' | 'detail' | 'change' | 'deletion', init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(url, { cache: 'no-store', ...init });
    const data = await response.json().catch(() => null);
    if (response.ok && data) return { ok: true, data: data as T };
    return { ok: false, status: response.status, error: apiErrorText(response.status, data, what), code: data?.error, body: data };
  } catch { return { ok: false, status: 0, error: apiErrorText(0, null, what) }; }
}

/** Short, stable label for an account. Display names are not unique, so every place that names an account also shows this. */
// First and last characters: one end alone can repeat (e.g. sequential ids), both together tell accounts apart at a glance.
const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const DELETE_WORD = 'XÓA';
const typedDeleteWord = (value: string) => value.normalize('NFC').trim().toLocaleUpperCase('vi-VN') === DELETE_WORD;

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="id-chip"><code className="mono" aria-label={`Mã tài khoản ${id}`}>{id}</code>
    <button type="button" className="icon-btn id-copy" aria-label="Sao chép mã tài khoản" title="Sao chép mã tài khoản" onClick={() => {
      void navigator.clipboard?.writeText(id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
    }}><Icon name={copied ? 'check' : 'copy'} size={14}/></button></span>;
}

function StatusBadge({ status }: { status: 'active' | 'suspended' }) {
  return <span className={`pill mon-pill is-${status}`}><i aria-hidden="true"/>{MONITORING_LABEL[status]}</span>;
}

function lastScanText(row: AdminUserRow): { text: string; tone?: 'bad' | 'warn' } {
  if (!row.lastScanAt) return { text: 'Chưa có lượt quét' };
  if (row.lastScanStatus === 'failed') return { text: `${at(row.lastScanAt)} · lỗi`, tone: 'bad' };
  if (row.lastScanStatus === 'partial') return { text: `${at(row.lastScanAt)} · một phần`, tone: 'warn' };
  return { text: at(row.lastScanAt) };
}

function profilesText(row: AdminUserRow): string {
  if (row.activeProfileCount === 0) return 'Chưa có nhu cầu';
  if (row.status === 'suspended') return `${row.activeProfileCount} nhu cầu · không quét mới`;
  return `${row.activeProfileCount} nhu cầu · ${row.enabledProfileCount} đang bật`;
}

/** Admin list of customers with account-level lead monitoring. Suspension changes only happen in the detail panel, after a confirmation. */
export function AdminUsers({ initial, initialQuery, initialPage, currentAdminId }: { initial: AdminUserPage | null; initialQuery: string; initialPage: number; currentAdminId: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [applied, setApplied] = useState({ q: initialQuery, page: initialPage });
  const [data, setData] = useState<AdminUserPage | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initial ? '' : 'Không tải được danh sách khách hàng. Thử lại sau ít phút.');
  const [openId, setOpenId] = useState<string | null>(null);
  const [deletedNotice, setDeletedNotice] = useState('');
  useEffect(() => {
    if (!deletedNotice) return;
    const timer = window.setTimeout(() => setDeletedNotice(''), 8000);
    return () => window.clearTimeout(timer);
  }, [deletedNotice]);
  const request = useRef(0);
  const first = useRef(true);

  const load = useCallback(async (q: string, page: number) => {
    const id = ++request.current;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(USERS_PAGE_SIZE) });
    if (q) params.set('q', q);
    const result = await call<AdminUserPage>(`/api/admin/users?${params}`, 'list');
    if (id !== request.current) return; // a newer search or page replaced this one
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setError('');
    setData(result.data);
    // After a deletion the last page can become empty: step back to the new last page, keeping the search.
    if (result.data.users.length === 0 && result.data.total > 0 && page > 1) setApplied(a => ({ ...a, page: Math.ceil(result.data.total / USERS_PAGE_SIZE) }));
  }, []);

  useEffect(() => {
    if (first.current && initial) { first.current = false; return; }
    first.current = false;
    const url = new URL(window.location.href);
    if (applied.q) url.searchParams.set('q', applied.q); else url.searchParams.delete('q');
    if (applied.page > 1) url.searchParams.set('page', String(applied.page)); else url.searchParams.delete('page');
    window.history.replaceState(null, '', url);
    void load(applied.q, applied.page);
  }, [applied, load, initial]);

  useEffect(() => {
    const q = query.trim();
    if (q === applied.q) return;
    const timer = window.setTimeout(() => setApplied({ q, page: 1 }), 350);
    return () => window.clearTimeout(timer);
  }, [query, applied.q]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const from = total === 0 ? 0 : (applied.page - 1) * USERS_PAGE_SIZE + 1;
  const to = Math.min(total, applied.page * USERS_PAGE_SIZE);
  const rows = data?.users ?? [];
  const onChanged = useCallback(() => void load(applied.q, applied.page), [load, applied]);

  return <div className="admin-page">
    <div className="page-head"><div>
      <h1>Khách hàng</h1>
      <p>Xem khách hàng đã đăng ký và trạng thái tìm lead của từng tài khoản. Ngưng tìm lead chỉ dừng các lượt tìm mới; khách vẫn đăng nhập và xem lại lead cũ.</p>
    </div></div>

    <section className="admin-section users-toolbar" aria-label="Tìm khách hàng">
      <form className="users-search" role="search" onSubmit={event => { event.preventDefault(); setApplied({ q: query.trim(), page: 1 }); }}>
        <label className="search-field"><Icon name="search" size={18}/><span className="sr-only">Tìm theo tên hoặc email</span>
          <input type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Tìm theo tên, email hoặc mã khách hàng"/></label>
      </form>
      <p className="users-count" role="status" aria-live="polite">{loading ? 'Đang tải…' : data ? (total === 0 ? 'Không có khách hàng' : `${num.format(from)}–${num.format(to)} trong ${num.format(total)} khách hàng`) : ''}</p>
    </section>

    {/* Fixed to the viewport: the Admin may have scrolled far down the list when the detail panel closes. */}
    <div className="users-toast-region" role="status" aria-live="polite">
      {deletedNotice && <div className="users-toast"><Icon name="check" size={18}/><span>{deletedNotice}</span>
        <button type="button" className="users-toast-close" aria-label="Ẩn thông báo" onClick={() => setDeletedNotice('')}>✕</button></div>}
    </div>
    {error && <div className="admin-alert admin-alert-error" role="alert"><Icon name="info" size={18}/><span>{error}</span>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => void load(applied.q, applied.page)} disabled={loading}>Thử lại</button></div>}

    {data && rows.length === 0 && !loading ? <section className="admin-section"><div className="empty-state compact">
      <Icon name="user" size={28}/>
      {applied.q ? <><h2>Không tìm thấy khách hàng</h2><p>Không có tên, email hoặc mã nào khớp “{applied.q}”.</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => { setQuery(''); setApplied({ q: '', page: 1 }); }}>Xóa tìm kiếm</button></>
        : <><h2>Chưa có khách hàng</h2><p>Khách hàng sẽ xuất hiện ở đây sau khi đăng ký tài khoản QLead.</p></>}
    </div></section> : rows.length > 0 && <section className={`users-table${loading ? ' is-loading' : ''}`} aria-label="Danh sách khách hàng" aria-busy={loading}>
      <div className="users-head" aria-hidden="true"><span>Khách hàng</span><span>Đăng ký</span><span>Nhu cầu</span><span>Lead</span><span>Quét gần nhất</span><span>Tìm lead</span><span/></div>
      <ul>{rows.map(row => {
        const scan = lastScanText(row);
        return <li key={row.id} className={`users-row is-${row.status}`}>
          <div className="users-who">
            <span className="avatar" aria-hidden="true">{row.displayName.trim().charAt(0).toUpperCase() || '?'}</span>
            <span><b>{row.displayName}</b><small>{row.email ?? 'Không có email đăng nhập'}</small>
              <small className="users-id" title={row.id}><span className="sr-only">Mã tài khoản </span>ID <code className="mono">{shortId(row.id)}</code></small></span>
          </div>
          <dl className="users-cells">
            <div><dt>Đăng ký</dt><dd>{dateFmt.format(new Date(row.createdAt))}</dd></div>
            <div><dt>Nhu cầu</dt><dd className={row.status === 'suspended' && row.activeProfileCount ? 'is-blocked' : undefined}>{profilesText(row)}</dd></div>
            <div><dt>Lead</dt><dd>{num.format(row.leadCount)}</dd></div>
            <div><dt>Quét gần nhất</dt><dd className={scan.tone ? `is-${scan.tone}` : undefined}>{scan.text}</dd></div>
            <div className="users-status"><dt>Tìm lead</dt><dd><StatusBadge status={row.status}/></dd></div>
          </dl>
          <button type="button" className="btn btn-outline btn-sm users-open" onClick={() => { setDeletedNotice(''); setOpenId(row.id); }} aria-label={`Xem chi tiết ${row.displayName} (ID ${shortId(row.id)})`}>Chi tiết</button>
        </li>;
      })}</ul>
    </section>}

    {data && total > USERS_PAGE_SIZE && <nav className="users-pager" aria-label="Phân trang">
      <button type="button" className="btn btn-outline btn-sm" disabled={loading || applied.page <= 1} onClick={() => setApplied(a => ({ ...a, page: a.page - 1 }))}><Icon name="back" size={16}/>Trang trước</button>
      <span>Trang {applied.page} / {pages}</span>
      <button type="button" className="btn btn-outline btn-sm" disabled={loading || applied.page >= pages} onClick={() => setApplied(a => ({ ...a, page: a.page + 1 }))}>Trang sau<Icon name="arrow" size={16}/></button>
    </nav>}

    {openId && <UserDetail userId={openId} currentAdminId={currentAdminId} onClose={() => setOpenId(null)} onChanged={onChanged} onDeleted={(name, id) => {
      setOpenId(null);
      setData(current => current && { ...current, users: current.users.filter(u => u.id !== id), total: Math.max(0, current.total - 1) });
      setDeletedNotice(`Đã xóa vĩnh viễn tài khoản ${name} (ID ${shortId(id)}).`);
      void load(applied.q, applied.page);
    }}/>}
  </div>;
}

type Notice = { kind: 'ok' | 'error'; text: string };

function UserDetail({ userId, currentAdminId, onClose, onChanged, onDeleted }: { userId: string; currentAdminId: string; onClose: () => void; onChanged: () => void; onDeleted: (name: string, id: string) => void }) {
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<null | 'suspended' | 'active'>(null);
  const [deleting, setDeleting] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const result = await call<AdminUserDetail>(`/api/admin/users/${userId}`, 'detail');
    if (!result.ok) { setError(result.error); return; }
    setError(''); setDetail(result.data);
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !confirm && !deleting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, deleting, onClose]);

  async function applied(change: MonitoringChange, name: string) {
    setConfirm(null);
    if (change.status === 'suspended') {
      const inFlight = change.inFlightJobCount > 0 ? ` ${change.inFlightJobCount} lượt tìm đã được giao trước đó có thể vẫn hoàn tất và lưu kết quả.` : '';
      setNotice({ kind: 'ok', text: change.changed ? `Đã ngưng tìm lead cho ${name} lúc ${at(change.changedAt)}.${inFlight}` : `Tài khoản này đã ở trạng thái ngưng từ trước. Không có gì thay đổi.${inFlight}` });
    } else {
      setNotice({ kind: 'ok', text: change.changed ? `Đã kích hoạt lại tìm lead cho ${name} lúc ${at(change.changedAt)}. Nhu cầu đang bật sẽ quét ở lượt theo lịch tiếp theo.` : 'Tài khoản này vốn đang tìm lead. Không có gì thay đổi.' });
    }
    await load();
    onChanged();
  }

  const d = detail;
  const profiles = d?.profiles.filter(p => p.profileStatus === 'active') ?? [];
  const removed = (d?.profiles.length ?? 0) - profiles.length;
  const enabled = profiles.filter(p => p.enabled).length;

  return <div className="modal-backdrop user-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !confirm && !deleting) onClose(); }}>
    <div className="modal user-drawer" role="dialog" aria-modal="true" aria-labelledby="user-detail-title">
      <div className="modal-head">
        <h2 id="user-detail-title" ref={heading} tabIndex={-1}>{d ? d.displayName : 'Chi tiết khách hàng'}</h2>
        <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        {error && <div className="admin-alert admin-alert-error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>Thử lại</button></div>}
        {!d && !error && <p className="muted-text" role="status">Đang tải thông tin khách hàng…</p>}
        {d && <>
          <div className="user-identity">
            <p className="user-email">{d.email ?? 'Không có email đăng nhập · tài khoản không đăng ký bằng email'}</p>
            <CopyId id={d.id}/>
            <p className="user-meta">Đăng ký {at(d.createdAt)} · {profiles.length} nhu cầu · {num.format(d.leadCount)} lead</p>
          </div>

          <section className={`mon-card is-${d.status}`} aria-labelledby="mon-title">
            <div className="mon-card-head">
              <div><p className="mon-kicker" id="mon-title">Tìm lead của tài khoản</p><StatusBadge status={d.status}/></div>
              {d.status === 'active'
                ? <button type="button" className="btn btn-danger-outline" onClick={() => { setNotice(null); setConfirm('suspended'); }}>Ngưng tìm lead</button>
                : <button type="button" className="btn btn-primary" onClick={() => { setNotice(null); setConfirm('active'); }}>Kích hoạt lại</button>}
            </div>
            <p className="mon-explain">{d.status === 'active'
              ? (enabled ? `QLead đang quét theo lịch cho ${enabled} nhu cầu đang bật.` : 'Tài khoản được phép tìm lead, nhưng khách chưa bật nhu cầu nào.')
              : `Không tạo lượt tìm Facebook mới cho tài khoản này${profiles.length ? `. Cả ${profiles.length} nhu cầu đều không được quét mới` : ''}. Lead và ghi chú cũ vẫn còn.`}</p>
            <dl className="mon-facts">
              {d.status === 'suspended' && <div><dt>Ngưng lúc</dt><dd>{at(d.suspendedAt)}{d.suspendedByName ? ` · bởi ${d.suspendedByName}` : ''}</dd></div>}
              {d.status === 'suspended' && <div><dt>Lý do</dt><dd>{d.reason || <span className="muted-text">Không ghi lý do</span>}</dd></div>}
              {d.status === 'active' && d.suspendedAt && <div><dt>Lần ngưng gần nhất</dt><dd>{at(d.suspendedAt)}{d.suspendedByName ? ` · bởi ${d.suspendedByName}` : ''}{d.reason ? ` · “${d.reason}”` : ''}</dd></div>}
              {d.status === 'active' && d.suspendedAt && <div><dt>Kích hoạt lại lúc</dt><dd>{at(d.changedAt)}{d.changedByName ? ` · bởi ${d.changedByName}` : ''}</dd></div>}
              <div><dt>Đăng nhập</dt><dd><Icon name="lock" size={14}/> Vẫn đăng nhập được <small>Ngưng tìm lead không khóa tài khoản.</small></dd></div>
            </dl>
          </section>
          {notice && <div className={`admin-alert admin-alert-${notice.kind === 'ok' ? 'ok' : 'error'}`} role={notice.kind === 'ok' ? 'status' : 'alert'}><Icon name={notice.kind === 'ok' ? 'check' : 'info'} size={18}/><span>{notice.text}</span></div>}

          <dl className="stat-grid user-stats">
            <div><dt>Nhu cầu</dt><dd>{profiles.length}</dd></div>
            <div><dt>Lead đã lưu</dt><dd>{num.format(d.leadCount)}</dd></div>
            <div><dt>Lượt quét</dt><dd>{num.format(d.scanCount)}</dd></div>
            <div><dt>Chờ / đang chạy</dt><dd>{d.pendingJobCount} / {d.claimedJobCount}</dd></div>
          </dl>
          {d.status === 'suspended' && d.pendingJobCount > 0 && <p className="muted-text small">Lượt đang chờ được giữ lại nhưng không được giao xử lý trong lúc ngưng.</p>}

          <section aria-labelledby="profiles-title">
            <h3 className="sub-h" id="profiles-title">Nhu cầu theo dõi</h3>
            {d.status === 'suspended' && profiles.length > 0 && <p className="info-box warn"><Icon name="info" size={16}/><span>Cả {profiles.length} nhu cầu dưới đây đang bị loại khỏi lượt quét mới vì tài khoản ngưng tìm lead. Cài đặt bật/tạm dừng của khách được giữ nguyên.</span></p>}
            {profiles.length === 0 ? <p className="muted-text">Khách chưa tạo nhu cầu nào.</p> : <ul className="user-profiles">{profiles.map(p => {
              const effect = profileEffect(p, d.status);
              return <li key={p.id}>
                <div className="user-profile-top"><b>{p.name}</b><span className={`pill prof-pill is-${effect.tone}`}>{effect.label}</span></div>
                {p.description && <p className="user-profile-desc">“{p.description}”</p>}
                <p className="user-profile-meta">{p.enabled ? 'Khách bật' : 'Khách tạm dừng'} · {frequencyText(p.frequencyMinutes)} · {num.format(p.leadCount)} lead · quét gần nhất {at(p.lastScanAt)}</p>
                <p className="user-profile-note">{effect.note}</p>
              </li>;
            })}</ul>}
            {removed > 0 && <p className="muted-text small">Ngoài ra có {removed} nhu cầu khách đã xóa.</p>}
          </section>

          <section aria-labelledby="account-title">
            <h3 className="sub-h" id="account-title">Tài khoản</h3>
            <dl className="mon-facts">
              <div><dt>Đăng ký lúc</dt><dd>{at(d.createdAt)}</dd></div>
              <div><dt>Quét gần nhất</dt><dd>{lastScanText(d).text}</dd></div>
            </dl>
          </section>
          <section className="danger-zone" aria-labelledby="delete-account-title">
            <div>
              <h3 id="delete-account-title">Xóa tài khoản</h3>
              <p>{d.id === currentAdminId ? 'Bạn đang đăng nhập bằng tài khoản này nên không thể tự xóa.' : 'Gỡ bỏ vĩnh viễn tài khoản và dữ liệu của khách. Muốn giữ dữ liệu thì dùng Ngưng tìm lead.'}</p>
            </div>
            {d.id !== currentAdminId && <button type="button" className="btn btn-sm btn-quiet-danger" onClick={() => { setNotice(null); setDeleting(true); }}>Xóa tài khoản…</button>}
          </section>
        </>}
      </div>
    </div>
    {confirm && d && <ConfirmChange user={d} target={confirm} profileCount={profiles.length} onCancel={() => setConfirm(null)} onDone={change => void applied(change, d.displayName)}/>}
    {deleting && d && <DeleteAccountDialog user={d} onCancel={() => setDeleting(false)} onDeleted={() => onDeleted(d.displayName, d.id)} onGone={() => { setDeleting(false); onChanged(); void load(); }}/>}
  </div>;
}

type ImpactItem = { label: string; count: number };

/** What a customer would actually miss, in the order an Admin cares about. Zero counts are left out. */
function customerData(i: UserDeletionImpact): ImpactItem[] {
  return [
    { label: 'lead', count: i.customerLeadCount },
    { label: 'nhu cầu theo dõi', count: i.profileCount },
    { label: 'lượt quét', count: i.scanCount },
    { label: 'ghi chú', count: i.noteCount },
    { label: 'trạng thái lead', count: i.leadStatusCount },
    { label: 'đề xuất nhóm', count: i.groupRequestCount },
  ].filter(item => item.count > 0);
}

/** Every non-zero record the backend reported, for the collapsed details. */
function allRecords(i: UserDeletionImpact): ImpactItem[] {
  return [
    { label: 'Lead đã tìm thấy', count: i.customerLeadCount },
    { label: 'Nhu cầu theo dõi', count: i.profileCount },
    { label: 'Phiên bản điều kiện tìm', count: i.searchConfigCount },
    { label: 'Lượt quét đã ghi', count: i.scanCount },
    { label: 'Lượt tìm đã xếp lịch', count: i.jobCount },
    { label: 'Lần chạy lượt tìm', count: i.attemptCount },
    { label: 'Trạng thái lead', count: i.leadStatusCount },
    { label: 'Ghi chú', count: i.noteCount },
    { label: 'Đề xuất nhóm Facebook', count: i.groupRequestCount },
    { label: 'Thông tin đăng nhập email', count: i.loginCredentialCount },
    { label: 'Phiên đăng nhập', count: i.sessionCount },
    { label: 'Kết nối dữ liệu cũ', count: i.legacyConnectionCount },
    { label: 'Mã kết nối cũ', count: i.museCredentialCount },
  ].filter(item => item.count > 0);
}

/**
 * Permanent deletion, one compact dialog: who, what they would lose, one irreversibility line, type XÓA, confirm.
 * Counts come only from the server preview and the result is only shown after the server confirms.
 */
function DeleteAccountDialog({ user, onCancel, onDeleted, onGone }: { user: AdminUserDetail; onCancel: () => void; onDeleted: () => void; onGone: () => void }) {
  const [impact, setImpact] = useState<UserDeletionImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [gone, setGone] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const blocked = Boolean(impact?.activeJobs.length);
  const ready = Boolean(impact) && !blocked && !gone && !loading && typedDeleteWord(typed);
  const close = gone ? onGone : onCancel;
  const data = impact ? customerData(impact) : [];
  const records = impact ? allRecords(impact) : [];

  const preview = useCallback(async () => {
    setLoading(true); setLoadError('');
    const result = await call<UserDeletionImpact>(`/api/admin/users/${user.id}/deletion`, 'deletion');
    setLoading(false);
    if (result.ok) { setImpact(result.data); return; }
    if (result.status === 404) setGone(true);
    setLoadError(result.error);
  }, [user.id]);
  useEffect(() => { void preview(); }, [preview]);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, close]);

  async function submit() {
    if (!ready || busy) return;
    setBusy(true); setError('');
    const result = await call<{ deleted: boolean; impact: UserDeletionImpact }>(`/api/admin/users/${user.id}/deletion`, 'deletion', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ confirmUserId: user.id }),
    });
    if (result.ok && result.data.deleted === true) { onDeleted(); return; }
    setBusy(false);
    if (result.ok) { setError('Máy chủ chưa xác nhận đã xóa. Tải lại trang để xem trạng thái hiện tại.'); return; }
    if (result.code === 'active_jobs' && result.body?.impact) { setImpact(result.body.impact as UserDeletionImpact); return; }
    if (result.status === 404) setGone(true);
    setError(result.error);
  }

  return <div className="modal-backdrop confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div className="modal del-modal" role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-summary">
      <div className="del-body">
        <h2 id="del-title">Xóa tài khoản khách hàng?</h2>

        <div className="del-who">
          <span className="avatar" aria-hidden="true">{user.displayName.trim().charAt(0).toUpperCase() || '?'}</span>
          <div>
            <b>{user.displayName}</b>
            <span>{user.email ?? 'Không có email đăng nhập'} · đăng ký {dateFmt.format(new Date(user.createdAt))}</span>
            <span className="del-id">ID <code className="mono">{user.id}</code></span>
          </div>
        </div>

        <div className="del-summary" id="del-summary" aria-live="polite" aria-busy={loading}>
          {loading && <p className="del-loading"><i aria-hidden="true"/>Đang kiểm tra dữ liệu của tài khoản…</p>}
          {!loading && loadError && <p className="del-note is-error" role="alert"><Icon name="info" size={16}/><span>{loadError}</span>
            {!gone && <button type="button" className="text-link" onClick={() => void preview()}>Thử lại</button>}</p>}
          {!loading && impact && (data.length === 0
            ? <p className="del-empty"><Icon name="check" size={16}/><span>Tài khoản chưa có dữ liệu: không có nhu cầu, lead, ghi chú hay lịch sử quét.</span></p>
            : <>
              <p className="del-lead">Dữ liệu sẽ mất vĩnh viễn</p>
              <ul className="del-counts">{data.map(item => <li key={item.label}><b>{num.format(item.count)}</b> {item.label}</li>)}</ul>
            </>)}
          {!loading && impact && records.length > 0 && <details className="del-details">
            <summary>Xem chi tiết {records.length} loại dữ liệu</summary>
            <dl>{records.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{num.format(item.count)}</dd></div>)}</dl>
            <p>Tài khoản tìm kiếm dùng chung và dữ liệu của khách khác không bị ảnh hưởng.</p>
          </details>}
        </div>

        {blocked && impact && <div className="del-note is-warn" role="alert">
          <Icon name="clock" size={16}/>
          <div>
            <p><b>Chưa thể xóa lúc này.</b> Khách đang có lượt tìm chạy dở: {impact.activeJobs.map(job => `${job.profileName} (dự kiến xong trước ${timeOnly(job.leaseExpiresAt)})`).join(', ')}. Chưa có gì bị xóa.</p>
            <button type="button" className="text-link" onClick={() => void preview()} disabled={loading || busy}>Kiểm tra lại</button>
          </div>
        </div>}
        {error && <p className="del-note is-error" role="alert"><Icon name="info" size={16}/><span>{error}</span></p>}
      </div>

      <div className="del-foot">
        <p className="del-irreversible">Không thể hoàn tác. Khách bị đăng xuất ngay. Muốn giữ dữ liệu thì dùng <b>Ngưng tìm lead</b>.</p>
        <label className="del-confirm" htmlFor="del-word">Gõ <b>{DELETE_WORD}</b> để xác nhận</label>
        <div className="del-row">
          <input id="del-word" autoComplete="off" spellCheck={false} value={typed} onChange={event => setTyped(event.target.value)} disabled={busy || gone || blocked || !impact}
            onKeyDown={event => { if (event.key === 'Enter') void submit(); }} placeholder={DELETE_WORD}/>
          <div className="del-actions">
            <button type="button" ref={cancelRef} className="btn btn-ghost" onClick={close} disabled={busy}>{gone ? 'Đóng' : 'Hủy'}</button>
            <button type="button" className="btn btn-danger" onClick={() => void submit()} disabled={!ready || busy} aria-busy={busy}>{busy ? 'Đang xóa…' : 'Xóa vĩnh viễn'}</button>
          </div>
        </div>
      </div>
    </div>
  </div>;
}

function ConfirmChange({ user, target, profileCount, onCancel, onDone }: { user: AdminUserDetail; target: 'suspended' | 'active'; profileCount: number; onCancel: () => void; onDone: (change: MonitoringChange) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const suspend = target === 'suspended';
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function submit() {
    setBusy(true); setError('');
    const body = suspend ? { status: 'suspended', reason: reason.trim() || null } : { status: 'active' };
    const result = await call<MonitoringChange>(`/api/admin/users/${user.id}/monitoring`, 'change', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify(body),
    });
    if (!result.ok) { setBusy(false); setError(result.error); return; }
    if (result.data.status !== target) { setBusy(false); setError('Máy chủ chưa xác nhận thay đổi. Tải lại để xem trạng thái hiện tại.'); return; }
    onDone(result.data);
  }

  return <div className="modal-backdrop confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
      <div className="modal-head"><h2 id="confirm-title">{suspend ? 'Ngưng tìm lead cho khách hàng này?' : 'Kích hoạt lại tìm lead?'}</h2></div>
      <div className="modal-body">
        <p className="confirm-who"><b>{user.displayName}</b>{user.email && <small>{user.email}</small>}</p>
        <ul className="confirm-points" id="confirm-desc">{suspend ? <>
          <li className="is-stop"><Icon name="info" size={16}/><span>QLead dừng tạo lượt tìm Facebook mới cho khách này{profileCount ? `, áp dụng cho cả ${profileCount} nhu cầu` : ''}.</span></li>
          <li><Icon name="check" size={16}/><span>Lead, ghi chú và lịch sử quét cũ vẫn còn nguyên, khách vẫn xem được.</span></li>
          <li><Icon name="check" size={16}/><span>Khách vẫn đăng nhập bình thường và thấy thông báo tìm lead đang tạm dừng.</span></li>
          <li><Icon name="clock" size={16}/><span>Lượt tìm đã được giao trước đó{user.claimedJobCount ? ` (hiện có ${user.claimedJobCount})` : ''} có thể vẫn chạy xong và lưu kết quả.</span></li>
          <li><Icon name="check" size={16}/><span>Bạn có thể kích hoạt lại bất cứ lúc nào. Cài đặt bật/tạm dừng của từng nhu cầu được giữ nguyên.</span></li>
        </> : <>
          <li><Icon name="check" size={16}/><span>Các nhu cầu khách đang bật sẽ được quét lại ở lượt theo lịch tiếp theo.</span></li>
          <li><Icon name="clock" size={16}/><span>Lượt bị bỏ lỡ trong lúc ngưng không được chạy bù.</span></li>
          <li><Icon name="check" size={16}/><span>Nhu cầu khách tự tạm dừng vẫn giữ tạm dừng.</span></li>
        </>}</ul>
        {suspend && <label className="field">Lý do <span className="field-optional">(không bắt buộc, chỉ quản trị viên thấy)</span>
          <textarea rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} placeholder="Ví dụ: Khách yêu cầu tạm ngưng, hết hạn dùng thử"/></label>}
        {error && <div className="admin-alert admin-alert-error" role="alert"><Icon name="info" size={18}/><span>{error}</span></div>}
        <div className="modal-actions">
          <button type="button" ref={cancelRef} className="btn btn-ghost" onClick={onCancel} disabled={busy}>Hủy</button>
          <button type="button" className={`btn ${suspend ? 'btn-danger' : 'btn-primary'}`} onClick={() => void submit()} disabled={busy} aria-busy={busy}>
            {busy ? (suspend ? 'Đang ngưng…' : 'Đang kích hoạt…') : suspend ? 'Ngưng tìm lead' : 'Kích hoạt lại'}</button>
        </div>
      </div>
    </div>
  </div>;
}
