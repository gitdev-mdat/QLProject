'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { usePathname } from 'next/navigation';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';
import { draftHasAnswer, emptyDraft, feedbackHint, invitationRequest, sendFeedback, type FeedbackDraft } from '@/lib/feedback-client';
import './customer-feedback.css';

const EASE_LABELS = ['Rất khó dùng', 'Khó dùng', 'Tạm được', 'Dễ dùng', 'Rất dễ dùng'];
const NEEDS_LABELS = ['Chưa đáp ứng', 'Đáp ứng ít', 'Tạm được', 'Đáp ứng tốt', 'Rất tốt'];

/** Pages where an invitation would not interrupt a task: Today, the lead list and the scan history. */
const CALM_ROUTES = new Set(['/app', '/app/bai-viet', '/app/lich-su-quet']);
/** First wait after the app loads, so the customer sees their leads before anything else appears. */
const SETTLE_MS = 8_000;
/** Recent typing or tapping means the customer is in the middle of something. */
const QUIET_MS = 3_000;
const CHECK_EVERY_MS = 2_000;
const THANKS_CLOSE_MS = 6_000;

function newSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Another dialog, the install hint, the first-search scene or a focused field: not a natural moment. */
function somethingElseOnScreen(own: Element | null): boolean {
  const busy = document.querySelector('[aria-modal="true"], dialog[open], .install-hint, .discovery-scene');
  if (busy && !own?.contains(busy)) return true;
  const active = document.activeElement as HTMLElement | null;
  if (active && !own?.contains(active) && (active.matches('input, textarea, select') || active.isContentEditable)) return true;
  return false;
}

/** 1–5 stars as a radio group: tap/click a star, or arrow keys. Every star has a word, so the scale is never guesswork. */
function StarRating({ label, value, onChange, words, disabled }: { label: string; value: number | null; onChange: (value: number) => void; words: string[]; disabled: boolean }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hover ?? value;
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = Math.min(5, Math.max(1, (value ?? (delta > 0 ? 0 : 6)) + delta));
    onChange(next);
    refs.current[next - 1]?.focus();
  }
  return <fieldset className="fb-question">
    <legend id={`${id}-q`}>{label}</legend>
    <div className="fb-stars" role="radiogroup" aria-labelledby={`${id}-q`} onKeyDown={onKey} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map(star => <button key={star} ref={node => { refs.current[star - 1] = node; }} type="button" role="radio" disabled={disabled}
        aria-checked={value === star} aria-label={`${star} sao: ${words[star - 1]}`} tabIndex={(value ?? 1) === star ? 0 : -1}
        className={`fb-star ${shown !== null && star <= shown ? 'is-on' : ''}`} onClick={() => onChange(star)} onMouseEnter={() => setHover(star)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9-4.4-4.1 6-.8z"/></svg>
      </button>)}
    </div>
    <p className="fb-star-word" aria-hidden="true">{shown ? words[shown - 1] : 'Chọn từ 1 đến 5 sao'}</p>
  </fieldset>;
}

/** Hearts drift up once around the goat; nothing moves with prefers-reduced-motion (CSS). */
function Thanks({ onClose, autoClose }: { onClose: () => void; autoClose: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    if (!autoClose || paused) return;
    const timer = window.setTimeout(onClose, THANKS_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [autoClose, paused, onClose]);
  // Hovering keeps it open for as long as the pointer stays; the focus moved here on purpose does not count as interest.
  return <div className="fb-thanks" ref={ref} tabIndex={-1} role="status" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    <div className="fb-thanks-art" aria-hidden="true">
      <GoatMascot size="xs"/>
      {[0, 1, 2, 3, 4].map(i => <svg key={i} className={`fb-heart h${i}`} viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>)}
    </div>
    <h2 className="fb-title">Cảm ơn bạn đã góp ý!</h2>
    <p>Mỗi chia sẻ đều giúp QLead ngày càng hữu ích hơn.</p>
    <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Đóng</button>
  </div>;
}

/**
 * The three questions. Nothing is required except "something": a single star, or only a sentence, is a valid answer.
 * The reason field opens by itself for 1–3 stars on question 2 and stays one tap away otherwise. The answers stay in
 * place on any failure; the thank-you appears only after the server confirmed the save.
 */
function FeedbackForm({ context, titleId, onSaved, onClose }: { context: 'invitation' | 'voluntary'; titleId: string; onSaved: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState<FeedbackDraft>(emptyDraft);
  const [state, setState] = useState<'idle' | 'sending' | 'error' | 'rate_limited'>('idle');
  const [reasonOpen, setReasonOpen] = useState(false);
  const submissionId = useRef(newSubmissionId());
  const sending = state === 'sending';
  const showReason = reasonOpen || (draft.needsRating !== null && draft.needsRating <= 3) || Boolean(draft.unmetReason);
  const set = <K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]) => { setDraft(current => ({ ...current, [key]: value })); if (state !== 'sending') setState('idle'); };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !draftHasAnswer(draft)) return;
    setState('sending');
    const outcome = await sendFeedback(submissionId.current, context, draft);
    if (outcome === 'saved') { onSaved(); return; }
    setState(outcome === 'rate_limited' ? 'rate_limited' : 'error');
  }

  return <form className="fb-form" onSubmit={submit} aria-busy={sending} noValidate>
    <div className="fb-head">
      <h2 className="fb-title" id={titleId}>Góp ý cho QLead</h2>
      <p className="fb-sub">3 câu ngắn, câu nào cũng có thể bỏ qua.</p>
    </div>
    <StarRating label="Giao diện QLead có dễ hiểu, dễ sử dụng không?" value={draft.easeRating} onChange={value => set('easeRating', value)} words={EASE_LABELS} disabled={sending}/>
    <StarRating label="QLead có đáp ứng nhu cầu tìm khách hàng của bạn không?" value={draft.needsRating} onChange={value => set('needsRating', value)} words={NEEDS_LABELS} disabled={sending}/>
    {showReason
      ? <label className="fb-field"><span>Điểm nào QLead chưa đáp ứng tốt? <small>(không bắt buộc)</small></span>
        <textarea rows={2} maxLength={1000} value={draft.unmetReason} disabled={sending} onChange={event => set('unmetReason', event.target.value)} placeholder="Ví dụ: lead chưa đúng khu vực, cần thêm số điện thoại…"/></label>
      : <button type="button" className="fb-more" onClick={() => setReasonOpen(true)} disabled={sending}>+ Thêm điều QLead chưa đáp ứng tốt</button>}
    <label className="fb-field"><span>Bạn muốn QLead cải tiến hoặc bổ sung điều gì? <small>(không bắt buộc)</small></span>
      <textarea rows={2} maxLength={2000} value={draft.improvement} disabled={sending} onChange={event => set('improvement', event.target.value)}/></label>
    {state === 'error' && <p className="fb-error" role="alert"><Icon name="info" size={16}/>Chưa gửi được. Câu trả lời của bạn vẫn còn đây, hãy thử lại.</p>}
    {state === 'rate_limited' && <p className="fb-error" role="alert"><Icon name="info" size={16}/>Bạn đã gửi nhiều góp ý hôm nay. Hãy thử lại vào ngày mai nhé.</p>}
    <div className="fb-actions">
      <button type="submit" className="btn btn-primary" disabled={sending || !draftHasAnswer(draft)}>
        {sending ? <><span className="fb-spinner" aria-hidden="true"/>Đang gửi…</> : state === 'error' ? 'Thử gửi lại' : 'Gửi góp ý'}
      </button>
      {context === 'voluntary' && <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>Hủy</button>}
    </div>
  </form>;
}

function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className="fb-close" onClick={onClick} aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
  </button>;
}

type Stage = 'waiting' | 'invite' | 'form' | 'thanks' | 'gone';

/**
 * The one automatic invitation. Mounted once in the /app frame. It waits for a calm moment on a calm page, then asks the
 * server, which shows it to at most one tab of one device per account and only when the customer is eligible. X, "Không,
 * cảm ơn" and a submitted answer are final on the server; the browser hint only saves a request on later visits.
 */
export function FeedbackInvite({ owner, suspended }: { owner: string | null; suspended: boolean }) {
  const path = usePathname();
  const [stage, setStage] = useState<Stage>('waiting');
  const [calm, setCalm] = useState(true);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const pathRef = useRef(path);
  pathRef.current = path;

  // Find a natural moment, then claim. One claim per page load; nothing at all once the account said "never".
  useEffect(() => {
    if (stage !== 'waiting' || suspended) return;
    if (feedbackHint.isDone(owner)) { setStage('gone'); return; }
    let lastInput = Date.now();
    let cancelled = false;
    let timer = 0;
    const touched = () => { lastInput = Date.now(); };
    window.addEventListener('pointerdown', touched, { passive: true });
    window.addEventListener('keydown', touched);
    const check = async () => {
      if (cancelled) return;
      const ready = document.visibilityState === 'visible' && CALM_ROUTES.has(pathRef.current) && Date.now() - lastInput >= QUIET_MS && !somethingElseOnScreen(null);
      if (!ready) { timer = window.setTimeout(check, CHECK_EVERY_MS); return; }
      const result = await invitationRequest({ action: 'claim', token: feedbackHint.claimToken() });
      if (cancelled) return;
      if (result?.show && result.token) { feedbackHint.setClaimToken(result.token); setStage('invite'); return; }
      if (result?.final) feedbackHint.markDone(owner);
      setStage('gone');
    };
    timer = window.setTimeout(check, SETTLE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('pointerdown', touched); window.removeEventListener('keydown', touched); };
  }, [stage, suspended, owner]);

  // While shown, step aside (without answering) on busy pages or under another dialog, and come back afterwards.
  useEffect(() => {
    if (stage !== 'invite' && stage !== 'form') return;
    // An Admin hold while the invitation is open hides it too; no answer is recorded.
    const update = () => setCalm(!suspended && !somethingElseOnScreen(panel.current) && !(stage === 'invite' && !CALM_ROUTES.has(pathRef.current)));
    update();
    const timer = window.setInterval(update, 700);
    return () => window.clearInterval(timer);
  }, [stage, path, suspended]);

  const decline = useCallback(() => {
    setStage('gone');
    feedbackHint.markDone(owner);
    feedbackHint.setClaimToken(null);
    void invitationRequest({ action: 'decline' });
  }, [owner]);
  const saved = useCallback(() => { feedbackHint.markDone(owner); feedbackHint.setClaimToken(null); setStage('thanks'); }, [owner]);
  const finish = useCallback(() => setStage('gone'), []);

  useEffect(() => {
    if (stage !== 'form') return;
    panel.current?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
  }, [stage]);

  if (stage === 'waiting' || stage === 'gone') return null;
  const hidden = !calm && stage !== 'thanks';
  return <section ref={panel} className={`fb-panel is-${stage}${hidden ? ' is-away' : ''}`} role="dialog" aria-modal="false" aria-labelledby={titleId} aria-hidden={hidden || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && stage !== 'thanks') { event.stopPropagation(); decline(); } }}>
    {stage !== 'thanks' && <CloseButton onClick={decline} label="Đóng, QLead sẽ không hỏi lại"/>}
    {stage === 'invite' && <div className="fb-invite">
      <span className="fb-invite-goat" aria-hidden="true"><GoatMascot size="xs" animate={false}/></span>
      <div>
        <h2 className="fb-title" id={titleId}>Bạn thấy QLead thế nào?</h2>
        <p>Bạn đã dùng QLead với các lead thật được một thời gian. Dành khoảng 30 giây góp ý để QLead hữu ích hơn nhé?</p>
        <div className="fb-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setStage('form')}>Góp ý</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={decline}>Không, cảm ơn</button>
        </div>
        <p className="fb-note">QLead chỉ hỏi một lần.</p>
      </div>
    </div>}
    {stage === 'form' && <FeedbackForm context="invitation" titleId={titleId} onSaved={saved} onClose={decline}/>}
    {stage === 'thanks' && <><span className="sr-only" id={titleId}>Cảm ơn</span><Thanks onClose={finish} autoClose/></>}
  </section>;
}

/** "Góp ý cho QLead": the customer's own way to send feedback at any time. Never triggers anything automatically. */
export function FeedbackEntry({ owner, className = '', children }: { owner: string | null; className?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useCallback(() => { setOpen(false); setDone(false); trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);
  return <>
    <button ref={trigger} type="button" className={className || 'fb-entry'} onClick={() => setOpen(true)}>{children ?? <><Icon name="edit" size={16}/>Góp ý cho QLead</>}</button>
    {open && <div className="fb-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} className="fb-panel is-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {!done && <CloseButton onClick={close} label="Đóng"/>}
        {done
          ? <><span className="sr-only" id={titleId}>Cảm ơn</span><Thanks onClose={close} autoClose={false}/></>
          : <FeedbackForm context="voluntary" titleId={titleId} onSaved={() => { feedbackHint.markDone(owner); setDone(true); }} onClose={close}/>}
      </div>
    </div>}
  </>;
}
