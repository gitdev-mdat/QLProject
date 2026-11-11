'use client';

import { useEffect, useMemo, useOptimistic, useState, useTransition, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { copyText, displayArea, exactTime, isRecent, leadName, readLead, relativeTime, sourceLabel, type LeadReading } from '@/lib/lead-format';
import { leadSearchText, leadText, looksEnglish } from '@/lib/lead-text';
import { CUSTOMER_STATUSES, statusHint, statusLabel, type LeadStatus, type WorkflowMap } from '@/lib/lead-workflow';
import { activeHot, hotLeads } from '@/lib/hot-lead';
import { HotCallout, HotLeadBand, HotTag } from './hot-lead';
import { useLeadWorkflow, useNow, type LeadWorkflowApi } from '@/lib/lead-state';
import { LEGACY_FILTER, LEGACY_SOURCE_LABEL, matchesSourceFilter, sourceName, type Lead } from '@/lib/lead-source';
import { compareLeadByPostedAt, type LeadDateOrder } from '@/lib/lead-order';
import { AppShell } from './app-shell';
import { Icon } from './visuals';
import { GoatMascot } from './goat-mascot';
import { reportSourceOpen } from '@/lib/feedback-client';
import { deliveryClock, heldBackLine, latestDelivery, type DeliverySummary, type LatestDelivery } from '@/lib/lead-delivery';
import './first-search-ux.css';

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
export function SourceLine({ lead, prefer }: { lead: Lead; prefer?: string }) {
  // On a list scoped to one need, that need is named first, so a post found by several needs reads as belonging here.
  const preferred = prefer ? lead.sources.findIndex(source => source.kind === 'profile' ? source.profileId === prefer : prefer === LEGACY_FILTER) : -1;
  const ordered = preferred > 0 ? [lead.sources[preferred], ...lead.sources.filter((_, index) => index !== preferred)] : lead.sources;
  const [first, ...rest] = ordered;
  if (!first) return null;
  return <span className={`lead-source ${first.kind === 'legacy' ? 'is-legacy' : ''}`}><Icon name="target" size={14}/>{sourceName(first)}{rest.length > 0 && <> · +{rest.length} nhu cầu</>}</span>;
}

export function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`status-pill is-${status}`}>{statusLabel[status]}</span>;
}

/**
 * The original Facebook post, exactly as stored by the backend (never built or guessed). It is the main way to judge
 * an opportunity, so it sits on every card; opening it does not open the lead or change its status. The click (left
 * or middle button) is reported in the background as feedback evidence; the link itself is never delayed or prevented.
 */
export function FacebookLink({ lead, compact = false, className = '' }: { lead: Lead; compact?: boolean; className?: string }) {
  if (!lead.original_url) return compact ? null : <span className="no-link-note"><Icon name="info" size={16}/>Chưa có liên kết bài Facebook</span>;
  return <a className={`fb-link ${compact ? 'is-compact' : ''} ${className}`} href={lead.original_url} target="_blank" rel="noopener noreferrer"
    onClick={event => { event.stopPropagation(); reportSourceOpen(lead.id); }} onAuxClick={event => { if (event.button === 1) reportSourceOpen(lead.id); }}
    onKeyDown={event => event.stopPropagation()} aria-label={`Xem bài Facebook của ${leadName(lead)} (mở tab mới)`}>
    Xem bài Facebook<Icon name="external" size={compact ? 14 : 16}/>
  </a>;
}

/** Plain-language data status, only when something is actually missing. */
export function ContentStatus({ lead }: { lead: Lead }) {
  const { status, text } = leadText(lead);
  if (!status) return null;
  return <span className="content-status" title={text}><Icon name="info" size={13}/>{status}</span>;
}

/**
 * The one line a list shows for a lead: the backend's Vietnamese summary (labelled, never quoted), the post's own
 * Vietnamese text, or a short Vietnamese fallback. English or collector-written text is never the default preview.
 */
function LeadPreviewLine({ lead, className }: { lead: Lead; className: string }) {
  const shown = leadText(lead);
  if (shown.kind === 'fallback') return <p className={`${className} lead-preview-fallback`}>{shown.listText}</p>;
  const line = shown.kind === 'original' ? readLead(shown.text, lead.need).evidence : shown.text;
  return <p className={`${className} is-${shown.kind}`}>{shown.kind === 'summary' && <span className="text-kind">QLead tóm tắt</span>}{line}</p>;
}

/**
 * When the post was published, or, if Facebook did not give a time, when QLead found it, labelled as such: the
 * discovery time is never presented as the publication time.
 */
function PostedOrFound({ lead, now }: { lead: Lead; now: number }) {
  if (lead.published_at) return <time dateTime={lead.published_at} title={`Đăng lúc ${exactTime(lead.published_at)}`}>{relativeTime(lead.published_at, now)}</time>;
  if (lead.discovered_at) return <time className="is-found" dateTime={lead.discovered_at} title={`Chưa rõ giờ đăng · QLead tìm thấy lúc ${exactTime(lead.discovered_at)}`}>Tìm thấy {relativeTime(lead.discovered_at, now).toLocaleLowerCase('vi')}</time>;
  return <span className="muted-text">Chưa rõ giờ đăng</span>;
}

/**
 * The newest batch QLead handed over (at most one bounded delivery), so the customer starts there and works through
 * it one by one instead of facing the whole list. Older leads stay in the list below; nothing is hidden by default.
 * `compact` (Today) only links to the list.
 */
export function LatestDeliveryBand({ latest, workflow, delivery, now, onlyLatest = false, onToggle, onStart, compact = false }: {
  latest: LatestDelivery; workflow: LeadWorkflowApi; delivery?: DeliverySummary | null; now: number;
  onlyLatest?: boolean; onToggle?: () => void; onStart?: () => void; compact?: boolean;
}) {
  const total = latest.ids.length;
  const unseen = latest.ids.filter(id => workflow.get(id).status === 'new').length;
  const handled = total - unseen;
  const held = heldBackLine(delivery, now || undefined);
  const when = now ? deliveryClock(latest.at, now) : '';
  if (unseen === 0) {
    if (compact) return null;
    return <section className="latest-delivery is-done" aria-labelledby="latest-delivery-title">
      <span className="latest-delivery-mark" aria-hidden="true"><Icon name="check" size={22}/></span>
      <div className="latest-delivery-copy">
        <h2 id="latest-delivery-title">Bạn đã xem hết {total} khách hàng của lượt gửi gần nhất</h2>
        <p className={held ? 'latest-delivery-held' : undefined}>{held ?? 'Khách hàng mới sẽ được gửi vào đây ở các lượt sau.'}</p>
      </div>
      {onlyLatest && onToggle && <div className="latest-delivery-actions"><button type="button" className="btn btn-outline btn-sm" onClick={onToggle}>Hiện tất cả lead</button></div>}
    </section>;
  }
  return <section className={`latest-delivery ${compact ? 'is-compact' : ''}`} aria-labelledby="latest-delivery-title">
    <span className="latest-delivery-mark" aria-hidden="true"><Icon name="radar" size={22}/></span>
    <div className="latest-delivery-copy">
      <h2 id="latest-delivery-title">{total} khách hàng mới trong lượt gửi gần nhất</h2>
      <p>{when && <>Gửi {when} · </>}còn <b>{unseen} chưa xem</b>. Xem lần lượt từng khách để không bỏ sót cơ hội.</p>
      {handled > 0 && <p className="latest-delivery-progress"><meter min={0} max={total} value={handled} aria-label="Đã xem trong lượt gửi gần nhất"/>Đã xem {handled}/{total}</p>}
      {held && <p className="latest-delivery-held">{held}</p>}
    </div>
    <div className="latest-delivery-actions">
      {compact
        ? <Link className="btn btn-primary btn-sm" href="/app/bai-viet?luot=moi">{handled ? 'Xem khách tiếp theo' : 'Bắt đầu xem'} <Icon name="arrow" size={16}/></Link>
        : <>
          {onStart && <button type="button" className="btn btn-primary btn-sm" onClick={onStart}>{handled ? 'Xem khách tiếp theo' : 'Bắt đầu xem'} <Icon name="arrow" size={16}/></button>}
          {onToggle && <button type="button" className="btn btn-outline btn-sm" aria-pressed={onlyLatest} onClick={onToggle}>{onlyLatest ? 'Hiện tất cả lead' : 'Chỉ hiện lượt này'}</button>}
        </>}
    </div>
  </section>;
}

/** Compact lead row used on the Today page and on mobile. The card opens the lead; the Facebook link opens the post. */
export function LeadListItem({ lead, now, workflow, source, latest = false }: { lead: Lead; now: number; workflow: LeadWorkflowApi; source?: string; latest?: boolean }) {
  const state = workflow.get(lead.id);
  const hot = activeHot(lead, now, source && source !== 'all' && source !== LEGACY_FILTER ? source : undefined);
  const area = displayArea(lead);
  const text = leadText(lead).kind !== 'fallback';
  return <li className={`lead-item ${state.status === 'new' ? 'is-unseen' : ''} ${text ? '' : 'is-no-text'} ${latest ? 'is-latest' : ''} ${hot ? 'is-hot' : ''}`}>
    <Link className="lead-item-main" href={leadHref(lead.id)}>
      <div className="lead-item-top">
        <StatusPill status={state.status}/>
        <span className={`lead-item-author ${lead.author ? '' : 'is-fallback'}`}>{leadName(lead)}{hot ? <HotTag compact/> : latest && <span className="latest-tag">Lượt mới</span>}</span>
        <PostedOrFound lead={lead} now={now}/>
      </div>
      <LeadPreviewLine lead={lead} className="lead-item-need"/>
      <div className="lead-item-meta">
        {(text || area) && <span className={area ? '' : 'muted-text'}><Icon name="pin" size={15}/>{area ?? 'Chưa rõ khu vực'}</span>}
        {lead.contact && <span className="has-contact" title="Số lấy từ nội dung bài, chưa xác minh chủ số"><Icon name="phone" size={15}/>{lead.contact.number}</span>}
        {text && <ContentStatus lead={lead}/>}
        {state.notes.length > 0 && <span className="note-count"><Icon name="list" size={14}/>{state.notes.length} ghi chú</span>}
      </div>
    </Link>
    <div className="lead-item-foot">
      <SourceLine lead={lead} prefer={source}/>
      <FacebookLink lead={lead} compact/>
    </div>
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
      {CUSTOMER_STATUSES.filter(status => status !== 'new').map(status => <button key={status} type="button" role="radio" aria-checked={state.status === status}
        className={`status-option is-${status}`} title={statusHint[status]} onClick={() => workflow.setStatus(lead.id, status)}>{statusLabel[status]}</button>)}
    </div>
    {statusHint[state.status] && <p className="status-hint">{statusHint[state.status]}</p>}
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

export function LeadDetail({ lead, now, workflow, headingLevel = 2, profileId }: { lead: Lead; now: number; workflow: LeadWorkflowApi; headingLevel?: 1 | 2; profileId?: string }) {
  const { status, copy } = useCopyStatus();
  const area = displayArea(lead);
  const source = sourceLabel(lead);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const shown = leadText(lead);
  const reading = readLead(shown.kind === 'original' ? shown.text : '', shown.kind === 'original' ? lead.need : null);
  // Only the post's own words let QLead say "the post has no number / names no area"; a summary or a fallback cannot.
  const text = shown.kind === 'original';
  // Without the post's text QLead cannot know what the post says about contacts or area: point to the post instead.
  const inPost = <span className="muted-text">Xem trong bài gốc</span>;

  // Two columns: the post on the left, what the salesperson did with it on the right.
  return <article className={`lead-detail ${text ? '' : 'is-no-text'}`} aria-label={`Lead: ${leadName(lead)}`}>
    <div className="lead-detail-main">
      <HotCallout lead={lead} now={now} profileId={profileId}/>
      <header className="lead-detail-head">
        <Heading className={`lead-detail-author ${lead.author ? '' : 'is-fallback'}`}>{leadName(lead)}</Heading>
        <p className="lead-detail-sub">{['Facebook', source].filter(Boolean).join(' · ')}{lead.published_at && <> · <time dateTime={lead.published_at} title={exactTime(lead.published_at)}>Đăng {relativeTime(lead.published_at, now)}</time></>}</p>
        <ReadingTags reading={reading} limit={4}/>
      </header>

      {shown.kind === 'original' && <figure className="lead-text"><figcaption>Nội dung trên Facebook</figcaption><blockquote className="lead-post-body" lang="vi">{shown.text}</blockquote></figure>}
      {shown.kind === 'summary' && <section className="lead-summary" aria-label="QLead tóm tắt">
        <span className="text-kind">QLead tóm tắt</span>
        <p>{shown.text}</p>
        <small>Tóm tắt tự động từ bài đăng, không phải lời của người đăng. Hãy mở bài gốc để kiểm tra.</small>
      </section>}
      {shown.kind === 'fallback' && <div className="lead-post-missing">
        <span className="lead-post-missing-icon" aria-hidden="true"><Icon name="info" size={18}/></span>
        <div><b>{shown.status}</b><p>{shown.text}</p></div>
        {lead.original_url && <FacebookLink lead={lead} className="btn btn-primary"/>}
      </div>}
      {shown.stored && <details className="lead-stored">
        <summary>Xem nội dung gốc</summary>
        <p className="lead-stored-label">{shown.stored.label}</p>
        <blockquote lang={looksEnglish(shown.stored.text) ? 'en' : 'vi'}>{shown.stored.text}</blockquote>
      </details>}

      <dl className="lead-facts">
        <div><dt><Icon name="phone" size={16}/>SĐT trong bài</dt><dd>{lead.contact ? <><span className="contact-line"><a href={`tel:${lead.contact.normalized}`}>{lead.contact.number}</a><button type="button" className="icon-btn" onClick={() => copy(lead.contact!.number, 'số điện thoại')} aria-label="Sao chép số điện thoại"><Icon name="copy" size={16}/></button></span><small className="contact-hint">Lấy từ nội dung bài, chưa xác minh chủ số.</small></> : text ? <span className="muted-text">Bài không ghi số</span> : inPost}</dd></div>
        <div><dt><Icon name="pin" size={16}/>Khu vực</dt><dd>{area ?? (text ? <span className="muted-text">Bài không nêu</span> : inPost)}</dd></div>
        <div><dt><Icon name="clock" size={16}/>Đăng lúc</dt><dd>{lead.published_at ? exactTime(lead.published_at) : <span className="muted-text">Chưa rõ giờ đăng</span>}</dd></div>
        <div><dt><Icon name="radar" size={16}/>QLead tìm thấy lúc</dt><dd>{lead.discovered_at ? exactTime(lead.discovered_at) : '—'}</dd></div>
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
        {/* The primary action, unless the missing-content box above already carries it. */}
        {(shown.kind !== 'fallback' || !lead.original_url) && <FacebookLink lead={lead} className="btn btn-primary"/>}
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

/** The list URL for one need ('all' = every need). The URL is what selects the need; nothing else stores it. */
export function leadListHref(source: string) { return source === 'all' ? '/app/bai-viet' : `/app/bai-viet?nhu-cau=${encodeURIComponent(source)}`; }

/**
 * `records` are already scoped on the server to `source` (resolved from ?nhu-cau=), and `total` is how many leads that
 * scope holds before the list limit. Choosing another need navigates to its URL, so the URL, the dropdown and the rows
 * always describe the same need, and Back/Forward/refresh restore it. The page is keyed by source, so no client state
 * from the previous need survives the switch.
 */
export function LeadResultsPage({ records, total = records.length, workflow: initialWorkflow, profiles, hasLegacy = false, source = 'all', notice, delivery = null, latestOnly = false, hotOnly = false }: { records: Lead[]; total?: number; workflow: WorkflowMap; profiles: ProfileOption[]; hasLegacy?: boolean; source?: string; notice?: ReactNode; delivery?: DeliverySummary | null; latestOnly?: boolean; hotOnly?: boolean }) {
  const now = useNow();
  const router = useRouter();
  const workflow = useLeadWorkflow(initialWorkflow);
  // The newest delivery (?luot=moi opens the list on it). It only narrows the view; history is one click away.
  const latest = useMemo(() => latestDelivery(records), [records]);
  const latestIds = useMemo(() => new Set(latest?.ids ?? []), [latest]);
  const [onlyLatest, setOnlyLatest] = useState(latestOnly && Boolean(latest));
  const latestOpen = Boolean(latest && latest.ids.some(id => workflow.get(id).status === 'new'));
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<DateRange>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [onlyContact, setOnlyContact] = useState(false);
  const [onlyNotes, setOnlyNotes] = useState(false);
  const [onlyHot, setOnlyHot] = useState(hotOnly);
  const [dateOrder, setDateOrder] = useState<LeadDateOrder>('newest');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sourceOptions = useMemo(() => [...profiles, ...(hasLegacy || source === LEGACY_FILTER ? [{ id: LEGACY_FILTER, name: LEGACY_SOURCE_LABEL }] : [])], [profiles, hasLegacy, source]);
  const [switching, startSwitch] = useTransition();
  // Shows the chosen need in the dropdown while its leads load; falls back to the URL's need once navigation settles.
  const [shownSource, showSource] = useOptimistic(source);
  const selected = sourceOptions.find(option => option.id === source) ?? null;
  function chooseSource(next: string) {
    if (next === source) return;
    startSwitch(() => { showSource(next); router.push(leadListHref(next), { scroll: false }); });
  }
  const [openId, setOpenId] = useState<string | null>(null);

  // A Hot assessment belongs to one need: on a need's own list only that need's assessment counts.
  const hotScope = source !== 'all' && source !== LEGACY_FILTER ? source : undefined;
  const hot = useMemo(() => hotLeads(records, now, hotScope), [records, now, hotScope]);
  const hotIds = useMemo(() => new Set(hot.map(lead => lead.id)), [hot]);
  const counts = useMemo(() => {
    const result: Record<StatusFilter, number> = { all: records.length, new: 0, seen: 0, contacted: 0, interested: 0, not_interested: 0, not_fit: 0 };
    for (const lead of records) result[workflow.get(lead.id).status] += 1;
    return result;
  }, [records, workflow]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('vi');
    const windowMs = range === '24h' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 0;
    return records.filter(lead => {
      const state = workflow.get(lead.id);
      const text = `${lead.author ?? ''} ${leadSearchText(lead)} ${displayArea(lead) ?? ''} ${lead.contact?.number ?? ''} ${state.notes.map(note => note.body).join(' ')}`.toLocaleLowerCase('vi');
      return (!needle || text.includes(needle))
        && (!windowMs || isRecent(lead.published_at, now, windowMs))
        && (statusFilter === 'all' || state.status === statusFilter)
        && (!onlyContact || Boolean(lead.contact))
        && (!onlyNotes || state.notes.length > 0)
        && (!onlyLatest || latestIds.has(lead.id))
        && (!onlyHot || hotIds.has(lead.id))
        && matchesSourceFilter(lead, source); // already scoped on the server; kept as a guard
    }).sort((a, b) => compareLeadByPostedAt(a, b, dateOrder));
  }, [records, now, query, range, statusFilter, onlyContact, onlyNotes, onlyLatest, onlyHot, hotIds, latestIds, source, workflow, dateOrder]);
  const visible = filtered.slice(0, visibleCount);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [query, range, statusFilter, onlyContact, onlyNotes, onlyLatest, onlyHot, source, dateOrder]);
  // The Hot filter only exists while a Hot Lead is live; when the last one expires it switches itself off.
  useEffect(() => { if (onlyHot && now && hot.length === 0) setOnlyHot(false); }, [onlyHot, now, hot.length]);

  /** The next unseen lead of the latest delivery in the order the list shows, skipping `after`. */
  function nextLatest(after?: string): Lead | null {
    if (!latest) return null;
    const ordered = [...records].filter(lead => latestIds.has(lead.id)).sort((a, b) => compareLeadByPostedAt(a, b, dateOrder));
    return ordered.find(lead => lead.id !== after && workflow.get(lead.id).status === 'new') ?? null;
  }

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
  const activeFilters = Number(Boolean(query)) + Number(range !== 'all') + Number(statusFilter !== 'all') + Number(onlyContact) + Number(onlyNotes) + Number(onlyLatest) + Number(onlyHot) + Number(source !== 'all');
  function reset() { setQuery(''); setRange('all'); setStatusFilter('all'); setOnlyContact(false); setOnlyNotes(false); setOnlyLatest(false); setOnlyHot(false); chooseSource('all'); }
  const latestSeen = latest ? latest.ids.filter(id => workflow.get(id).status !== 'new').length : 0;
  const upNext = open && latestIds.has(open.id) ? nextLatest(open.id) : null;

  return <AppShell active="Danh sách lead">
    <div className="page-head">
      <div><h1>Danh sách lead</h1>
        {selected && <p className="lead-scope"><Icon name="target" size={15}/>Khách hàng từ: <b>{selected.name}</b> · <Link href={leadListHref('all')} className="text-link" scroll={false}>Xem mọi nhu cầu</Link></p>}
        <p>{total} lead · <b>{counts.new} chưa xem</b> · sắp xếp theo thời gian đăng Facebook</p>
        {total > records.length && <p className="lead-limit-note">Đang hiển thị {records.length} lead mới nhất.{source === 'all' ? ' Chọn một nhu cầu để xem toàn bộ lead của nhu cầu đó.' : ''}</p>}</div>
      <Link href="/app/bo-loc" className="btn btn-outline hide-mobile"><Icon name="target" size={16}/>Sửa nhu cầu theo dõi</Link>
    </div>
    {notice}
    {!onlyHot && <HotLeadBand leads={hot} now={now} profileId={hotScope} busy={Boolean(openId)} onOpen={openLead}/>}
    {latest && <LatestDeliveryBand latest={latest} workflow={workflow} delivery={delivery} now={now} onlyLatest={onlyLatest}
      onToggle={() => setOnlyLatest(value => !value)} onStart={() => { const next = nextLatest(); if (next) openLead(next.id); }}/>}

    <div className="status-tabs" role="tablist" aria-label="Lọc theo trạng thái">
      {(['all', ...CUSTOMER_STATUSES] as StatusFilter[]).map(status => <button key={status} type="button" role="tab" aria-selected={statusFilter === status} onClick={() => setStatusFilter(status)}>
        {status === 'all' ? 'Tất cả' : statusLabel[status]}<span>{counts[status]}</span>
      </button>)}
    </div>

    <section className="filter-bar" aria-label="Lọc lead">
      <label className="search-field"><Icon name="search" size={18}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm theo nội dung, người đăng, số điện thoại, ghi chú" aria-label="Tìm lead"/></label>
      {sourceOptions.length > 0 && <label className="select-field"><span className="sr-only">Nhu cầu tìm kiếm</span><select value={shownSource} onChange={event => chooseSource(event.target.value)} aria-label="Lọc theo nhu cầu" aria-busy={switching}><option value="all">Mọi nhu cầu</option>{sourceOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
      <label className="select-field"><span className="sr-only">Thời gian đăng</span><select value={range} onChange={event => setRange(event.target.value as DateRange)}><option value="all">Mọi thời gian</option><option value="24h">Đăng trong 24 giờ</option><option value="7d">Đăng trong 7 ngày</option></select></label>
      <label className="select-field"><span className="sr-only">Sắp xếp lead</span><select value={dateOrder} onChange={event => setDateOrder(event.target.value as LeadDateOrder)} aria-label="Sắp xếp lead"><option value="newest">Mới nhất</option><option value="oldest">Cũ nhất</option></select></label>
      <div className="toggle-chips" role="group" aria-label="Lọc nhanh">
        {hot.length > 0 && <button type="button" className="hot-chip" aria-pressed={onlyHot} onClick={() => setOnlyHot(value => !value)}>Hot Lead ({hot.length})</button>}
        <button type="button" aria-pressed={onlyContact} onClick={() => setOnlyContact(value => !value)}>Có số liên hệ</button>
        <button type="button" aria-pressed={onlyNotes} onClick={() => setOnlyNotes(value => !value)}>Có ghi chú</button>
        {activeFilters > 0 && <button type="button" className="clear-chip" onClick={reset}>Xóa lọc ({activeFilters})</button>}
      </div>
    </section>

    {switching && <p className="sr-only" role="status">Đang tải lead của nhu cầu đã chọn…</p>}
    <div className={switching ? 'lead-results-body is-switching' : 'lead-results-body'} aria-busy={switching}>
    {filtered.length === 0
      ? records.length === 0 && selected
        ? <div className="panel empty-state"><GoatMascot size="sm"/><h2>Nhu cầu này chưa có lead</h2><p>Khi QLead tìm thấy bài phù hợp với “{selected.name}”, lead sẽ xuất hiện tại đây.</p><Link className="btn btn-outline" href={leadListHref('all')} scroll={false}>Xem mọi nhu cầu</Link></div>
      : <div className="panel empty-state"><GoatMascot size="sm"/><h2>{records.length ? 'Không có lead khớp bộ lọc' : 'Chưa có lead nào'}</h2><p>{records.length ? 'Thử bỏ bớt điều kiện lọc.' : 'Khi QLead tìm thấy bài phù hợp với nhu cầu theo dõi, lead sẽ xuất hiện tại đây.'}</p>{records.length ? <button className="btn btn-outline" type="button" onClick={reset}>Xóa bộ lọc</button> : <Link className="btn btn-primary" href="/app/bo-loc">Thiết lập nhu cầu theo dõi</Link>}</div>
      : <>
        <div className="lead-table-wrap panel">
          <table className="lead-table">
            <thead><tr><th>Trạng thái</th><th>Lead</th><th>Khu vực</th><th>SĐT trong bài</th><th>Thời gian</th><th>Ghi chú</th><th><span className="sr-only">Bài Facebook gốc</span></th></tr></thead>
            <tbody>{visible.map(lead => {
              const state = workflow.get(lead.id);
              const shown = leadText(lead);
              const reading = readLead(shown.kind === 'original' ? shown.text : '', shown.kind === 'original' ? lead.need : null);
              const area = displayArea(lead);
              const text = shown.kind !== 'fallback';
              const isLatest = latestOpen && latestIds.has(lead.id);
              const isHot = hotIds.has(lead.id);
              return <tr key={lead.id} data-id={lead.id} className={`${state.status === 'new' ? 'is-new' : ''} ${openId === lead.id ? 'is-open' : ''} ${text ? '' : 'is-no-text'} ${isLatest ? 'is-latest' : ''} ${isHot ? 'is-hot' : ''}`} tabIndex={0} aria-label={`Mở lead: ${leadName(lead)}${isHot ? ' (Hot Lead)' : isLatest ? ' (lượt gửi gần nhất)' : ''}`}
                onClick={() => openLead(lead.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLead(lead.id); } }}>
                <td><StatusPill status={state.status}/></td>
                {/* With no extracted text the preview line already says what is missing; no second chip repeats it. */}
                <td className="lead-cell"><b className={lead.author ? '' : 'is-fallback'}>{leadName(lead)}{isHot ? <HotTag compact/> : isLatest && <span className="latest-tag">Lượt mới</span>}</b><LeadPreviewLine lead={lead} className="lead-cell-text"/>{text && <ReadingTags reading={reading} limit={2}/>}<SourceLine lead={lead} prefer={source}/></td>
                <td className={area ? '' : 'muted-text'}>{area ?? '—'}</td>
                <td>{lead.contact ? <span className="has-contact">{lead.contact.number}</span> : <span className="muted-text">—</span>}</td>
                <td className="time-cell"><PostedOrFound lead={lead} now={now}/></td>
                <td className="note-cell">{state.notes[0] ? <><span className="note-count">{state.notes.length}</span><span className="note-preview">{state.notes[0].body}</span></> : <span className="muted-text">—</span>}</td>
                <td className="fb-cell"><FacebookLink lead={lead} compact/></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <ul className="lead-list lead-cards panel">{visible.map(lead => <LeadListItem key={lead.id} lead={lead} now={now} workflow={workflow} source={source} latest={latestOpen && latestIds.has(lead.id)}/>)}</ul>
        {visible.length < filtered.length && <div className="lead-load-more"><p>Đang hiển thị {visible.length}/{filtered.length} lead phù hợp</p><button className="btn btn-outline" type="button" onClick={() => setVisibleCount(count => Math.min(count + PAGE_SIZE, filtered.length))}>Tải thêm {Math.min(PAGE_SIZE, filtered.length - visible.length)} lead</button></div>}
      </>}
    </div>

    {open && <>
      <div className="drawer-backdrop" onClick={() => setOpenId(null)}/>
      <aside className="lead-drawer" role="dialog" aria-modal="true" aria-label="Chi tiết lead">
        <button type="button" className="drawer-close icon-btn" onClick={() => setOpenId(null)} aria-label="Đóng"><Icon name="back" size={16}/></button>
        <LeadDetail key={open.id} lead={open} now={now} workflow={workflow} profileId={hotScope}/>
        {latest && latestIds.has(open.id) && <div className="drawer-next">
          <span>Lượt gửi gần nhất · đã xem {latestSeen}/{latest.ids.length}</span>
          {upNext
            ? <button type="button" className="btn btn-primary btn-sm" onClick={() => openLead(upNext.id)}>Khách tiếp theo <Icon name="arrow" size={16}/></button>
            : <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpenId(null)}>Đã xem hết lượt này</button>}
        </div>}
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
