'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { reportSourceOpen } from '@/lib/feedback-client';
import type { HotLeadAssessment, Lead } from '@/lib/lead-source';
import { activeHot, claimCelebration, hotReason, hotUntil, prefersReducedMotion, wasHot } from '@/lib/hot-lead';
import { exactTime, leadName, relativeTime } from '@/lib/lead-format';
import { isStandalone } from '@/lib/pwa';
import { Icon } from './visuals';
import { GoatMascot } from './goat-mascot';
import { InstallButton } from './install-guide';
import { DISMISSED_KEY } from './pwa-runtime';
import './hot-lead.css';

/**
 * Everything here renders the backend's Hot assessment as given (status, reason, expiry). Nothing decides Hot in the
 * browser; with no live assessment these components render nothing, so there are no empty "0 Hot Lead" placeholders.
 */

export function HotTag({ compact = false }: { compact?: boolean }) {
  return <span className={`hot-tag ${compact ? 'is-compact' : ''}`}><HotMark/>Hot Lead</span>;
}

function HotMark() {
  return <svg className="hot-mark" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M8.6 1.2c.3 2.1-.9 3.2-2 4.4C5.4 6.9 4.2 8.2 4.2 10.2A3.8 3.8 0 0 0 8 14a3.8 3.8 0 0 0 3.8-3.8c0-1.4-.6-2.4-1.2-3.2-.2 1-.8 1.6-1.5 1.8.5-2.4-.1-5.4-2.5-7.6Z" fill="currentColor"/>
  </svg>;
}

/** Publication time as the customer should read it for a Hot Lead: "Vừa đăng 18 phút trước", never a guessed time. */
function HotPosted({ lead, now }: { lead: Lead; now: number }) {
  if (!lead.published_at) return <span className="hot-posted is-unknown">Chưa rõ giờ đăng</span>;
  return <time className="hot-posted" dateTime={lead.published_at} title={`Đăng lúc ${exactTime(lead.published_at)}`}>Đăng {relativeTime(lead.published_at, now).toLocaleLowerCase('vi')}</time>;
}

/** Shown at the top of a lead's detail: why it is Hot and until when it is worth acting first. */
export function HotCallout({ lead, now, profileId }: { lead: Lead; now: number; profileId?: string }) {
  const hot = activeHot(lead, now, profileId);
  const past = hot ? null : wasHot(lead, now, profileId);
  if (past) return <p className="hot-past"><HotMark/>Từng là Hot Lead khi QLead tìm thấy. Bài không còn trong khung giờ cần liên hệ sớm.</p>;
  if (!hot) return null;
  const until = hotUntil(hot);
  return <section className="hot-callout" aria-label="Hot Lead">
    <div className="hot-callout-head"><HotTag/><b>Khách hàng đang có nhu cầu rõ ràng</b></div>
    <p className="hot-callout-reason">{hotReason(hot)}</p>
    <p className="hot-callout-meta"><HotPosted lead={lead} now={now}/>{until && <span>Nên liên hệ trước {until}</span>}</p>
  </section>;
}

/**
 * The Hot Leads that are live right now, above the ordinary list (Today and the lead list). Ordinary leads stay
 * exactly where they were. At most three are expanded; the rest are one link away.
 *
 * Celebration: the first time this device sees a given Hot Lead, the band greets it once (goat + a soft warm glow and
 * one sentence). It never replays on refresh or route changes (ids are remembered per device), never while the
 * customer has another lead open (`busy`), and has no motion with prefers-reduced-motion.
 */
export function HotLeadBand({ leads, now, profileId, busy = false, onOpen, compact = false }: {
  leads: Lead[]; now: number; profileId?: string; busy?: boolean; onOpen?: (id: string) => void; compact?: boolean;
}) {
  const [celebrating, setCelebrating] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const ids = leads.map(lead => lead.id).join(',');
  const router = useRouter();
  // A Hot Lead push received while QLead is open brings it into this page now (not while another lead is open).
  useEffect(() => {
    if (busy || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => { if (event.data?.type === 'qlead:push' && event.data.kind === 'hot_lead') router.refresh(); };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [busy, router]);
  useEffect(() => {
    if (!ids || busy) return;
    const fresh = claimCelebration(ids.split(','));
    if (!fresh.length) return;
    setGreeted(true);
    if (prefersReducedMotion()) return;
    setCelebrating(true);
    const timer = window.setTimeout(() => setCelebrating(false), 2400);
    return () => window.clearTimeout(timer);
  }, [ids, busy]);

  if (!leads.length) return null;
  const shown = leads.slice(0, compact ? 2 : 3);
  return <section className={`hot-band ${celebrating ? 'is-celebrating' : ''}`} aria-labelledby="hot-band-title">
    <header className="hot-band-head">
      {greeted && <span className="hot-band-goat"><GoatMascot size="xs" animate={celebrating}/></span>}
      <div>
        <h2 id="hot-band-title"><HotMark/>{leads.length === 1 ? 'Có 1 Hot Lead nên xem ngay' : `Có ${leads.length} Hot Lead nên xem ngay`}</h2>
        <p role="status">{greeted ? 'Chúc mừng! QLead vừa tìm thấy khách hàng đang có nhu cầu rõ ràng. Liên hệ sớm để có lợi thế.' : 'Bài đăng còn rất mới và nêu rõ nhu cầu. Liên hệ sớm để có lợi thế.'}</p>
      </div>
    </header>
    <ul className="hot-band-list">{shown.map(lead => {
      const hot = activeHot(lead, now, profileId)!;
      return <HotRow key={lead.id} lead={lead} hot={hot} now={now} onOpen={onOpen}/>;
    })}</ul>
    {leads.length > shown.length && <Link className="hot-band-more" href="/app/bai-viet?hot=1">Xem cả {leads.length} Hot Lead <Icon name="arrow" size={15}/></Link>}
    <HotInstallLine/>
  </section>;
}

function HotRow({ lead, hot, now, onOpen }: { lead: Lead; hot: HotLeadAssessment; now: number; onOpen?: (id: string) => void }) {
  const open = `/app/bai-viet/${encodeURIComponent(lead.id)}`;
  return <li className="hot-row">
    <div className="hot-row-main">
      <p className="hot-row-top"><b>{leadName(lead)}</b><HotPosted lead={lead} now={now}/></p>
      <p className="hot-row-reason">{hotReason(hot)}</p>
    </div>
    <div className="hot-row-actions">
      {lead.original_url && <a className="btn btn-primary btn-sm" href={lead.original_url} target="_blank" rel="noopener noreferrer"
        onClick={() => reportSourceOpen(lead.id)} aria-label={`Xem bài Facebook của ${leadName(lead)} (mở tab mới)`}>Xem bài Facebook<Icon name="external" size={14}/></a>}
      {onOpen
        ? <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpen(lead.id)}>Mở lead</button>
        : <Link className="btn btn-outline btn-sm" href={open}>Mở lead</Link>}
    </div>
  </li>;
}

/**
 * Why install, said at the moment it matters: next to a real Hot Lead, never before the customer has seen one. Not
 * shown inside the installed app; "Để sau" hides it on this device. The button reuses the one install flow
 * (Chromium's own dialog, or short Add to Home Screen steps elsewhere).
 */
// Shares the dismissal of the Today install hint: one "Để sau" quiets both.
const INSTALL_DISMISSED = DISMISSED_KEY;
function HotInstallLine() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try { dismissed = Boolean(window.localStorage.getItem(INSTALL_DISMISSED)); } catch { dismissed = true; }
    setShow(!dismissed && !isStandalone());
  }, []);
  if (!show) return null;
  const hide = () => { try { window.localStorage.setItem(INSTALL_DISMISSED, new Date().toISOString()); } catch { /* ignore */ } setShow(false); };
  return <div className="hot-install">
    <div><b>Đừng bỏ lỡ Hot Lead</b><span>Cài QLead trên điện thoại để nhận thông báo khi có khách hàng cần tiếp cận sớm.</span></div>
    <div className="hot-install-actions">
      <InstallButton className="btn btn-outline btn-sm" onOutcome={outcome => { if (outcome === 'accepted') hide(); }}>Cài QLead</InstallButton>
      <button type="button" className="btn btn-ghost btn-sm" onClick={hide}>Để sau</button>
    </div>
  </div>;
}
