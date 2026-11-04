'use client';

import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { copyText, displayArea, exactTime, isRecent, readLead, relativeTime, sourceLabel, type LeadReading } from '@/lib/lead-format';
import { LEAD_STATUSES, statusLabel, type LeadStatus, type WorkflowMap } from '@/lib/lead-workflow';
import { useLeadWorkflow, useNow, type LeadWorkflowApi } from '@/lib/lead-state';
import { LEGACY_FILTER, LEGACY_SOURCE_LABEL, matchesSourceFilter, sourceName, type Lead } from '@/lib/lead-source';
import { compareLeadByPostedAt, type LeadDateOrder } from '@/lib/lead-order';
import { AppShell } from './app-shell';
import { Icon } from './visuals';
import { GoatMascot } from './goat-mascot';

const DESKTOP_QUERY = '(min-width: 1080px)';
const PAGE_SIZE = 50;

export function leadHref(id: string) { return `/app/bai-viet/${encodeURIComponent(id)}`; }

function useCopyStatus() {
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 2400);
    return () => window.clearTimeout(timer);
  }, [status]);
  async function copy(value: string, label: string) {
    setStatus(await copyText(value) ? `Đã sao chép ${label}.` : 'Trình duyệt chưa cho phép sao chép.');
  }
  return { status, copy };
}

/** Business signals the post mentions (opening, hiring, new branch…). */
export function ReadingTags({ reading, limit = 3 }: { reading: LeadReading; limit?: number }) {
  if (!reading.signals.length) return null;
  return <ul className="signal-chips" aria-label="Tín hiệu trong bài">
    {reading.signals.slice(0, limit).map(signal => <li key={signal}>{signal}</li>)}
  </ul>;
}

/** Which saved search found the lead; older integrations get an explicit "previous scans" label instead. */
export function SourceLine({ lead }: { lead: Lead }) {
  const [first, ...rest] = lead.sources;
  if (!first) return null;
  return <span className={`lead-source ${first.kind === 'legacy' ? 'is-legacy' : ''}`}><Icon name="target" size={14}/>{sourceName(first)}{rest.length > 0 && <> · +{rest.length} nhu cầu</>}</span>;
}

export function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`status-pill is-${status}`}>{statusLabel[status]}</span>;
}

/** Compact lead row used on the Today page and on mobile. Links to the detail page. */
export function LeadListItem({ lead, now, workflow }: { lead: Lead; now: number; workflow: LeadWorkflowApi }) {
  const state = workflow.get(lead.id);
  const area = displayArea(lead);
  const reading = readLead(lead.content, lead.need);
  return <li className={`lead-item ${state.status === 'new' ? 'is-unseen' : ''}`}>
    <Link href={leadHref(lead.id)}>
      <div className="lead-item-top">
        <StatusPill status={state.status}/>
        <span className="lead-item-author">{lead.author ?? 'Chưa rõ người đăng'}</span>
        {lead.published_at ? <time dateTime={lead.published_at} title={`Đăng lúc ${exactTime(lead.published_at)}`}>{relativeTime(lead.published_at, now)}</time> : <span className="muted-text">Chưa rõ giờ đăng</span>}
      </div>
      <p className="lead-item-need">{reading.evidence}</p>
      <div className="lead-item-meta">
        <span className={area ? '' : 'muted-text'}><Icon name="pin" size={15}/>{area ?? 'Chưa rõ khu vực'}</span>
        {lead.contact && <span className="has-contact"><Icon name="phone" size={15}/>{lead.contact.number}</span>}
        {state.notes.length > 0 && <span className="note-count"><Icon name="list" size={14}/>{state.notes.length} ghi chú</span>}
      </div>
      <SourceLine lead={lead}/>
    </Link>
  </li>;
}

/** Status picker + notes: what the salesperson has done with this lead. */
function LeadFollowUp({ lead, now, workflow }: { lead: Lead; now: number; workflow: LeadWorkflowApi }) {
  const state = workflow.get(lead.id);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    if (await workflow.addNote(lead.id, body)) setDraft('');
    setSaving(false);
  }
  return <section className="follow-up" aria-label="Xử lý lead">
    <div className="status-picker" role="radiogroup" aria-label="Trạng thái lead">
      {LEAD_STATUSES.filter(status => status !== 'new').map(status => <button key={status} type="button" role="radio" aria-checked={state.status === status}
        className={`status-option is-${status}`} onClick={() => workflow.setStatus(lead.id, status)}>{statusLabel[status]}</button>)}
    </div>
    {state.updatedAt && state.status !== 'new' && <p className="status-updated">Cập nhật {relativeTime(state.updatedAt, now)}</p>}
    <form className="note-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={`note-${lead.id}`}>Ghi chú</label>
      <textarea id={`note-${lead.id}`} rows={2} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ghi chú: đã gọi, hẹn gọi lại, khách đang dùng phần mềm khác…"
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit(); }}/>
      <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !draft.trim()}>{saving ? 'Đang lưu…' : 'Thêm ghi chú'}</button>
    </form>
    {state.notes.length > 0 && <ol className="note-list">{state.notes.map(note => <li key={note.id}>
      <p>{note.body}</p>
      <span><time dateTime={note.createdAt} title={exactTime(note.createdAt)}>{relativeTime(note.createdAt, now)}</time>
        <button type="button" onClick={() => workflow.deleteNote(lead.id, note.id)} aria-label="Xóa ghi chú">Xóa</button></span>
    </li>)}</ol>}
    {workflow.error && <p className="warning-line" role="alert">{workflow.error} <button type="button" className="text-link" onClick={workflow.clearError}>Đóng</button></p>}
  </section>;
}

export function LeadDetail({ lead, now, workflow, headingLevel = 2 }: { lead: Lead; now: number; workflow: LeadWorkflowApi; headingLevel?: 1 | 2 }) {
  const { status, copy } = useCopyStatus();
  const area = displayArea(lead);
  const source = sourceLabel(lead);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const reading = readLead(lead.content, lead.need);

  // Two columns: the post on the left, what the salesperson did with it on the right.
  return <article className="lead-detail" aria-label={`Lead của ${lead.author ?? 'người đăng chưa rõ'}`}>
    <div className="lead-detail-main">
      <header className="lead-detail-head">
        <Heading className="lead-detail-author">{lead.author}</Heading>
        <p className="lead-detail-sub">{source && <>{source} · </>}{lead.published_at && <time dateTime={lead.published_at} title={exactTime(lead.published_at)}>Đăng {relativeTime(lead.published_at, now)}</time>}</p>
        <ReadingTags reading={reading} limit={4}/>
      </header>

      <blockquote className="lead-post-body">{lead.content}</blockquote>

      <dl className="lead-facts">
        <div><dt><Icon name="phone" size={16}/>Số liên hệ</dt><dd>{lead.contact ? <span className="contact-line"><a href={`tel:${lead.contact.normalized}`}>{lead.contact.number}</a><button type="button" className="icon-btn" onClick={() => copy(lead.contact!.number, 'số liên hệ')} aria-label="Sao chép số liên hệ"><Icon name="copy" size={16}/></button></span> : <span className="muted-text">Bài không ghi số</span>}</dd></div>
        <div><dt><Icon name="pin" size={16}/>Khu vực</dt><dd>{area ?? <span className="muted-text">Bài không nêu</span>}</dd></div>
        <div><dt><Icon name="clock" size={16}/>Đăng lúc</dt><dd>{lead.published_at ? exactTime(lead.published_at) : 'Chưa rõ giờ đăng'}</dd></div>
        <div><dt><Icon name="radar" size={16}/>Được phát hiện</dt><dd>{lead.discovered_at ? exactTime(lead.discovered_at) : '—'}</dd></div>
      </dl>

      <section className="lead-provenance" aria-labelledby={`provenance-${lead.id}`}>
        <h3 id={`provenance-${lead.id}`}>Được tìm thấy qua</h3>
        <ul>{lead.sources.map((item, index) => <li key={index}>
          {item.kind === 'profile'
            ? <><Link href={`/app/bai-viet?nhu-cau=${item.profileId}`}><b>{item.profileName}</b></Link>
              <span>{item.keywords.length ? <>Điều kiện lúc tìm thấy: {item.keywords.join(', ')}{item.location ? ` · ${item.location}` : ''}</> : 'Không ghi nhận điều kiện lúc tìm thấy'}{item.discoveredAt ? ` · ${exactTime(item.discoveredAt)}` : ''}</span></>
            : <><b>{LEGACY_SOURCE_LABEL}</b><span>Lượt quét này không ghi nhận nhu cầu tìm kiếm cụ thể.{item.discoveredAt ? ` · ${exactTime(item.discoveredAt)}` : ''}</span></>}
        </li>)}</ul>
      </section>

      <div className="lead-actions">
        {lead.original_url
          ? <a className="btn btn-primary" href={lead.original_url} target="_blank" rel="noopener noreferrer">Mở bài Facebook <Icon name="external" size={16}/></a>
          : <span className="no-link-note"><Icon name="info" size={16}/>Chưa có liên kết bài Facebook</span>}
        {lead.original_url && <button type="button" className="btn btn-outline" onClick={() => copy(lead.original_url!, 'liên kết bài viết')}><Icon name="copy" size={16}/>Sao chép liên kết</button>}
      </div>
      {status && <p className="toast" role="status">{status}</p>}
    </div>

    <aside className="lead-detail-side">
      <LeadFollowUp lead={lead} now={now} workflow={workflow}/>
    </aside>
  </article>;
}

type DateRange = 'all' | '24h' | '7d';
type StatusFilter = 'all' | LeadStatus;

export type ProfileOption = { id: string; name: string };

export function LeadResultsPage({ records, workflow: initialWorkflow, profiles, initialSource = 'all', notice }: { records: Lead[]; workflow: WorkflowMap; profiles: ProfileOption[]; initialSource?: string; notice?: ReactNode }) {
  const now = useNow();
  const router = useRouter();
  const workflow = useLeadWorkflow(initialWorkflow);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<DateRange>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [onlyContact, setOnlyContact] = useState(false);
  const [onlyNotes, setOnlyNotes] = useState(false);
  const [dateOrder, setDateOrder] = useState<LeadDateOrder>('newest');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const hasLegacy = useMemo(() => records.some(lead => lead.sources.some(source => source.kind === 'legacy')), [records]);
  const sourceOptions = useMemo(() => [...profiles, ...(hasLegacy ? [{ id: LEGACY_FILTER, name: LEGACY_SOURCE_LABEL }] : [])], [profiles, hasLegacy]);
  const [source, setSource] = useState(sourceOptions.some(option => option.id === initialSource) ? initialSource : 'all');
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const result: Record<StatusFilter, number> = { all: records.length, new: 0, seen: 0, contacted: 0, interested: 0, not_fit: 0 };
    for (const lead of records) result[workflow.get(lead.id).status] += 1;
    return result;
  }, [records, workflow]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('vi');
    const windowMs = range === '24h' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 0;
    return records.filter(lead => {
      const state = workflow.get(lead.id);
      const text = `${lead.author ?? ''} ${lead.content} ${displayArea(lead) ?? ''} ${lead.contact?.number ?? ''} ${state.notes.map(note => note.body).join(' ')}`.toLocaleLowerCase('vi');
      return (!needle || text.includes(needle))
        && (!windowMs || isRecent(lead.published_at, now, windowMs))
        && (statusFilter === 'all' || state.status === statusFilter)
        && (!onlyContact || Boolean(lead.contact))
        && (!onlyNotes || state.notes.length > 0)
        && matchesSourceFilter(lead, source);
    }).sort((a, b) => compareLeadByPostedAt(a, b, dateOrder));
  }, [records, now, query, range, statusFilter, onlyContact, onlyNotes, source, workflow, dateOrder]);
  const visible = filtered.slice(0, visibleCount);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [query, range, statusFilter, onlyContact, onlyNotes, source, dateOrder]);

  const open = records.find(lead => lead.id === openId) ?? null;
  useEffect(() => {
    if (!openId) return;
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpenId(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [openId]);

  function openLead(id: string) {
    workflow.markSeen(id);
    if (window.matchMedia(DESKTOP_QUERY).matches) setOpenId(id); else router.push(leadHref(id));
  }
  const activeFilters = Number(Boolean(query)) + Number(range !== 'all') + Number(statusFilter !== 'all') + Number(onlyContact) + Number(onlyNotes) + Number(source !== 'all');
  function reset() { setQuery(''); setRange('all'); setStatusFilter('all'); setOnlyContact(false); setOnlyNotes(false); setSource('all'); }

  return <AppShell active="Danh sách lead">
    <div className="page-head">
      <div><h1>Danh sách lead</h1><p>{records.length} lead · <b>{counts.new} chưa xem</b> · sắp xếp theo thời gian đăng Facebook</p></div>
      <Link href="/app/bo-loc" className="btn btn-outline hide-mobile"><Icon name="target" size={16}/>Sửa nhu cầu theo dõi</Link>
    </div>
    {notice}

    <div className="status-tabs" role="tablist" aria-label="Lọc theo trạng thái">
      {(['all', ...LEAD_STATUSES] as StatusFilter[]).map(status => <button key={status} type="button" role="tab" aria-selected={statusFilter === status} onClick={() => setStatusFilter(status)}>
        {status === 'all' ? 'Tất cả' : statusLabel[status]}<span>{counts[status]}</span>
      </button>)}
    </div>

    <section className="filter-bar" aria-label="Lọc lead">
      <label className="search-field"><Icon name="search" size={18}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm theo nội dung, người đăng, số điện thoại, ghi chú" aria-label="Tìm lead"/></label>
      {sourceOptions.length > 0 && <label className="select-field"><span className="sr-only">Nhu cầu tìm kiếm</span><select value={source} onChange={event => setSource(event.target.value)} aria-label="Lọc theo nhu cầu"><option value="all">Mọi nhu cầu</option>{sourceOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
      <label className="select-field"><span className="sr-only">Thời gian đăng</span><select value={range} onChange={event => setRange(event.target.value as DateRange)}><option value="all">Mọi thời gian</option><option value="24h">Đăng trong 24 giờ</option><option value="7d">Đăng trong 7 ngày</option></select></label>
      <label className="select-field"><span className="sr-only">Sắp xếp lead</span><select value={dateOrder} onChange={event => setDateOrder(event.target.value as LeadDateOrder)} aria-label="Sắp xếp lead"><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option></select></label>
      <div className="toggle-chips" role="group" aria-label="Lọc nhanh">
        <button type="button" aria-pressed={onlyContact} onClick={() => setOnlyContact(value => !value)}>Có số liên hệ</button>
        <button type="button" aria-pressed={onlyNotes} onClick={() => setOnlyNotes(value => !value)}>Có ghi chú</button>
        {activeFilters > 0 && <button type="button" className="clear-chip" onClick={reset}>Xóa lọc ({activeFilters})</button>}
      </div>
    </section>

    {filtered.length === 0
      ? <div className="panel empty-state"><GoatMascot size="sm"/><h2>{records.length ? 'Không có lead khớp bộ lọc' : 'Chưa có lead nào'}</h2><p>{records.length ? 'Thử bỏ bớt điều kiện lọc.' : 'Khi QLead tìm thấy bài phù hợp với nhu cầu theo dõi, lead sẽ xuất hiện tại đây.'}</p>{records.length ? <button className="btn btn-outline" type="button" onClick={reset}>Xóa bộ lọc</button> : <Link className="btn btn-primary" href="/app/bo-loc">Thiết lập nhu cầu theo dõi</Link>}</div>
      : <>
        <div className="lead-table-wrap panel">
          <table className="lead-table">
            <thead><tr><th>Trạng thái</th><th>Lead</th><th>Khu vực</th><th>Số liên hệ</th><th>Đăng lúc</th><th>Ghi chú</th></tr></thead>
            <tbody>{visible.map(lead => {
              const state = workflow.get(lead.id);
              const reading = readLead(lead.content, lead.need);
              const area = displayArea(lead);
              return <tr key={lead.id} data-id={lead.id} className={`${state.status === 'new' ? 'is-new' : ''} ${openId === lead.id ? 'is-open' : ''}`} tabIndex={0} aria-label={`Mở lead của ${lead.author ?? 'người đăng chưa rõ'}`}
                onClick={() => openLead(lead.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLead(lead.id); } }}>
                <td><StatusPill status={state.status}/></td>
                <td className="lead-cell"><b>{lead.author ?? 'Chưa rõ người đăng'}</b><p>{reading.evidence}</p><ReadingTags reading={reading} limit={2}/><SourceLine lead={lead}/></td>
                <td className={area ? '' : 'muted-text'}>{area ?? '—'}</td>
                <td>{lead.contact ? <span className="has-contact">{lead.contact.number}</span> : <span className="muted-text">—</span>}</td>
                <td>{lead.published_at ? <time dateTime={lead.published_at} title={exactTime(lead.published_at)}>{relativeTime(lead.published_at, now)}</time> : <span className="muted-text">Chưa rõ giờ đăng</span>}</td>
                <td className="note-cell">{state.notes[0] ? <><span className="note-count">{state.notes.length}</span><span className="note-preview">{state.notes[0].body}</span></> : <span className="muted-text">—</span>}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <ul className="lead-list lead-cards panel">{visible.map(lead => <LeadListItem key={lead.id} lead={lead} now={now} workflow={workflow}/>)}</ul>
        {visible.length < filtered.length && <div className="lead-load-more"><p>Đang hiển thị {visible.length}/{filtered.length} lead phù hợp</p><button className="btn btn-outline" type="button" onClick={() => setVisibleCount(count => Math.min(count + PAGE_SIZE, filtered.length))}>Tải thêm {Math.min(PAGE_SIZE, filtered.length - visible.length)} lead</button></div>}
      </>}

    {open && <>
      <div className="drawer-backdrop" onClick={() => setOpenId(null)}/>
      <aside className="lead-drawer" role="dialog" aria-modal="true" aria-label="Chi tiết lead">
        <button type="button" className="drawer-close icon-btn" onClick={() => setOpenId(null)} aria-label="Đóng"><Icon name="back" size={16}/></button>
        <LeadDetail key={open.id} lead={open} now={now} workflow={workflow}/>
      </aside>
    </>}
  </AppShell>;
}

export function LeadDetailPage({ lead, workflow: initialWorkflow }: { lead: Lead; workflow: WorkflowMap }) {
  const now = useNow();
  const workflow = useLeadWorkflow(initialWorkflow);
  useEffect(() => { workflow.markSeen(lead.id); }, [lead.id]);

  return <AppShell active="Danh sách lead">
    <Link className="back-link" href="/app/bai-viet"><Icon name="back" size={16}/>Danh sách lead</Link>
    <div className="lead-detail-page"><LeadDetail lead={lead} now={now} workflow={workflow} headingLevel={1}/></div>
  </AppShell>;
}
