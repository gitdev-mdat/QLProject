'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { exactTime } from '@/lib/lead-format';
import { draftFrom, draftPayload, effectiveKeywords, emptyDraft, EXAMPLES, LOCATIONS, planFor, withDescription, type Draft } from '@/lib/profile-draft';
import { LEGACY_FILTER } from '@/lib/lead-source';
import { SCAN_OPEN, type ProfileScan, type ScanRequestOutcome } from '@/lib/profile-scan';
import { frequencyLabel, locationLabel, NO_LOCATION_OPTION, PROFILE_FREQUENCIES, type LegacySummary, type SearchProfile } from '@/lib/profile-state';
import { profileStatus, requestNote, rescanButton, type ProfileStatus } from '@/lib/profile-status';
import { AppShell, useMonitoringSuspended } from './app-shell';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';

type Sent = { ok: true; data: { version?: number; scan?: ScanRequestOutcome | null } } | { ok: false; error: string };

async function send(url: string, method: 'POST' | 'PATCH', body?: unknown): Promise<Sent> {
  try {
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({})) as { error?: string; version?: number; scan?: ScanRequestOutcome | null };
    if (response.ok) return { ok: true, data };
    if (data.error === 'limit_reached') return { ok: false, error: 'Bạn đã có tối đa 10 nhu cầu. Hãy sửa một nhu cầu cũ thay vì tạo mới.' };
    if (data.error === 'invalid_request') return { ok: false, error: 'Hãy mô tả khách hàng bạn muốn tìm (ít nhất vài chữ). Nếu tự đặt cụm tìm kiếm, cần ít nhất một cụm.' };
    if (data.error === 'stale') return { ok: false, error: 'Nhu cầu này vừa được sửa ở nơi khác. Tải lại trang để xem điều kiện mới nhất trước khi sửa tiếp.' };
    if (data.error === 'not_found') return { ok: false, error: 'Không tìm thấy nhu cầu này. Tải lại trang.' };
    return { ok: false, error: 'Không lưu được. Thử lại sau ít phút.' };
  } catch { return { ok: false, error: 'Không kết nối được máy chủ. Thử lại sau ít phút.' }; }
}

type Saved = { at: number; request: ScanRequestOutcome | null };

const SUSPENDED_SCAN_HINT = 'Tìm lead mới đang tạm dừng nên chưa tìm lại được. Bạn vẫn lưu được thay đổi.';

/** "14:05" today, "14:05 · 02/11" on other days (Vietnam time). */
function shortTime(value: string): string {
  const zone = { timeZone: 'Asia/Ho_Chi_Minh' } as const;
  const date = new Date(value);
  const day = (d: Date) => new Intl.DateTimeFormat('vi-VN', { ...zone, day: '2-digit', month: '2-digit' }).format(d);
  const clock = new Intl.DateTimeFormat('vi-VN', { ...zone, hour: '2-digit', minute: '2-digit' }).format(date);
  return day(date) === day(new Date()) ? clock : `${clock} · ${day(date)}`;
}

function ProfileForm({ profile, onDone, onSaved }: { profile?: SearchProfile; onDone: () => void; onSaved?: (saved: Saved) => void }) {
  const router = useRouter();
  const suspended = useMonitoringSuspended();
  const [draft, setDraft] = useState<Draft>(profile ? draftFrom(profile) : emptyDraft);
  // A place written in the description fills Khu vực until the customer picks a value themselves.
  const [locationTouched, setLocationTouched] = useState(() => Boolean(profile && profile.location !== (planFor(draftFrom(profile)).location ?? '')));
  const [saving, setSaving] = useState<null | 'save' | 'rescan'>(null);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const plan = planFor(draft);
  const keywords = effectiveKeywords(draft);
  const locations = draft.location && !LOCATIONS.includes(draft.location) ? [draft.location, ...LOCATIONS] : LOCATIONS;
  const descriptionChanged = Boolean(profile) && draft.description.trim() !== (profile?.description ?? '').trim();
  const describeEnough = draft.description.trim().length >= 5;
  const canRescan = Boolean(profile?.enabled) && !suspended;
  const runningScan = profile?.scan?.state === 'running';

  const [leftManual, setLeftManual] = useState(false);
  function describe(text: string) {
    // The description is the instruction: once it changes, phrases the customer wrote for the old one stop applying.
    // They can opt back in under Tùy chọn nâng cao, but nothing keeps old phrases silently.
    const leaving = draft.keywordsSource === 'manual' && Boolean(profile) && text.trim() !== (profile?.description ?? '').trim();
    if (leaving) setLeftManual(true);
    setDraft(current => {
      const next = { ...withDescription(current, text), ...(leaving ? { keywordsSource: 'description' as const } : {}) };
      return locationTouched ? next : { ...next, location: planFor(next).location ?? '' };
    });
  }

  async function submit(rescan: boolean) {
    if (!describeEnough) { setError('Hãy mô tả khách hàng bạn muốn tìm.'); return; }
    if (draft.keywordsSource === 'manual' && !keywords.length) { setError('Bạn đang tự đặt cụm tìm kiếm: cần ít nhất một cụm, hoặc bỏ chọn để QLead tạo từ mô tả.'); return; }
    setSaving(rescan ? 'rescan' : 'save'); setError('');
    const payload = draftPayload(draft);
    const result = profile
      ? await send(`/api/profiles/${profile.id}`, 'PATCH', { profile: payload, base_version: profile.version, rescan })
      : await send('/api/profiles', 'POST', { profile: payload, enabled: draft.enabled });
    setSaving(null);
    if (!result.ok) { setError(result.error); return; }
    onSaved?.({ at: Date.now(), request: result.data.scan ?? null });
    onDone();
    router.refresh();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(canRescan); }

  return <form className="panel profile-form" onSubmit={onSubmit} aria-label={profile ? `Sửa ${profile.name}` : 'Tạo nhu cầu mới'} aria-busy={Boolean(saving)}>
    <div className="profile-form-head">
      <h2>{profile ? 'Sửa nhu cầu' : 'Tạo nhu cầu mới'}</h2>
      <button type="button" className="icon-btn" onClick={onDone} aria-label="Đóng"><Icon name="back" size={16}/></button>
    </div>

    <label className="field field-primary">Bạn muốn tìm khách hàng nào?
      <textarea className="text-area" rows={3} maxLength={1000} value={draft.description} onChange={event => describe(event.target.value)} required
        placeholder="Ví dụ: Quán F&B sắp khai trương hoặc đang tuyển nhân viên để chuẩn bị khai trương."/>
      <small>Nêu loại khách và dấu hiệu bạn quan tâm. Nêu khu vực nếu chỉ muốn tìm ở đó.</small>
    </label>
    {!profile && <div className="example-chips"><span>Mẫu:</span>{EXAMPLES.map(example => <button type="button" key={example} onClick={() => describe(example)}>{example}</button>)}</div>}

    {describeEnough && <>
      {plan.notes.map(note => <p key={note} className="search-preview-note is-hint"><Icon name="info" size={14}/>{note}</p>)}
      {leftManual && draft.keywordsSource === 'description' && <p className="search-preview-note is-hint" role="status"><Icon name="info" size={14}/>
        Bạn đã sửa mô tả nên QLead tạo lại cụm tìm kiếm từ mô tả mới thay cho các cụm cũ. Muốn tự đặt cụm, mở Tùy chọn nâng cao.</p>}
      <details className="pf-phrases">
        <summary>{draft.keywordsSource === 'manual' ? `Cụm tìm kiếm bạn tự đặt (${keywords.length})` : `Xem cách QLead sẽ tìm (${keywords.length} cụm từ)`}</summary>
        <ul className="keyword-chips">{keywords.map(keyword => <li key={keyword}>{keyword}</li>)}</ul>
        {draft.keywordsSource === 'manual' && <p className="search-preview-note">Các cụm này không tự đổi theo mô tả.</p>}
      </details>
    </>}

    <div className="field-grid profile-fields">
      <label className="field">Tên nhu cầu
        <input value={draft.name} maxLength={80} onChange={event => setDraft(current => ({ ...current, name: event.target.value, nameEdited: true }))} placeholder={plan.name || 'Ví dụ: Quán F&B sắp khai trương'}/>
        {draft.nameEdited && descriptionChanged && plan.name && plan.name !== draft.name && <small className="field-suggest">Gợi ý theo mô tả mới: <b>{plan.name}</b> <button type="button" className="text-link" onClick={() => setDraft(current => ({ ...current, name: plan.name, nameEdited: false }))}>Dùng tên này</button></small>}
      </label>
      <label className="field"><span>Khu vực <span className="field-optional">(không bắt buộc)</span></span>
        <select aria-label="Khu vực" value={draft.location} onChange={event => { setLocationTouched(true); set('location', event.target.value); }}>
          <option value="">{NO_LOCATION_OPTION}</option>{locations.map(location => <option key={location} value={location}>{location}</option>)}
        </select>
        {plan.location && plan.location !== draft.location && <small className="field-suggest">Mô tả có nhắc <b>{plan.location}</b>. <button type="button" className="text-link" onClick={() => { setLocationTouched(false); set('location', plan.location!); }}>Áp dụng</button></small>}
      </label>
    </div>

    <details className="advanced-options">
      <summary>Tùy chọn nâng cao</summary>
      <label className="field">Tần suất theo dõi<select aria-label="Tần suất theo dõi" value={draft.frequency} onChange={event => set('frequency', Number(event.target.value))}>{PROFILE_FREQUENCIES.map(minutes => <option key={minutes} value={minutes}>{frequencyLabel(minutes).replace(/^m/, 'M')}</option>)}</select></label>
      <label className="check-line"><input type="checkbox" checked={draft.keywordsSource === 'manual'} onChange={event => { const manual = event.target.checked; setDraft(current => ({ ...current, keywordsSource: manual ? 'manual' : 'description', keywords: manual && current.keywordsSource !== 'manual' ? planFor(current).queries.join('\n') : current.keywords })); }}/>Tự đặt cụm tìm kiếm thay cho gợi ý của QLead</label>
      {draft.keywordsSource === 'manual' && <label className="field">Cụm tìm kiếm riêng<textarea rows={4} value={draft.keywords} onChange={event => set('keywords', event.target.value)} placeholder="Mỗi dòng một cụm, ví dụ: quán cafe sắp khai trương"/><small>Mỗi dòng một cụm, tối đa 10.</small></label>}
    </details>

    {!profile && <label className="check-line"><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)}/>Bật theo dõi ngay sau khi lưu</label>}
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
    {profile && <p className="pf-form-note">{suspended ? SUSPENDED_SCAN_HINT
      : !profile.enabled ? 'Nhu cầu đang tạm dừng. Bạn vẫn lưu được, nhưng cần bật lại theo dõi để QLead tìm.'
        : runningScan ? 'QLead đang tìm theo mô tả hiện tại. Thay đổi của bạn sẽ được dùng từ lượt tìm sau.'
          : 'Sau khi lưu, QLead sẽ tìm lại theo mô tả mới.'}</p>}
    <div className="profile-form-actions">
      <button type="button" className="btn btn-outline" onClick={onDone} disabled={Boolean(saving)}>Hủy</button>
      {profile ? <>
        {canRescan && <button type="button" className="btn btn-outline" disabled={Boolean(saving)} onClick={() => void submit(false)}>{saving === 'save' ? 'Đang lưu…' : 'Chỉ lưu'}</button>}
        <button type="submit" className="btn btn-primary" disabled={Boolean(saving)}>{saving ? 'Đang lưu…' : canRescan ? 'Lưu và tìm lại' : 'Lưu thay đổi'}</button>
      </> : <button type="submit" className="btn btn-primary" disabled={Boolean(saving)}>{saving ? 'Đang lưu…' : draft.enabled ? 'Lưu và bật theo dõi' : 'Lưu bản nháp'}</button>}
    </div>
  </form>;
}

/** Follows the stored scan state while it is open; the server is the only source of progress. */
function useProfileScan(profileId: string, initial: ProfileScan | null) {
  const router = useRouter();
  const [scan, setScan] = useState(initial);
  const initialKey = JSON.stringify(initial);
  useEffect(() => { setScan(JSON.parse(initialKey) as ProfileScan | null); }, [initialKey]);
  const state = scan?.state;
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = Boolean(state && SCAN_OPEN.includes(state));
    // A scan that just finished changes lead counts and the last-scan line: reload them from the server once.
    if (wasOpen.current && !open) router.refresh();
    wasOpen.current = open;
    if (!open) return;
    const timer = window.setInterval(() => void refresh(), state === 'delayed' ? 30_000 : 5000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, profileId]);
  async function refresh() {
    try {
      const response = await fetch(`/api/profiles/${profileId}/scan`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { scan: ProfileScan | null };
      setScan(data.scan);
    } catch { /* keep the last known state */ }
  }
  return { scan, refresh };
}

const STATUS_ICON: Record<ProfileStatus['tone'], string> = { waiting: 'clock', running: 'search', success: 'spark', quiet: 'check', warn: 'info', off: 'clock', idle: 'radar' };
const KIND_EYEBROW: Record<ProfileScan['kind'], string> = { manual: 'Tìm lại theo yêu cầu của bạn', initial: 'Lần tìm đầu tiên', scheduled: 'Lần tìm định kỳ', followup: 'Tìm thêm sau lần tìm đầu tiên' };

type StepState = 'done' | 'current' | 'upcoming';
/** The connector leading into a step belongs to that step: solid only once the step is done, travelling while it runs. */
type SegmentState = 'complete' | 'active' | 'upcoming';
const SEGMENT_OF: Record<StepState, SegmentState> = { done: 'complete', current: 'active', upcoming: 'upcoming' };
const STEP_SR: Record<StepState, string> = { done: 'đã xong', current: 'đang diễn ra', upcoming: 'chưa bắt đầu' };

/** Stages of one search, each marked only from stored timestamps: never ahead of what actually happened. */
function ScanSteps({ scan }: { scan: ProfileScan }) {
  const started = Boolean(scan.startedAt) && scan.state !== 'queued' && scan.state !== 'delayed';
  const finished = scan.state === 'results' || scan.state === 'no_results';
  const steps: Array<{ label: string; at: string | null; state: StepState }> = [
    { label: 'Đã nhận', at: scan.queuedAt, state: 'done' },
    { label: 'Chờ bắt đầu', at: null, state: started || finished ? 'done' : 'current' },
    { label: 'Đang tìm', at: started || finished ? scan.startedAt : null, state: finished ? 'done' : started ? 'current' : 'upcoming' },
    // A finished search with nothing matching must not claim "Có kết quả".
    { label: scan.state === 'no_results' ? 'Hoàn tất' : 'Có kết quả', at: finished ? scan.finishedAt : null, state: finished ? 'done' : 'upcoming' },
  ];
  return <ol className="pf-steps" aria-label="Các bước của lượt tìm">{steps.map((step, i) => <li key={i} className={`is-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
    {i > 0 && <span className={`pf-step-seg is-${SEGMENT_OF[step.state]}`} aria-hidden="true"/>}
    <span className="pf-step-dot"/><span className="pf-step-label">{step.label}</span><span className="sr-only">({STEP_SR[step.state]})</span>{step.at && <time className="pf-step-at" dateTime={step.at}>{shortTime(step.at)}</time>}
  </li>)}</ol>;
}

/** The goat follows the real state: resting while waiting, searching only while a search runs, celebrating real results. */
function ScanScene({ scan }: { scan: ProfileScan }) {
  const searching = scan.state === 'running';
  const found = scan.state === 'results';
  return <div className={`pf-scene discovery-scene is-${scan.state === 'queued' ? 'waiting' : scan.state}`} aria-hidden="true">
    <span className="discovery-ring"/>
    {searching && <><span className="discovery-card c1"><i/><i/></span><span className="discovery-card c2"><i/><i/></span></>}
    {found && <span className="discovery-spark">✦</span>}
    <GoatMascot size="sm" animate={searching || found}/>
  </div>;
}

/** The one place on a card that says what QLead is doing for this need. A search in motion or just finished gets the goat stage. */
function StatusPanel({ status, scan, profile, scanOpen, onEdit, onToggle, onRescan, toggling, canRescanLatest }: {
  status: ProfileStatus; scan: ProfileScan | null; profile: SearchProfile; scanOpen: boolean; onEdit: () => void; onToggle: () => void; onRescan: () => void; toggling: boolean; canRescanLatest: boolean;
}) {
  const staged = scan && status.freshness !== null && ['waiting', 'running', 'success', 'quiet', 'warn'].includes(status.tone);
  const freshNote = status.freshness === 'older' && <p className="pf-status-fresh is-older">{scanOpen
    ? 'Lượt này bắt đầu trước khi bạn lưu thay đổi gần nhất. Thay đổi sẽ được dùng từ lượt tìm sau.'
    : <>Kết quả này tìm theo mô tả trước khi bạn sửa.{canRescanLatest && <> <button type="button" className="text-link" onClick={onRescan}>Tìm theo mô tả mới</button></>}</>}</p>;
  const action = status.action && <div className="pf-status-action">
    {status.action === 'view_new' && <Link className="btn btn-primary btn-sm" href={`/app/bai-viet?nhu-cau=${profile.id}`}>Xem khách hàng mới <Icon name="arrow" size={14}/></Link>}
    {status.action === 'edit' && <button type="button" className="btn btn-outline btn-sm" onClick={onEdit}>Chỉnh mô tả</button>}
    {(status.action === 'resume' || status.action === 'enable') && <button type="button" className="btn btn-primary btn-sm" onClick={onToggle} disabled={toggling}>{toggling ? 'Đang lưu…' : status.action === 'enable' ? 'Bật theo dõi' : 'Bật lại theo dõi'}</button>}
  </div>;

  if (staged && scan) {
    const finished = scan.state === 'results' || scan.state === 'no_results';
    return <section className={`pf-stage is-${scan.state}`} aria-live="polite" aria-label="Tình trạng tìm kiếm">
      <ScanScene scan={scan}/>
      <div className="pf-stage-body">
        <p className="pf-stage-eyebrow">{KIND_EYEBROW[scan.kind]}</p>
        <p className="pf-stage-title">{status.live && <span className="pf-pulse" aria-hidden="true"/>}{status.title}</p>
        <p className="pf-stage-detail">{status.detail}</p>
        {finished && scan.totalFound !== null && <ul className="pf-stats" aria-label="Kết quả lượt tìm">
          <li><Icon name="search" size={16}/><span>Đã xem</span><b>{scan.totalFound}</b><span>bài đăng</span></li>
          <li className={scan.newPosts ? 'is-highlight' : 'is-empty'}><Icon name={scan.newPosts ? 'spark' : 'info'} size={16}/><span>Khách hàng mới</span><b>{scan.newPosts ?? 0}</b></li>
        </ul>}
        {scan.state !== 'failed' && <ScanSteps scan={scan}/>}
        {freshNote}
        {action}
      </div>
    </section>;
  }

  return <section className={`pf-status is-${status.tone}`} aria-live="polite" aria-label="Tình trạng tìm kiếm">
    <span className="pf-status-icon" aria-hidden="true">{status.live ? <span className="pf-pulse"/> : <Icon name={STATUS_ICON[status.tone]} size={18}/>}</span>
    <div className="pf-status-body">
      <p className="pf-status-title">{status.title}</p>
      <p className="pf-status-detail">{status.detail}</p>
      {freshNote}
    </div>
    {action}
  </section>;
}

function Description({ text, onEdit }: { text: string | null; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  if (!text) return <p className="pf-desc is-missing">Chưa có mô tả. <button type="button" className="text-link" onClick={onEdit}>Mô tả khách hàng bạn muốn tìm</button></p>;
  const long = text.length > 180;
  return <div className="pf-desc-wrap">
    <p className={`pf-desc${long && !open ? ' is-clamped' : ''}`}>{text}</p>
    {long && <button type="button" className="pf-more" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? 'Thu gọn' : 'Xem thêm'}</button>}
  </div>;
}

function ProfileCard({ profile, saved, onEdit }: { profile: SearchProfile; saved: Saved | null; onEdit: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'toggle' | 'scan'>(null);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { scan, refresh } = useProfileScan(profile.id, profile.scan);
  const scanOpen = Boolean(scan && SCAN_OPEN.includes(scan.state));
  const suspended = useMonitoringSuspended();

  useEffect(() => {
    if (!saved) return;
    setJustSaved(true);
    setNote(saved.request ? requestNote(saved.request) : null);
    if (saved.request?.outcome === 'cooldown') setWaitUntil(saved.at + saved.request.retryAfterSeconds * 1000);
    const timer = window.setTimeout(() => setJustSaved(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  useEffect(() => {
    if (!waitUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [waitUntil]);

  async function toggle() {
    setBusy('toggle'); setNote(null);
    const result = await send(`/api/profiles/${profile.id}`, 'PATCH', { action: profile.enabled ? 'pause' : 'resume' });
    setBusy(null);
    if (!result.ok) setNote({ text: result.error, tone: 'warn' }); else router.refresh();
  }
  async function rescan() {
    setBusy('scan'); setNote(null); setJustSaved(false);
    const result = await send(`/api/profiles/${profile.id}/scan`, 'POST');
    setBusy(null);
    if (!result.ok) { setNote({ text: result.error, tone: 'warn' }); return; }
    const request = result.data.scan;
    if (request) setNote(requestNote(request));
    if (request?.outcome === 'cooldown') { setNow(Date.now()); setWaitUntil(Date.now() + request.retryAfterSeconds * 1000); }
    await refresh();
  }

  const status = profileStatus(profile, scan, suspended, shortTime);
  const button = rescanButton(profile, scan, suspended, busy === 'scan', waitUntil, now);
  // While the account is on hold an enabled need keeps its own "on" setting (grey, since nothing is searched right now).
  const monitoring = suspended && profile.enabled ? { label: 'Đang bật', tone: 'off' } : profile.enabled ? { label: 'Đang theo dõi', tone: 'on' } : profile.state === 'draft' ? { label: 'Bản nháp', tone: 'off' } : { label: 'Tạm dừng', tone: 'off' };
  // A finished scan of an older save can be followed by one of the latest save (the cooldown only covers the same save).
  const canRescanLatest = button.show && !button.disabled;

  return <article className={`panel pf-card is-${monitoring.tone}`} aria-labelledby={`profile-${profile.id}`}>
    <header className="pf-head">
      <div className="pf-head-main">
        <span className={`pf-monitor is-${monitoring.tone}`}>{monitoring.label}</span>
        <h2 id={`profile-${profile.id}`}>{profile.name}</h2>
      </div>
      <button type="button" className="btn btn-outline btn-sm pf-edit" onClick={onEdit}>Sửa</button>
    </header>

    <Description text={profile.description} onEdit={onEdit}/>
    <p className="pf-meta">
      <span><Icon name="pin" size={14}/>{locationLabel(profile.location)}</span>
      {profile.enabled && !suspended && <span><Icon name="clock" size={14}/>Tự tìm {frequencyLabel(profile.frequencyMinutes)}</span>}
    </p>

    {justSaved && <p className="saved-line pf-saved" role="status"><Icon name="check" size={16}/>Đã lưu thay đổi.</p>}
    {/* The page header already says the account is on hold; an enabled card adds nothing until a running search finishes. */}
    {!(suspended && profile.enabled && scan?.state !== 'running') && <StatusPanel status={status} scan={suspended && scan?.state !== 'running' ? null : scan} profile={profile} scanOpen={scanOpen} onEdit={onEdit} onToggle={toggle} onRescan={rescan} toggling={busy === 'toggle'} canRescanLatest={canRescanLatest}/>}
    {note && <p className={note.tone === 'ok' ? 'pf-note' : 'pf-note is-warn'} role="status"><Icon name="info" size={14}/>{note.text}</p>}

    <footer className="pf-foot">
      {profile.leadCount > 0
        ? <Link className="text-link pf-leads" href={`/app/bai-viet?nhu-cau=${profile.id}`}>Xem {profile.leadCount} khách hàng <Icon name="arrow" size={16}/></Link>
        : <span className="pf-leads is-empty">Chưa có khách hàng nào</span>}
      <div className="pf-actions">
        {profile.enabled && <button type="button" className="btn btn-ghost btn-sm" onClick={toggle} disabled={busy !== null}>{busy === 'toggle' ? 'Đang lưu…' : 'Tạm dừng'}</button>}
        {button.show && <button type="button" className="btn btn-primary btn-sm" onClick={rescan} disabled={button.disabled} title={button.hint}>{button.label}</button>}
      </div>
    </footer>

    <details className="pf-phrases">
      <summary>{profile.keywordsSource === 'manual' ? `Cụm tìm kiếm bạn tự đặt (${profile.keywords.length})` : `Cách QLead tìm (${profile.keywords.length} cụm từ)`}</summary>
      <ul className="keyword-chips">{profile.keywords.map(keyword => <li key={keyword}>{keyword}</li>)}</ul>
    </details>
  </article>;
}

export function ProfilesPage({ profiles, legacy, startCreating = false }: { profiles: SearchProfile[]; legacy: LegacySummary | null; startCreating?: boolean }) {
  const [editing, setEditing] = useState<string | 'new' | null>(startCreating ? 'new' : null);
  const [saved, setSaved] = useState<{ id: string; saved: Saved } | null>(null);
  const monitoring = profiles.filter(profile => profile.enabled).length;
  const suspended = useMonitoringSuspended();
  const summary = !profiles.length ? 'Cho QLead biết bạn muốn tìm khách hàng nào.'
    : suspended ? `Tìm lead mới đang tạm dừng cho tài khoản của bạn.${monitoring ? ` ${monitoring} nhu cầu đang bật sẽ tự tiếp tục khi được kích hoạt lại.` : ''}`
      : monitoring ? `${monitoring} nhu cầu đang được theo dõi${monitoring < profiles.length ? `, ${profiles.length - monitoring} đang tạm dừng` : ''}.`
        : 'Chưa có nhu cầu nào đang được theo dõi.';

  return <AppShell active="Nhu cầu theo dõi">
    <div className="page-head pf-page-head">
      <div><h1>Nhu cầu theo dõi</h1><p>{summary}</p></div>
      {profiles.length > 0 && editing !== 'new' && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="spark" size={16}/>Tạo nhu cầu mới</button>}
    </div>

    {editing === 'new' && <ProfileForm onDone={() => setEditing(null)}/>}

    {profiles.length === 0 && editing !== 'new' && <section className="panel profiles-empty">
      <GoatMascot size={legacy ? 'sm' : 'md'}/>
      <div><h2>Bạn muốn tìm khách hàng nào?</h2>
        <p>Mô tả bằng lời của bạn, ví dụ “quán cafe sắp khai trương ở TP.HCM”. QLead sẽ tự tìm bài đăng phù hợp trên Facebook và báo khi có khách hàng mới.</p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Tạo nhu cầu đầu tiên</button></div>
    </section>}

    {profiles.length > 0 && <div className="profile-list">{profiles.map(profile => editing === profile.id
      ? <ProfileForm key={profile.id} profile={profile} onDone={() => setEditing(null)} onSaved={value => setSaved({ id: profile.id, saved: value })}/>
      : <ProfileCard key={profile.id} profile={profile} saved={saved?.id === profile.id ? saved.saved : null} onEdit={() => setEditing(profile.id)}/>)}</div>}

    {legacy && <section className="panel legacy-card" aria-label="Dữ liệu từ lượt quét trước">
      <div><h2>Khách hàng từ các lượt tìm trước</h2><p>{legacy.leadCount} khách hàng không thuộc nhu cầu nào{legacy.lastScanAt ? `, lần gần nhất ${exactTime(legacy.lastScanAt)}` : ''}. Vẫn được giữ nguyên.</p></div>
      {legacy.leadCount > 0 && <Link className="btn btn-outline btn-sm" href={`/app/bai-viet?nhu-cau=${LEGACY_FILTER}`}>Xem</Link>}
    </section>}
  </AppShell>;
}
