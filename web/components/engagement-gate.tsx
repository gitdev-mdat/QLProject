'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { engagementView, HOW_IT_COUNTS, isGated, LEAD_REVIEW_EVENT, unreviewedHref, type LeadEngagementGate } from '@/lib/engagement-gate';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';
import './engagement-gate.css';

export async function fetchGate(profileId: string): Promise<LeadEngagementGate | null | undefined> {
  try {
    const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/scan`, { cache: 'no-store' });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return undefined; }
    const data = await response.json() as { engagement?: LeadEngagementGate | null };
    return data.engagement ?? null;
  } catch { return undefined; }
}

/** What the server did after the customer's review in this page: sent held leads, reopened searching, or both. */
export type EngagementRelease = { added: number; reopened: boolean };

/**
 * The server's engagement progress for one need. Re-read after the customer does something that may count as a review
 * (the source-open request is keepalive and lands a moment later, hence the short delay) and when the tab comes back.
 * When the server sends held leads or reopens the need, the page refreshes once so they appear without a reload.
 * The release is in-memory only: a refresh or route change never replays it. undefined = not known yet.
 */
export function useEngagementGate(profileId: string | null, refreshKey?: unknown) {
  const router = useRouter();
  const [gate, setGate] = useState<LeadEngagementGate | null | undefined>(undefined);
  const [released, setReleased] = useState<EngagementRelease | null>(null);
  const wasGated = useRef(false);
  const delivered = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!profileId) return;
    const next = await fetchGate(profileId);
    if (next === undefined) return;
    setGate(next);
    const added = next && delivered.current !== null ? Math.max(next.deliveredCount - delivered.current, 0) : 0;
    const reopened = wasGated.current && !isGated(next);
    // Only a change that happened while this page showed the need as waiting counts; a normal scan has its own UI.
    if (wasGated.current && (added > 0 || reopened)) { setReleased({ added, reopened }); router.refresh(); }
    wasGated.current = isGated(next);
    delivered.current = next?.deliveredCount ?? null;
  }, [profileId, router]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!profileId) return;
    let timer: number | undefined;
    const onReview = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 900); };
    const onVisible = () => { if (document.visibilityState === 'visible' && wasGated.current) void load(); };
    window.addEventListener(LEAD_REVIEW_EVENT, onReview);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearTimeout(timer); window.removeEventListener(LEAD_REVIEW_EVENT, onReview); document.removeEventListener('visibilitychange', onVisible); };
  }, [profileId, load]);

  const dismissReleased = useCallback(() => setReleased(null), []);
  return { gate, released, dismissReleased, reload: load };
}

/** One bar: reviewed share of delivered leads, with a tick at the target. */
function Progress({ percent, target }: { percent: number; target: number }) {
  return <div className="eg-progress">
    <div className="eg-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%, mục tiêu ${target}%`}>
      <span className="eg-fill" style={{ width: `${percent}%` }}/>
      <span className="eg-target" style={{ left: `${target}%` }} aria-hidden="true"/>
    </div>
    <span className="eg-pct"><b>{percent}%</b> / mục tiêu {target}%</span>
  </div>;
}

/**
 * Shown only while the server holds new searches/leads for this need until enough delivered leads are explored.
 * `place` changes framing only: on a need card it links to that need's unread leads; on the list it explains in place.
 */
export function EngagementPanel({ gate, profileId, place }: { gate: LeadEngagementGate | null | undefined; profileId: string; place: 'card' | 'list' }) {
  const view = engagementView(gate);
  if (!view) return null;
  return <section className={`eg-panel is-${place}`} aria-labelledby={`eg-title-${place}-${profileId}`}>
    <div className="eg-head">
      <p className="eg-title" id={`eg-title-${place}-${profileId}`}>{view.title}</p>
      {view.pending > 0 && <span className="eg-pending">{view.pending} cơ hội đang chờ gửi</span>}
    </div>
    <p className="eg-line">{view.progressLine} <b>{view.nextLine}</b></p>
    <Progress percent={view.percent} target={view.target}/>
    <div className="eg-foot">
      <details className="eg-how"><summary>Thế nào là khám phá?</summary><p>{HOW_IT_COUNTS}</p></details>
      {place === 'card' && <Link className="btn btn-primary btn-sm" href={unreviewedHref(profileId)}>Xem khách hàng chưa xem <Icon name="arrow" size={14}/></Link>}
    </div>
  </section>;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

/**
 * Lightweight thanks after a review in this page made the server send held leads and/or reopen searching. The goat
 * hops once (never with reduced motion), the line stays until dismissed or 20 s pass, and nothing replays on refresh.
 */
export function EngagementReleased({ release, onDismiss }: { release: EngagementRelease | null; onDismiss: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [hop, setHop] = useState(false);
  useEffect(() => {
    if (!release) return;
    setHop(true);
    const stop = window.setTimeout(() => setHop(false), 2600);
    const close = window.setTimeout(onDismiss, 20_000);
    return () => { window.clearTimeout(stop); window.clearTimeout(close); };
  }, [release, onDismiss]);
  if (!release) return null;
  const headline = release.reopened ? 'Bạn đã khám phá đủ cơ hội để nhận lượt mới!' : 'Cảm ơn bạn đã khám phá thêm!';
  const detail = release.added > 0
    ? `QLead đã gửi thêm ${release.added} khách hàng cho bạn.${release.reopened ? ' QLead sẽ tiếp tục tìm theo lịch.' : ''}`
    : 'QLead sẽ tiếp tục tìm khách hàng mới theo lịch.';
  return <div className={`eg-released ${hop && !reduced ? 'is-hop' : ''}`} role="status">
    <span className="eg-released-goat" aria-hidden="true"><GoatMascot size="sm" animate={hop && !reduced}/></span>
    <p><b>{headline}</b> {detail}</p>
    <button type="button" className="icon-btn eg-close" onClick={onDismiss} aria-label="Đóng thông báo"><span aria-hidden="true">×</span></button>
  </div>;
}

export type WaitingNeed = { id: string; name: string; remaining: number; pending: number };

/** Today: one short line per need that waits for the customer, nothing otherwise (Today must stay uncluttered). */
export function EngagementTodayLine({ profiles, onWaiting }: { profiles: Array<{ id: string; name: string }>; onWaiting?: (ids: string[]) => void }) {
  const [waiting, setWaiting] = useState<WaitingNeed[]>([]);
  const ids = profiles.map(profile => profile.id).join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(profiles.map(async profile => ({ profile, view: engagementView(await fetchGate(profile.id)) }))).then(results => {
      if (cancelled) return;
      const next = results.flatMap(({ profile, view }) => view ? [{ id: profile.id, name: profile.name, remaining: view.remaining, pending: view.pending }] : []);
      setWaiting(next);
      onWaiting?.(next.map(item => item.id));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  if (!waiting.length) return null;
  return <ul className="eg-today" aria-label="Nhu cầu chờ bạn khám phá thêm">{waiting.map(item => <li key={item.id}>
    <span className="eg-dot" aria-hidden="true"/>
    <span><b>{item.name}</b> · {item.pending ? 'QLead đã lưu thêm cơ hội. ' : ''}Khám phá thêm {item.remaining} khách hàng để nhận lượt tiếp theo.</span>
    <Link className="text-link" href={unreviewedHref(item.id)}>Xem</Link>
  </li>)}</ul>;
}
