'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FirstScan } from '@/lib/first-scan';
import { discoveryOpen, discoveryView, MORE_SLOW_MS, type DiscoveryView, type MoreState } from '@/lib/first-discovery';
import { exactTime } from '@/lib/lead-format';
import { deliveryClock, heldBackLine, type DeliverySummary } from '@/lib/lead-delivery';
import { frequencyLabel, locationLabel } from '@/lib/profile-state';
import { AppShell } from './app-shell';
import { GoatMascot } from './goat-mascot';
import { useQuietHours } from './quiet-hours';
import { Icon } from './visuals';
import './first-search-ux.css';

/** What the first-scan view says while the first search is open, derived from the stored state plus elapsed time. */
type Phase = 'saved' | 'queued' | 'waiting_worker' | 'not_ready' | 'retrying' | 'running' | 'running_long' | 'delayed' | 'failed' | 'paused' | 'quiet';

/**
 * What the whole view shows. `open`/`failed`/`paused`: the first search itself. `found`: leads exist and can be opened
 * now, whether or not QLead is still looking further. `looking`: the first search found nothing yet and one more
 * search is open. `empty`: everything finished without leads.
 */
type Mode = 'open' | 'failed' | 'paused' | 'found' | 'looking' | 'empty';

/*
 * No fixed ETA: QLead cannot wake the search system and has a single measured run, so any "2–3 phút" would be a
 * guess (and read as "from signup"). The page shows real elapsed time from stored timestamps instead, and only
 * changes its wording at these thresholds. They choose words, never progress.
 */
/** A queued search not picked up after this long is described as "not started yet" instead of "preparing". */
const QUEUED_FRESH_MS = 2 * 60_000;
/** Waiting this long without a start is called "longer than usual" (still not an error). */
const QUEUED_SLOW_MS = 10 * 60_000;
/** A running search past this is called "longer than usual" (the one measured run took under a minute). */
const RUNNING_LONG_MS = 5 * 60_000;

const COPY: Record<Phase, { eyebrow: string; title: string; text: string }> = {
  saved: { eyebrow: 'Đã lưu nhu cầu', title: 'QLead đang chuẩn bị lượt tìm kiếm của bạn', text: 'Nhu cầu đã được lưu. QLead đang xếp lượt tìm đầu tiên.' },
  queued: { eyebrow: 'Đã lưu nhu cầu', title: 'QLead đang chuẩn bị lượt tìm kiếm của bạn', text: 'Lượt tìm đầu tiên sẽ bắt đầu ngay khi hệ thống tìm kiếm nhận việc. Trang này tự cập nhật, bạn không cần tải lại.' },
  waiting_worker: { eyebrow: 'Đã lưu nhu cầu', title: 'Lượt tìm đầu tiên chưa bắt đầu', text: 'Hệ thống tìm kiếm chưa nhận lượt này. Yêu cầu của bạn được giữ ở đầu hàng và sẽ bắt đầu ngay khi được nhận.' },
  not_ready: { eyebrow: 'Đã lưu nhu cầu', title: 'Lượt tìm đầu tiên chưa thể bắt đầu', text: 'Nhu cầu của bạn đã được lưu. Hệ thống tìm kiếm của QLead đang được hoàn tất thiết lập nên lượt tìm chưa bắt đầu. Lượt tìm sẽ chạy khi hệ thống sẵn sàng; bạn không cần làm gì thêm.' },
  retrying: { eyebrow: 'Đã lưu nhu cầu', title: 'QLead đang thử lại lượt tìm', text: 'Lần tìm trước chưa hoàn tất. QLead sẽ tự thử lại; nhu cầu của bạn vẫn được giữ và bạn không cần làm gì thêm.' },
  running: { eyebrow: 'Đang tìm', title: 'QLead đang tìm khách hàng phù hợp', text: 'Lượt tìm đầu tiên đang chạy với nhu cầu bạn vừa lưu. Kết quả sẽ hiện ngay khi lượt tìm xong.' },
  running_long: { eyebrow: 'Đang tìm', title: 'QLead đang tìm khách hàng phù hợp', text: 'Lượt tìm đang lâu hơn thường lệ, có thể do nhiều bài cần xem. QLead vẫn đang tìm và sẽ hiện kết quả ngay khi xong.' },
  delayed: { eyebrow: 'Đã lưu nhu cầu', title: 'Lượt tìm đang chờ lâu hơn bình thường', text: 'Đây không phải lỗi của bạn và bạn không cần tạo lại nhu cầu. QLead vẫn giữ yêu cầu và sẽ tìm ngay khi hệ thống tìm kiếm sẵn sàng.' },
  failed: { eyebrow: 'Lượt tìm đầu tiên', title: 'Lượt tìm đầu tiên chưa hoàn tất', text: 'Lượt tìm này gặp sự cố và chưa có kết quả. QLead sẽ thử lại ở lượt theo dõi kế tiếp theo lịch của bạn; nhu cầu đã lưu vẫn được giữ.' },
  quiet: { eyebrow: 'Đã lưu nhu cầu', title: 'QLead đang tạm nghỉ ban đêm', text: 'Việc tìm khách hàng mới sẽ tiếp tục từ 06:30 và lượt tìm đầu tiên của bạn sẽ bắt đầu khi đó. Nhu cầu đã được lưu, bạn có thể đóng trang.' },
  paused: { eyebrow: 'Đã lưu nhu cầu', title: 'Đã tạm dừng theo dõi', text: 'Nhu cầu đã lưu nhưng đang tạm dừng, nên QLead chưa tìm bài mới. Bật lại khi bạn sẵn sàng.' },
};

/** "chưa đến 1 phút", "3 phút", "1 giờ 5 phút": elapsed time from a stored timestamp, never a forecast. */
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'dưới 1 phút';
  if (minutes < 60) return `${minutes} phút`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} giờ${rest ? ` ${rest} phút` : ''}`;
}

/**
 * The timing box while the first search is open: what really happened and when (stored times plus elapsed time),
 * then what the customer can do. No estimate of when it will finish.
 */
function timingOf(scan: FirstScan, phase: Phase, now: number): { lead: string; text: string; tone?: 'slow' } | undefined {
  const at = (iso: string | null) => (iso ? shortClock(iso) : null);
  const since = (iso: string | null) => (now && iso ? ` · ${elapsedLabel(now - new Date(iso).getTime())}` : '');
  const leave = 'Bạn có thể rời trang: tiến trình được lưu và kết quả sẽ tự vào danh sách lead.';
  switch (phase) {
    case 'saved': return { lead: 'Đã lưu nhu cầu', text: leave };
    case 'quiet': return { lead: scan.queuedAt ? `Đã lưu lúc ${at(scan.queuedAt)}` : 'Đã lưu nhu cầu', text: 'Kết quả sẽ tự vào danh sách lead sau khi QLead tìm xong.' };
    case 'queued': return { lead: `Đã lưu lúc ${at(scan.queuedAt)}${since(scan.queuedAt).replace(' · ', ' · đã chờ ')}`, text: leave };
    case 'waiting_worker': return { lead: `Đã chờ ${now && scan.queuedAt ? elapsedLabel(now - new Date(scan.queuedAt).getTime()) : ''} (từ ${at(scan.queuedAt)})`, text: leave };
    case 'delayed': return { lead: scan.queuedAt ? `Đã chờ ${now ? elapsedLabel(now - new Date(scan.queuedAt).getTime()) : ''} (từ ${at(scan.queuedAt)})` : 'Đang chờ', text: leave, tone: 'slow' };
    case 'retrying': return { lead: scan.queuedAt ? `Đã lưu lúc ${at(scan.queuedAt)}` : 'Đang thử lại', text: leave, tone: 'slow' };
    case 'not_ready': return { lead: 'Chưa thể biết khi nào bắt đầu.', text: 'QLead sẽ tự cập nhật trang này khi lượt tìm bắt đầu.', tone: 'slow' };
    case 'running': return { lead: `Bắt đầu lúc ${at(scan.startedAt) ?? '—'}${since(scan.startedAt).replace(' · ', ' · đang tìm ')}`, text: leave };
    case 'running_long': return { lead: `Bắt đầu lúc ${at(scan.startedAt) ?? '—'}${since(scan.startedAt).replace(' · ', ' · đã tìm ')}`, text: leave, tone: 'slow' };
    default: return undefined;
  }
}

/** The one extra search after the first one, in customer words. No timing promise: it starts when a search is free. */
// "sẽ" until a search has really started, "đang" only while it runs.
const LOOKING_TITLE: Record<MoreState, string> = {
  planned: 'QLead sẽ tiếp tục tìm thêm cơ hội phù hợp',
  waiting: 'QLead sẽ tiếp tục tìm thêm cơ hội phù hợp',
  running: 'QLead đang tìm thêm cơ hội phù hợp…',
  retrying: 'QLead sẽ thử tìm thêm một lần nữa',
};
const MORE_STEP_NOTE: Record<MoreState, string> = { planned: 'Sắp tìm', waiting: 'Sắp tìm', running: 'Đang tìm', retrying: 'Sắp thử lại' };

export function phaseOf(scan: FirstScan, now: number, quiet = false): Phase {
  // `now` is 0 until mounted: render the server's view first, then refine by elapsed time on the client.
  const since = (value: string | null) => (now && value ? now - new Date(value).getTime() : 0);
  // Without a verified, active search service a queued search cannot start: say so instead of "sắp bắt đầu".
  // `searchReady: null` means "cannot be observed" and is never shown as a problem.
  if ((scan.state === 'waiting' || scan.state === 'delayed') && scan.searchReady === false) return 'not_ready';
  // Overnight (00:30–06:30) the backend holds new searches until 06:30: a calm pause, never "slow" or "stuck".
  if (quiet && (scan.state === 'waiting' || scan.state === 'delayed')) return 'quiet';
  // A search that was claimed before and is waiting again is a retry, not a first wait.
  if ((scan.state === 'waiting' || scan.state === 'delayed') && scan.discovery?.initialStatus === 'retrying') return 'retrying';
  switch (scan.state) {
    case 'waiting': {
      if (!scan.queuedAt) return 'saved';
      const waited = since(scan.queuedAt);
      return waited > QUEUED_SLOW_MS ? 'delayed' : waited > QUEUED_FRESH_MS ? 'waiting_worker' : 'queued';
    }
    case 'running': return since(scan.startedAt) > RUNNING_LONG_MS ? 'running_long' : 'running';
    case 'results': case 'no_results': return 'running';
    default: return scan.state;
  }
}

function modeOf(scan: FirstScan, view: DiscoveryView): Mode {
  if (view.stage === 'initial') return scan.state === 'failed' ? 'failed' : scan.state === 'paused' ? 'paused' : 'open';
  if (view.stage === 'more') return view.initialLeads ? 'found' : 'looking';
  return view.totalLeads ? 'found' : 'empty';
}

/**
 * Follows the stored state while anything in the first discovery is open (the first search or the extra one), and
 * stops once it settles. A newer server render (router.refresh) replaces the local copy.
 */
export function useFirstScan(initial: FirstScan): FirstScan {
  const [scan, setScan] = useState(initial);
  const initialKey = JSON.stringify(initial);
  useEffect(() => { setScan(JSON.parse(initialKey) as FirstScan); }, [initialKey]);
  const open = discoveryOpen(scan);
  const extra = discoveryView(scan).stage === 'more';
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch('/api/first-scan', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { scan: FirstScan | null };
        if (data.scan) setScan(data.scan);
      } catch { /* keep the last known state */ }
    }, extra ? 10_000 : 5000);
    return () => window.clearInterval(timer);
  }, [open, extra]);
  return scan;
}

type Delivered = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; total: number; delivery: DeliverySummary };

/**
 * How many leads of this need QLead has actually given the customer (the bounded delivery, at most 10 per cycle),
 * read from GET /api/leads once the first search has finished. Reading it is also what hands over the batch (the
 * contract delivers on read), so the number shown is exactly what the list will show. `key` refetches when the
 * discovery reports more results.
 */
function useDelivered(profileId: string, enabled: boolean, key: string): Delivered {
  const [state, setState] = useState<Delivered>({ status: 'idle' });
  const [round, setRound] = useState(0);
  // Nothing handed over yet: read again just after the next delivery boundary the backend reported, so the page
  // updates itself instead of asking for a manual reload.
  const waitUntil = state.status === 'ready' && state.total === 0 ? state.delivery.nextCycleAt : null;
  useEffect(() => {
    if (!enabled || !waitUntil) return;
    const delay = Math.max(5_000, new Date(waitUntil).getTime() - Date.now() + 5_000);
    const timer = window.setTimeout(() => setRound(value => value + 1), Math.min(delay, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [enabled, waitUntil]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState(previous => (previous.status === 'ready' ? previous : { status: 'loading' }));
    (async () => {
      try {
        const response = await fetch(`/api/leads?profile_id=${encodeURIComponent(profileId)}&limit=1`, { cache: 'no-store' });
        if (!response.ok) { await response.body?.cancel(); throw new Error(String(response.status)); }
        const data = await response.json() as { total: number; delivery: DeliverySummary };
        if (!cancelled) setState({ status: 'ready', total: data.total, delivery: data.delivery });
      } catch { if (!cancelled) setState(previous => (previous.status === 'ready' ? previous : { status: 'error' })); }
    })();
    return () => { cancelled = true; };
  }, [profileId, enabled, key, round]);
  return state;
}

/** A clock that ticks only while something is open, so elapsed-time copy can change without a new response. */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Plays the celebration once, the first time real leads are known: after the first search when it found some,
 * otherwise after the extra search when that one found some. The key (kept in localStorage once played) is the
 * profile plus the stored finish time of that search, so polling, rerenders and refreshes never replay it.
 */
function useCelebration(scan: FirstScan, view: DiscoveryView, mode: Mode): boolean {
  let key: string | null = null;
  if (mode === 'found' && view.initialLeads) key = scan.finishedAt ? `qlead:first-scan-celebrated:${scan.profile.id}:${scan.finishedAt}` : null;
  else if (mode === 'found' && view.moreFinishedAt) key = `qlead:first-scan-celebrated:${scan.profile.id}:more:${view.moreFinishedAt}`;
  const finishedAt = mode === 'found' && view.initialLeads ? scan.finishedAt : view.moreFinishedAt;
  const handled = useRef<string | null>(null);
  const [play, setPlay] = useState(false);
  // Before paint, so the count can start its reveal without first flashing the final number.
  useLayoutEffect(() => {
    if (!key || handled.current === key) return;
    handled.current = key;
    let seen = false;
    try { seen = window.localStorage.getItem(key) === '1'; window.localStorage.setItem(key, '1'); } catch { /* storage unavailable: play once for this view */ }
    // Only a search that really just finished is celebrated. Results of an older search that only became visible
    // later (for example after the lead rules changed) are shown calmly with their real finish time.
    const fresh = finishedAt ? Date.now() - new Date(finishedAt).getTime() < CELEBRATE_WITHIN_MS : false;
    if (!seen && fresh && !reducedMotion()) setPlay(true);
  }, [key, finishedAt]);
  return play;
}

/** A discovery is celebrated only if it finished this recently (a live arrival, not an old result shown again). */
const CELEBRATE_WITHIN_MS = 30 * 60_000;

const CONFETTI_COLORS =['#13A06F', '#E9A93A', '#0E7A57', '#F3C969', '#7FD1AE', '#E8795A'];

/** A short burst of DOM confetti from the goat, clipped to the hero so it can never widen the page. */
function Confetti({ origin }: { origin: RefObject<HTMLDivElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const host = layer.current;
    const from = origin.current;
    if (!host || !from) return;
    const box = host.getBoundingClientRect();
    const goat = from.getBoundingClientRect();
    const x = goat.left + goat.width / 2 - box.left;
    const y = goat.top + goat.height * 0.45 - box.top;
    const reach = Math.min(240, Math.max(140, box.width / 3));
    const animations = Array.from({ length: 44 }, (_, i) => {
      const piece = document.createElement('i');
      piece.style.left = `${x}px`;
      piece.style.top = `${y}px`;
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
      if (i % 3 === 0) piece.style.borderRadius = '50%';
      host.appendChild(piece);
      const angle = (i / 44) * Math.PI * 2 + Math.random() * 0.3;
      const distance = reach * (0.45 + Math.random() * 0.55);
      const dx = Math.min(Math.max(Math.cos(angle) * distance, (14 - x) / 1.08), (box.width - 14 - x) / 1.08);
      // Never rise past the panel's top edge (minus a margin), so no piece is cut off mid-flight.
      const dy = Math.max(Math.sin(angle) * distance * 0.75 - 30, 16 - y);
      const spin = (Math.random() - 0.5) * 720;
      return piece.animate([
        { transform: 'translate(-50%, -50%) scale(.4) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.08}px), calc(-50% + ${dy + 60}px)) scale(.9) rotate(${spin}deg)`, opacity: 0 },
      ], { duration: 1300 + Math.random() * 500, delay: Math.random() * 120, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    });
    let cancelled = false;
    Promise.all(animations.map(animation => animation.finished)).then(() => { if (!cancelled) setDone(true); }, () => undefined);
    return () => { cancelled = true; animations.forEach(animation => animation.cancel()); host.replaceChildren(); };
  }, [origin]);
  if (done) return null;
  return <div ref={layer} className="first-scan-confetti" aria-hidden="true"/>;
}

type SceneState = 'waiting' | 'running' | 'delayed' | 'results' | 'no_results' | 'failed' | 'paused';

/**
 * The goat scene follows the real state: an idle wait, an active search, or a celebration over real results.
 * `orbit` adds the "still looking" ring around a celebration, only while an extra search is really open: a slow,
 * dim orbit while it has not started yet, a brighter travelling spark while it actually runs.
 */
function DiscoveryScene({ state, sceneRef, orbit = null, hop = false }: { state: SceneState; sceneRef: RefObject<HTMLDivElement | null>; orbit?: 'pending' | 'running' | null; hop?: boolean }) {
  const searching = state === 'running';
  const found = state === 'results';
  return <div ref={sceneRef} className={`discovery-scene is-${state}${hop ? ' is-hop' : ''}`} aria-hidden="true">
    <span className="discovery-ring"/>
    {orbit && <span className={`discovery-orbit is-${orbit}`}><i/></span>}
    {searching && <>
      <span className="discovery-card c1"><i/><i/></span>
      <span className="discovery-card c2"><i/><i/></span>
      <span className="discovery-card c3"><i/><i/></span>
    </>}
    {found && <span className="discovery-spark">✦</span>}
    <GoatMascot size="md" animate={searching || found}/>
  </div>;
}

type StepState = 'done' | 'current' | 'upcoming';
/** The connector leading into a step belongs to that step: solid only once the step is done, travelling while it is current. */
const SEGMENT_OF: Record<StepState, string> = { done: 'complete', current: 'active', upcoming: 'upcoming' };
const STEP_SR: Record<StepState, string> = { done: 'đã xong', current: 'đang diễn ra', upcoming: 'chưa bắt đầu' };

function StepTrack({ label, steps }: { label: string; steps: Array<{ label: string; state: StepState; note?: string | null }> }) {
  return <ol className="first-scan-steps" aria-label={label}>{steps.map((step, i) => <li key={step.label} className={`is-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
    {i > 0 && <span className={`first-scan-step-seg is-${SEGMENT_OF[step.state]}`} aria-hidden="true"/>}
    <span className="first-scan-step-dot"/>
    <span className="first-scan-step-label">{step.label}</span>
    <span className="sr-only">({STEP_SR[step.state]})</span>
    {step.note && <span className="first-scan-step-note">{step.note}</span>}
  </li>)}</ol>;
}

/** Stages of the first search, each marked only from the stored state: never ahead of what actually happened. */
function InitialSteps({ scan }: { scan: FirstScan }) {
  const running = scan.state === 'running';
  return <StepTrack label="Các bước của lượt tìm đầu tiên" steps={[
    { label: 'Đã lưu nhu cầu', state: 'done' },
    { label: 'Chờ bắt đầu', state: running ? 'done' : 'current' },
    { label: 'Đang tìm', state: running ? 'current' : 'upcoming' },
    { label: 'Có kết quả', state: 'upcoming' },
  ]}/>;
}

/** The discovery after the first search found nothing: first search done, one more search open, then the routine. */
function LookingSteps({ scan, view }: { scan: FirstScan; view: DiscoveryView }) {
  return <StepTrack label="Các bước tìm khách hàng đầu tiên" steps={[
    { label: 'Lượt đầu', state: 'done', note: 'Chưa có lead' },
    { label: 'Tìm thêm', state: 'current', note: view.more ? MORE_STEP_NOTE[view.more] : null },
    { label: 'Theo dõi', state: 'upcoming', note: frequencyLabel(scan.profile.frequencyMinutes) },
  ]}/>;
}

const shortClock = (iso: string) => exactTime(iso).split(' ')[0];

/**
 * The one number of the success moment: new leads of this first discovery (first search + the extra search, each
 * counted once by the backend). It pops in with the celebration, and pops again with a "+N" when the extra search
 * adds leads while the page is open. Reduced motion: it simply appears.
 */
function FoundCount({ total, reveal }: { total: number | null; reveal: boolean }) {
  const seen = useRef(total);
  const [added, setAdded] = useState(0);
  useEffect(() => {
    if (total !== null && seen.current !== null && total > seen.current) setAdded(total - seen.current);
    seen.current = total;
  }, [total]);
  // While the delivered count loads, the same box holds its place so nothing below it jumps.
  if (total === null) return <div className="found-count is-loading" aria-hidden="true"><p className="found-count-main"><b>&nbsp;</b><span>khách hàng tiềm năng</span></p></div>;
  return <div className="found-count" role="group" aria-label={`${total} khách hàng tiềm năng`}>
    <p className="found-count-main">
      <b key={total} className={reveal || added ? 'is-reveal' : undefined}>{total}</b>
      <span>khách hàng tiềm năng</span>
      {added > 0 && <em className="found-count-added" key={`+${total}`} aria-hidden="true">+{added}</em>}
    </p>
  </div>;
}

/**
 * What QLead does next, as one line under the call to action. It animates only while an extra search is really
 * open: a slow breathing dot before it starts ("sẽ tiếp tục tìm thêm"), a travelling scan only while it runs
 * ("đang tìm thêm"). Once nothing is open it is a still line about the regular monitoring.
 */
function DiscoveryLine({ scan, view }: { scan: FirstScan; view: DiscoveryView }) {
  let tone: 'running' | 'pending' | 'idle' | 'hold';
  let title: ReactNode;
  let detail: ReactNode = null;
  if (view.hold === 'suspended') { tone = 'hold'; title = 'Tài khoản đang tạm ngưng tìm khách mới.'; detail = 'Lead đã tìm được vẫn được giữ.'; }
  else if (view.hold === 'paused') { tone = 'hold'; title = 'Nhu cầu đang tạm dừng nên QLead chưa tìm thêm.'; detail = <>Lead đã tìm được vẫn được giữ. <Link className="text-link" href="/app/bo-loc">Bật lại theo dõi</Link></>; }
  else if (view.more === 'running') { tone = 'running'; title = 'QLead đang tìm thêm cơ hội phù hợp…'; detail = 'Bạn có thể xem kết quả ngay. Cơ hội mới sẽ tự vào danh sách.'; }
  else if (view.more) { tone = 'pending'; title = 'QLead sẽ tiếp tục tìm thêm cơ hội phù hợp.'; detail = 'Bạn có thể xem kết quả ngay. Cơ hội mới sẽ tự vào danh sách.'; }
  else { tone = 'idle'; title = 'QLead sẽ tiếp tục theo dõi và cập nhật cơ hội mới cho bạn.'; detail = `Tự tìm lại ${frequencyLabel(scan.profile.frequencyMinutes)}.`; }
  return <div className={`discovery-line is-${tone}`} role="status">
    <span className="discovery-line-mark" aria-hidden="true">{tone === 'running' ? <span className="discovery-line-scan"><i/><i/><i/></span> : tone === 'pending' ? <span className="discovery-line-dot"/> : <Icon name={tone === 'hold' ? 'info' : 'radar'} size={16}/>}</span>
    <p><b>{title}</b>{detail && <span>{detail}</span>}</p>
  </div>;
}

/** The stamp under a finished heading: the stored finish time of the search the numbers come from. Only once nothing is open. */
function FinishedStamp({ view }: { view: DiscoveryView }) {
  if (view.stage !== 'done') return null;
  const extraFinished = view.moreOutcome === 'found' || view.moreOutcome === 'none';
  const at = extraFinished ? view.moreFinishedAt : view.initialFinishedAt;
  if (!at) return null;
  return <p className="first-scan-finished-at"><Icon name="check" size={14}/><span>Hoàn tất lúc <time dateTime={at}>{exactTime(at)}</time></span></p>;
}

/**
 * The success sentence. It says what QLead actually has: Facebook posts related to the customer's need, with the
 * original post to open. It never claims the poster asked for the customer's product or that anyone reviewed them.
 */
function foundText(delivered: Delivered): string {
  if (delivered.status !== 'ready') return 'Mở danh sách lead để xem từng bài Facebook gốc và đánh giá cơ hội.';
  // The headline and the big number already say how many; this line says where they are and what to do.
  return `Đã có trong danh sách lead của bạn. Mở từng bài Facebook gốc để đánh giá và bắt đầu liên hệ.`;
}

function emptyText(view: DiscoveryView): string {
  // What happens next is the line under the actions, so it is not repeated here.
  if (view.moreOutcome === 'none' || view.moreOutcome === 'failed') return 'QLead đã thử thêm vài hướng tìm khác nhưng chưa thấy bài đăng phù hợp với nhu cầu hiện tại.';
  return 'Chưa tìm thấy bài đăng phù hợp với nhu cầu hiện tại.';
}

/** The saved search while a search is open: the search as a titled card, what QLead looks for, then timing. */
function RequirementPanel({ scan, mode }: { scan: FirstScan; mode: Mode }) {
  const { profile } = scan;
  return <section className="first-scan-profile" aria-label="Nhu cầu đang tìm">
    <header className="first-scan-profile-head">
      <span className="first-scan-profile-badge"><Icon name="target" size={20}/></span>
      <div><span>Nhu cầu</span><strong>{profile.name}</strong></div>
    </header>
    <dl className="first-scan-profile-body">
      {profile.description && <div><dt>Bạn đã mô tả</dt><dd><blockquote>“{profile.description}”</blockquote></dd></div>}
      <div><dt>Tìm theo</dt><dd><ul className="first-scan-chips">
        {profile.keywords.map(keyword => <li key={keyword}>{keyword}</li>)}
        <li className="is-place"><Icon name="pin" size={14}/>{locationLabel(profile.location)}</li>
      </ul></dd></div>
    </dl>
    <dl className="first-scan-profile-meta">
      {mode === 'open' && scan.state === 'running' && scan.startedAt && <div><dt><Icon name="clock" size={15}/>Bắt đầu lúc</dt><dd>{exactTime(scan.startedAt)}</dd></div>}
      {mode !== 'looking' && scan.queuedAt && scan.state !== 'running' && <div><dt><Icon name="clock" size={15}/>Đã xếp lịch lúc</dt><dd>{exactTime(scan.queuedAt)}</dd></div>}
      {mode === 'looking' && scan.finishedAt && <div><dt><Icon name="check" size={15}/>Lượt đầu xong lúc</dt><dd>{exactTime(scan.finishedAt)}</dd></div>}
      <div><dt><Icon name="radar" size={15}/>Sau lượt đầu</dt><dd>{scan.state === 'paused' ? 'Đang tạm dừng' : `Theo dõi ${frequencyLabel(profile.frequencyMinutes)}`}</dd></div>
    </dl>
  </section>;
}

export function FirstScanView({ initial, compact = false }: { initial: FirstScan; compact?: boolean }) {
  const scan = useFirstScan(initial);
  const view = discoveryView(scan);
  const mode = modeOf(scan, view);
  const open = discoveryOpen(scan);
  const now = useTicking(open);
  const quiet = useQuietHours();
  const phase = phaseOf(scan, now, quiet);
  const finished = mode === 'found' || mode === 'empty';
  // The success number is what the customer was actually given (at most one bounded batch), never what the search saw.
  const delivered = useDelivered(scan.profile.id, mode === 'found', `${view.totalLeads ?? ''}:${view.moreFinishedAt ?? ''}`);
  const deliveredTotal = delivered.status === 'ready' ? delivered.total : null;
  // Found by the search but not handed over yet (the current delivery cycle is already used): say when, no confetti.
  const notYetGiven = mode === 'found' && deliveredTotal === 0;
  const celebrate = useCelebration(scan, view, deliveredTotal ? mode : 'open');
  const scene = useRef<HTMLDivElement>(null);
  // On Today the discovery only leads until leads exist; from then on the page's own lead list takes over.
  const router = useRouter();
  const led = useRef(mode);
  useEffect(() => {
    if (compact && led.current !== 'found' && mode === 'found') router.refresh();
    led.current = mode;
  }, [compact, mode, router]);

  let sceneState: SceneState;
  let eyebrow: string | null = null;
  let title: string;
  let text: string;
  let estimate: { lead: string; text: string; tone?: 'slow' } | undefined;
  if (notYetGiven && delivered.status === 'ready') {
    sceneState = 'results'; title = 'QLead đã tìm thấy bài đăng phù hợp';
    text = `Khách hàng sẽ được gửi vào danh sách lead ${delivered.delivery.nextCycleAt ? `từ ${deliveryClock(delivered.delivery.nextCycleAt)}` : 'ở lượt gửi tiếp theo'}. Bạn có thể rời trang, QLead tự cập nhật danh sách.`;
  }
  else if (mode === 'found') { sceneState = 'results'; title = 'QLead đã tìm thấy khách hàng cho bạn!'; text = foundText(delivered); }
  else if (mode === 'empty') { sceneState = 'no_results'; title = 'Đã hoàn tất lượt tìm đầu tiên'; text = emptyText(view); }
  else if (mode === 'looking') {
    const more = view.more!;
    sceneState = more === 'running' ? 'running' : 'waiting';
    eyebrow = 'Lượt tìm đầu tiên đã xong';
    title = LOOKING_TITLE[more];
    text = 'Lượt đầu chưa thấy bài đăng phù hợp. QLead sẽ thử thêm một lượt với vài cách tìm khác cho nhu cầu này, nhưng chưa chắc sẽ có thêm lead.';
    const waitingLong = more !== 'running' && view.moreQueuedAt && now && now - new Date(view.moreQueuedAt).getTime() > MORE_SLOW_MS;
    estimate = quiet && more !== 'running'
      ? { lead: 'QLead đang tạm nghỉ ban đêm.', text: 'Lượt tìm thêm sẽ chạy từ 06:30. Nếu có lead mới, QLead sẽ đưa vào danh sách.' }
      : waitingLong
      ? { lead: 'Lượt tìm thêm đang chờ lâu hơn thường lệ.', text: 'Yêu cầu vẫn được giữ, bạn không cần làm gì thêm. Nếu có lead mới, QLead sẽ đưa vào danh sách.', tone: 'slow' }
      : { lead: 'Bạn không cần chờ ở trang này.', text: 'Nếu có lead mới, QLead sẽ đưa vào danh sách và cập nhật trang này.' };
  } else {
    const copy = COPY[phase];
    sceneState = mode === 'open' ? (scan.state === 'running' ? 'running' : scan.state === 'delayed' ? 'delayed' : 'waiting') : mode;
    eyebrow = copy.eyebrow; title = copy.title; text = copy.text; estimate = timingOf(scan, phase, now);
  }
  // The moving bar means "a search is running right now" (a live claim), never "waiting".
  const searching = (mode === 'open' && scan.state === 'running') || (mode === 'looking' && view.more === 'running');

  return <section className={`panel first-scan is-${mode === 'open' ? scan.state : mode} ${finished ? 'is-finished' : ''} ${compact ? 'is-compact' : ''}`} aria-labelledby="first-scan-title" aria-live="polite" data-phase={mode === 'open' ? phase : mode} data-discovery={view.stage}>
    {celebrate && <Confetti origin={scene}/>}
    <div className="first-scan-hero">
      <DiscoveryScene state={sceneState} sceneRef={scene} hop={celebrate} orbit={mode === 'found' && view.more ? (view.more === 'running' ? 'running' : 'pending') : null}/>
      <div className="first-scan-copy">
        {!compact && !finished && eyebrow && <p className="first-scan-eyebrow">{eyebrow}</p>}
        <h1 id="first-scan-title" className={`first-scan-title is-${mode === 'open' ? scan.state : mode}`}>{title}</h1>
        {mode === 'found' && !notYetGiven && delivered.status !== 'error' && <FoundCount total={deliveredTotal} reveal={celebrate}/>}
        <p className="first-scan-lead">{text}</p>
        {mode === 'found' && delivered.status === 'ready' && heldBackLine(delivered.delivery) && <p className="first-scan-held"><Icon name="clock" size={15}/><span>{heldBackLine(delivered.delivery)}</span></p>}
        {/* Only the stored finish time of the search the numbers come from; nothing is shown when it is missing. */}
        {finished && <FinishedStamp view={view}/>}
        {estimate && <div className={`first-scan-estimate ${estimate.tone === 'slow' ? 'is-slow' : ''}`}>
          <Icon name="clock" size={20}/>
          <p><b>{estimate.lead}</b> {estimate.text}</p>
        </div>}
        {searching && <span className="first-scan-indeterminate" role="status" aria-label={title}><i/></span>}
        {mode === 'open' && <InitialSteps scan={scan}/>}
        {mode === 'looking' && <LookingSteps scan={scan} view={view}/>}
      </div>
    </div>

    {!finished && <RequirementPanel scan={scan} mode={mode}/>}
    {/* With no new leads the customer is asked to refine the search, so it stays named here. */}
    {mode === 'empty' && <dl className="first-scan-facts"><div><dt><Icon name="target" size={16}/>Nhu cầu</dt><dd>{scan.profile.name}</dd></div></dl>}

    <div className={`first-scan-actions ${finished ? 'is-finished' : ''}`}>
      {mode === 'found' && <Link className="btn btn-primary btn-lg" href={notYetGiven ? '/app/bai-viet' : `/app/bai-viet?nhu-cau=${scan.profile.id}&luot=moi`}>{notYetGiven ? 'Xem danh sách lead' : 'Xem khách hàng'} <Icon name="arrow" size={18}/></Link>}
      {mode === 'empty' && <><Link className="btn btn-primary btn-lg" href="/app/bo-loc">Chỉnh nhu cầu</Link><Link className="btn btn-outline btn-lg" href="/app">Về trang Hôm nay</Link></>}
      {mode === 'paused' && <Link className="btn btn-primary" href="/app/bo-loc">Bật lại theo dõi</Link>}
      {(mode === 'open' || mode === 'looking' || mode === 'failed') && <>{!compact && <Link className="btn btn-outline" href="/app">Vào trang Hôm nay</Link>}<Link className="btn btn-ghost" href="/app/bo-loc">Chỉnh nhu cầu</Link></>}
    </div>
    {finished && <DiscoveryLine scan={scan} view={view}/>}
  </section>;
}

export function FirstScanPage({ initial }: { initial: FirstScan }) {
  return <AppShell active="Hôm nay"><FirstScanView initial={initial}/></AppShell>;
}
