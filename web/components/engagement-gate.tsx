'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { engagementView, HOW_IT_COUNTS, isGated, LEAD_REVIEW_EVENT, type LeadEngagementGate } from '@/lib/engagement-gate';
import { Icon } from './visuals';
import './engagement-gate.css';

async function fetchGate(profileId: string): Promise<LeadEngagementGate | null | undefined> {
  try {
    const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/scan`, { cache: 'no-store' });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return undefined; }
    const data = await response.json() as { engagement?: LeadEngagementGate | null };
    return data.engagement ?? null;
  } catch { return undefined; }
}

/** What the server did after the customer's last review: sent more leads, reopened searching, or both. */
export type EngagementRelease = { added: number; reopened: boolean };

/**
 * The server's engagement progress for one need. Re-read after the customer does something that may count as a review
 * (the source-open request is keepalive and lands a moment later, hence the short delay). When the server sends held
 * leads or reopens the need, the page is refreshed once so they appear without a manual reload. undefined = not known.
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
    // Only a change caused while the customer was being held counts; a scan finishing on its own is shown by the scan UI.
    if (wasGated.current && (added > 0 || reopened)) { setReleased({ added, reopened }); router.refresh(); }
    wasGated.current = isGated(next);
    delivered.current = next?.deliveredCount ?? null;
  }, [profileId, router]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!profileId) return;
    let timer: number | undefined;
    const onReview = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 900); };
    const onFocus = () => { if (document.visibilityState === 'visible' && wasGated.current) void load(); };
    window.addEventListener(LEAD_REVIEW_EVENT, onReview);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener(LEAD_REVIEW_EVENT, onReview); document.removeEventListener('visibilitychange', onFocus); };
  }, [profileId, load]);

  const dismissReleased = useCallback(() => setReleased(null), []);
  return { gate, released, dismissReleased, reload: load };
}

function Progress({ reviewed, required, delivered, progress }: { reviewed: number; required: number; delivered: number; progress: number }) {
  return <div className="eg-progress">
    <div className="eg-bar" role="progressbar" aria-valuemin={0} aria-valuemax={required} aria-valuenow={Math.min(reviewed, required)}
      aria-label={`Đã xử lý ${reviewed} trên ${required} khách hàng cần thiết`}>
      <span style={{ width: `${progress}%` }}/>
    </div>
    <p className="eg-count"><b>{reviewed}/{required}</b> khách hàng cần xử lý <span>· đã nhận {delivered}</span></p>
  </div>;
}

/**
 * Shown only while the server holds new searches/leads for this need until the customer handles enough of the leads
 * already sent. `place` changes framing only: on a need card it links to the list, on the list it explains in place.
 */
export function EngagementPanel({ gate, profileId, place }: { gate: LeadEngagementGate | null | undefined; profileId: string; place: 'card' | 'list' }) {
  const view = engagementView(gate);
  if (!view) return null;
  return <section className={`eg-panel is-${place}`} aria-label="Khách hàng cần xử lý" role="status">
    <span className="eg-icon" aria-hidden="true"><Icon name={view.pending ? 'spark' : 'check'} size={18}/></span>
    <div className="eg-body">
      <p className="eg-title">{view.title}</p>
      <p className="eg-detail">{view.detail}</p>
      <Progress reviewed={view.reviewed} required={view.required} delivered={view.delivered} progress={view.progress}/>
      <details className="eg-how"><summary>Thế nào là đã xử lý?</summary><p>{HOW_IT_COUNTS}</p></details>
    </div>
    {place === 'card' && <Link className="btn btn-primary btn-sm eg-cta" href={`/app/bai-viet?nhu-cau=${encodeURIComponent(profileId)}`}>Xử lý khách hàng <Icon name="arrow" size={14}/></Link>}
  </section>;
}

/** One calm line after the customer's review made the server send held leads and/or reopen searching. */
export function EngagementReleased({ release, onDismiss }: { release: EngagementRelease | null; onDismiss: () => void }) {
  useEffect(() => { if (!release) return; const timer = window.setTimeout(onDismiss, 15_000); return () => window.clearTimeout(timer); }, [release, onDismiss]);
  if (!release) return null;
  const sent = release.added > 0 ? `QLead đã gửi thêm ${release.added} khách hàng` : '';
  const text = sent && release.reopened ? `${sent} và sẽ tìm tiếp theo lịch.` : sent ? `${sent}.` : 'QLead sẽ tìm tiếp theo lịch.';
  return <p className="eg-released" role="status"><Icon name="check" size={16}/>Cảm ơn bạn! {text}</p>;
}

/** Today: one line per need that is waiting for the customer, nothing otherwise (Today must stay uncluttered). */
export function EngagementTodayLine({ profiles }: { profiles: Array<{ id: string; name: string }> }) {
  const [waiting, setWaiting] = useState<Array<{ id: string; name: string; remaining: number; pending: number }>>([]);
  const ids = profiles.map(profile => profile.id).join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(profiles.map(async profile => ({ profile, view: engagementView(await fetchGate(profile.id)) }))).then(results => {
      if (cancelled) return;
      setWaiting(results.flatMap(({ profile, view }) => view ? [{ id: profile.id, name: profile.name, remaining: view.remaining, pending: view.pending }] : []));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  if (!waiting.length) return null;
  return <ul className="eg-today" aria-label="Nhu cầu đang chờ bạn xử lý khách hàng">{waiting.map(item => <li key={item.id}>
    <Icon name="info" size={14}/>
    <span><b>{item.name}</b>: {item.pending ? `QLead đang giữ ${item.pending} khách hàng mới. ` : ''}Xử lý thêm {item.remaining} khách hàng để QLead tìm tiếp.</span>
    <Link className="text-link" href={`/app/bai-viet?nhu-cau=${encodeURIComponent(item.id)}`}>Xử lý</Link>
  </li>)}</ul>;
}
