'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { LANDING_QUERY_MIN, type LandingPreviewLead } from '@/lib/landing-search';
import { saveLandingHandoff, trackLanding, type LandingFailure, type LandingSearchResponse, type LandingTrigger } from '@/lib/landing-client';
import { relativeTime } from '@/lib/lead-format';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';

/** Example requests. They only fill the input; the visitor can rewrite them for any industry. */
const suggestions = [
  { label: 'Phần mềm quán cafe', text: 'Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán cà phê sắp khai trương ở TP.HCM.' },
  { label: 'Thiết bị nhà hàng', text: 'Tôi bán thiết bị và thi công quán, muốn tìm quán ăn, nhà hàng sắp khai trương hoặc mới thuê mặt bằng ở miền Nam.' },
  { label: 'Phần mềm khách sạn', text: 'Tôi bán phần mềm quản lý khách sạn, muốn tìm khách sạn, homestay sắp đi vào hoạt động hoặc mở thêm cơ sở.' },
];
const defaultRequest = 'Tôi bán phần mềm quản lý quán, muốn tìm những quán F&B sắp khai trương, đang tuyển người hoặc mở chi nhánh.';
/** Past this, the visitor sees "taking longer than usual" instead of an endless spinner. */
const CLIENT_TIMEOUT_MS = 8000;
/** A fast answer replaces the old one directly; the skeleton only appears when the wait is noticeable. */
const SKELETON_DELAY_MS = 180;
const SIGNUP_HREF = '/dang-ky?tu=thu-tim';
const LOGIN_HREF = '/dang-nhap?tiep=/app/thu-tim';

type Phase = 'idle' | 'searching' | 'found' | 'empty' | 'error';
type Full = { key: string; text: string; summarized: boolean; original: string | null; author: string | null; url: string | null; publishedAt: string | null; area: string | null; contact: string | null };

const FAILURES: Record<LandingFailure, { title: string; text: string }> = {
  timeout: { title: 'Tìm lâu hơn bình thường', text: 'Máy chủ chưa trả lời kịp. Bấm thử lại nhé.' },
  rate_limited: { title: 'Bạn vừa tìm nhiều lần liên tiếp', text: 'Đợi khoảng một phút rồi thử lại.' },
  overloaded: { title: 'QLead đang bận', text: 'Có nhiều người đang tìm cùng lúc. Thử lại sau vài giây.' },
  network: { title: 'Không kết nối được', text: 'Kiểm tra mạng rồi thử lại.' },
  server: { title: 'Chưa tìm được lúc này', text: 'Đã có lỗi phía QLead. Thử lại sau ít phút.' },
};

function failureOf(status: number): LandingFailure {
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'overloaded';
  return 'server';
}

function LeadCard({ lead, index, now, member, previewId, resultCount, unlock }: {
  lead: LandingPreviewLead; index: number; now: number; member: boolean; previewId: string; resultCount: number;
  unlock: () => Promise<Full[] | null>;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Full | null | 'error'>(null);
  const panelId = `demo-post-${previewId}-${lead.key}`;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    trackLanding('landing_preview_opened', { previewId, resultCount });
    if (member && full === null) {
      const leads = await unlock();
      setFull(leads?.find(item => item.key === lead.key) ?? 'error');
    }
  }

  return <li className="demo-lead" style={{ animationDelay: `${index * 90}ms` }}>
    <div className="demo-lead-top">
      {lead.signals.length > 0 ? <ul className="signal-chips" aria-label="Tín hiệu trong bài">{lead.signals.map(signal => <li key={signal}>{signal}</li>)}</ul> : <span/>}
      {lead.publishedAt && <span className={`freshness ${now - Date.parse(lead.publishedAt) < 86_400_000 ? 'is-fresh' : ''}`}><Icon name="clock" size={14}/>Đăng {relativeTime(lead.publishedAt, now).toLocaleLowerCase('vi')}</span>}
    </div>
    <p className="demo-lead-need">{lead.summarized && <span className="demo-lead-kind">QLead tóm tắt</span>}{lead.excerpt}</p>
    <div className="demo-lead-meta">
      <span><Icon name="radar" size={15}/>{lead.source}</span>
      {lead.area && <span><Icon name="pin" size={15}/>{lead.area}</span>}
      {lead.hasContact && <span className="has-contact"><Icon name="phone" size={15}/>Có số liên hệ trong bài</span>}
    </div>
    <p className="demo-lead-match"><Icon name="check" size={14}/>Phù hợp: {lead.match}</p>
    {member && open && <div className="demo-lead-post" id={panelId}>
      {full === null && <p className="muted-text">Đang mở…</p>}
      {full === 'error' && <p className="muted-text">Không mở được bài này. Bấm “Tìm khách hàng” để tìm lại.</p>}
      {full && full !== 'error' && <div className="demo-full">
        <p>{full.text}</p>
        {full.original && <details><summary>Nội dung gốc</summary><p>{full.original}</p></details>}
        <div className="demo-lead-meta">
          {full.author && <span><Icon name="user" size={15}/>{full.author}</span>}
          {full.contact && <span className="has-contact"><Icon name="phone" size={15}/>{full.contact}</span>}
        </div>
      </div>}
    </div>}
    <div className="demo-lead-actions">
      {/* The Facebook post is open to every visitor; signing up is for seeing more leads, not this one. */}
      {lead.url && <a className="btn btn-sm btn-outline" href={lead.url} target="_blank" rel="noopener noreferrer" onClick={() => trackLanding('landing_preview_opened', { previewId, resultCount })}>Xem bài trên Facebook <Icon name="external" size={15}/></a>}
      {member && <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} aria-controls={panelId} onClick={toggle}>{open ? 'Thu gọn' : 'Chi tiết'}</button>}
    </div>
  </li>;
}

export function HeroDemo() {
  const [request, setRequest] = useState(defaultRequest);
  const [phase, setPhase] = useState<Phase>('idle');
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [result, setResult] = useState<(LandingSearchResponse & { query: string }) | null>(null);
  const [failure, setFailure] = useState<LandingFailure | null>(null);
  const [hint, setHint] = useState('');
  const [now, setNow] = useState(0);
  const typing = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inflight = useRef<AbortController | null>(null);
  const unlocked = useRef<Map<string, Promise<Full[] | null>>>(new Map());
  const autoRan = useRef(false);

  useEffect(() => () => {
    if (typing.current) window.clearInterval(typing.current);
    inflight.current?.abort();
  }, []);

  const search = useCallback(async (text: string, trigger: LandingTrigger) => {
    const query = text.trim();
    if (query.length < LANDING_QUERY_MIN) { setHint('Viết vài chữ về khách hàng bạn muốn tìm.'); inputRef.current?.focus(); return; }
    setHint('');
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const started = performance.now();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, CLIENT_TIMEOUT_MS);
    const skeleton = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    setPhase('searching');
    setFailure(null);
    trackLanding('landing_search_started', { trigger });
    try {
      const response = await fetch('/api/landing/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined); // release the connection; the status says enough
        throw Object.assign(new Error('http'), { failure: failureOf(response.status) });
      }
      const data = await response.json() as LandingSearchResponse;
      if (controller.signal.aborted) return;
      const clientMs = performance.now() - started;
      setNow(Date.now());
      setResult({ ...data, query });
      setPhase(data.outcome === 'found' ? 'found' : 'empty');
      trackLanding(data.outcome === 'found' ? 'landing_search_results_shown' : 'landing_search_empty', { previewId: data.previewId, trigger, resultCount: data.leads.length, clientMs });
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return; // replaced by a newer search
      const reason: LandingFailure = timedOut ? 'timeout' : (error as { failure?: LandingFailure }).failure ?? 'network';
      setFailure(reason);
      setPhase('error');
      trackLanding('landing_search_failed', { trigger, reason, clientMs: performance.now() - started });
    } finally {
      window.clearTimeout(timeout);
      window.clearTimeout(skeleton);
      setShowSkeleton(false);
      if (inflight.current === controller) inflight.current = null;
    }
  }, []);

  // The example request runs once when the section comes into view, so the first thing a visitor sees is real leads.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || autoRan.current) return;
    const run = () => { if (!autoRan.current) { autoRan.current = true; void search(defaultRequest, 'auto'); } };
    if (!('IntersectionObserver' in window)) { run(); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); run(); } }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [search]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (typing.current) { window.clearInterval(typing.current); typing.current = null; }
    autoRan.current = true;
    void search(request, 'user');
  }

  /** Types the example into the input, then searches, so it reads like a real request. */
  function applySuggestion(text: string) {
    if (typing.current) window.clearInterval(typing.current);
    autoRan.current = true;
    inputRef.current?.focus();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setRequest(text); void search(text, 'suggestion'); return; }
    let length = 0;
    typing.current = window.setInterval(() => {
      length = Math.min(text.length, length + 4);
      setRequest(text.slice(0, length));
      if (length === text.length) {
        window.clearInterval(typing.current!);
        typing.current = null;
        void search(text, 'suggestion');
      }
    }, 14);
  }

  const unlock = useCallback((previewId: string) => {
    let pending = unlocked.current.get(previewId);
    if (!pending) {
      pending = fetch(`/api/landing/previews/${previewId}`).then(async response => {
        if (response.ok) return (await response.json() as { leads: Full[] }).leads;
        await response.body?.cancel().catch(() => undefined);
        return null;
      }).catch(() => null);
      unlocked.current.set(previewId, pending);
    }
    return pending;
  }, []);

  function rememberForSignup() {
    if (!result) return;
    saveLandingHandoff({ query: result.query, previewId: result.previewId, resultCount: result.leads.length, expiresAt: result.expiresAt });
    trackLanding('landing_signup_clicked', { previewId: result.previewId, resultCount: result.leads.length });
  }

  const leads = result?.leads ?? [];
  const member = Boolean(result?.member);
  const stale = phase === 'searching' && !showSkeleton;
  const headline = phase === 'searching' ? 'Đang tìm lead phù hợp…'
    : phase === 'found' ? `${leads.length} lead thật phù hợp`
      : phase === 'empty' ? 'Chưa có lead phù hợp lúc này'
        : phase === 'error' && failure ? FAILURES[failure].title
          : 'Mô tả khách hàng bạn cần';
  const subline = phase === 'found' ? 'Từ bài đăng Facebook QLead đã thu thập'
    : phase === 'searching' ? 'Trong các bài đăng QLead đã thu thập'
      : phase === 'idle' ? 'QLead trả về tối đa 2 lead thật để bạn xem thử' : null;

  return <div className="demo" ref={rootRef}>
    <div className="demo-side">
      <form className="demo-search" onSubmit={submit}>
        <div className="demo-side-head">
          <h3 id="demo-request-label">Bạn muốn tìm khách hàng nào?</h3>
        </div>
        <textarea id="demo-request" ref={inputRef} rows={4} maxLength={300} value={request} onChange={event => setRequest(event.target.value)} aria-labelledby="demo-request-label" aria-describedby={hint ? 'demo-hint' : undefined} placeholder={defaultRequest}/>
        {hint && <p className="demo-hint" id="demo-hint" role="alert">{hint}</p>}
        <div className="suggestions" role="group" aria-label="Gợi ý mô tả">
          <span>Gợi ý:</span>
          {suggestions.map(item => <button key={item.label} type="button" onClick={() => applySuggestion(item.text)}>{item.label}</button>)}
        </div>
        <button type="submit" className="btn btn-primary full" disabled={phase === 'searching'}>{phase === 'searching' ? 'Đang tìm…' : 'Tìm khách hàng'} {phase !== 'searching' && <Icon name="arrow" size={16}/>}</button>
      </form>
    </div>

    <div className="demo-results" aria-busy={phase === 'searching'}>
      <div className="demo-results-head" aria-live="polite">
        <span className="goat-badge"><GoatMascot size="xs"/></span>
        <div>
          <b>{headline}</b>
          {subline && <span>{subline}</span>}
        </div>
      </div>
      {phase === 'searching' && showSkeleton && <div className="demo-progress" aria-hidden="true"><i/></div>}
      {phase === 'searching' && showSkeleton && <ul className="demo-lead-list" aria-hidden="true">{[0, 1].map(index => <li key={index} className="skeleton-item"><span/><span/><span/></li>)}</ul>}
      {(phase === 'found' || (stale && result?.outcome === 'found')) && result && <ul className={`demo-lead-list ${stale ? 'is-stale' : ''}`} key={result.previewId}>
        {leads.map((lead, index) => <LeadCard key={lead.key} lead={lead} index={index} now={now} member={member} previewId={result.previewId}
          resultCount={leads.length} unlock={() => unlock(result.previewId)}/>)}
      </ul>}
      {phase === 'idle' && <div className="demo-empty"><p>Viết bạn bán gì và muốn tìm khách nào, hoặc bấm một gợi ý. QLead tìm trong các bài đăng Facebook đã thu thập và trả về lead thật, không phải bài mẫu.</p></div>}
      {(phase === 'empty' || (stale && result?.outcome === 'empty')) && <div className={`demo-empty ${stale ? 'is-stale' : ''}`}>
        <p>QLead chưa có bài nào trong 30 ngày qua khớp với mô tả này. Khi bạn tạo tài khoản, QLead bắt đầu tìm riêng trên Facebook theo đúng mô tả của bạn.</p>
        <p className="muted-text">Bạn cũng có thể thử một gợi ý bên trái, hoặc mô tả rộng hơn (bỏ bớt khu vực).</p>
      </div>}
      {phase === 'error' && failure && <div className="demo-empty">
        <p>{FAILURES[failure].text}</p>
        {failure !== 'rate_limited' && <button type="button" className="btn btn-sm btn-outline" onClick={() => search(request, 'user')}>Thử lại</button>}
      </div>}
      <div className="demo-results-foot">
        {member
          ? <><p>Bạn đang đăng nhập: mở từng lead để xem đầy đủ.</p><Link href="/app" className="text-link">Vào QLead <Icon name="arrow" size={16}/></Link></>
          : phase === 'found'
            ? <><p>Đăng ký miễn phí để xem thêm lead và nhận lead mới cho nhu cầu này.</p><Link href={SIGNUP_HREF} className="btn btn-primary demo-cta" onClick={rememberForSignup}>Xem thêm lead phù hợp <Icon name="arrow" size={16}/></Link></>
            : phase === 'empty'
              ? <><p>Miễn phí, không cần thanh toán.</p><Link href={SIGNUP_HREF} className="btn btn-primary demo-cta" onClick={rememberForSignup}>Đăng ký để QLead tìm cho bạn <Icon name="arrow" size={16}/></Link></>
              : <><p>Lead thật từ bài đăng Facebook.</p><Link href={SIGNUP_HREF} className="text-link">Tạo tài khoản miễn phí <Icon name="arrow" size={16}/></Link></>}
        {!member && (phase === 'found' || phase === 'empty') && result && <Link href={LOGIN_HREF} className="demo-login" onClick={() => saveLandingHandoff({ query: result.query, previewId: result.previewId, resultCount: result.leads.length, expiresAt: result.expiresAt })}>Đã có tài khoản? Đăng nhập</Link>}
      </div>
    </div>
  </div>;
}
