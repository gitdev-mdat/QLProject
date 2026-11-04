'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { extractContactFromPost, extractLocationFromPost, extractNeedFromPost } from '../../src/lead-data';
import { demoLeadsFor, personaForRequest, type DemoLead, type PersonaId } from '@/lib/demo-data';
import { readLead } from '@/lib/lead-format';
import { GoatMascot } from './goat-mascot';
import { Icon } from './visuals';

type Phase = 'searching' | 'found' | 'no-sample';

/** Example requests. They only fill the input; the user can rewrite them for any industry. */
const suggestions = [
  { label: 'Phần mềm bán hàng', text: 'Tôi bán phần mềm quản lý bán hàng, muốn tìm shop thời trang, mỹ phẩm sắp mở bán hoặc mở thêm chi nhánh.' },
  { label: 'Thiết bị quán cafe', text: 'Tôi bán thiết bị và thi công quán, muốn tìm quán ăn uống mới thuê mặt bằng hoặc sắp khai trương ở miền Nam.' },
  { label: 'Phần mềm khách sạn', text: 'Tôi bán phần mềm quản lý khách sạn, muốn tìm khách sạn, homestay sắp đi vào hoạt động hoặc mở thêm cơ sở.' },
];
const defaultRequest = 'Tôi bán phần mềm quản lý quán, muốn tìm những quán F&B sắp khai trương, đang tuyển người hoặc mở chi nhánh.';


function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} phút trước`;
  return `${Math.floor(minutes / 60)} giờ trước`;
}


function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function DemoLeadCard({ lead, index }: { lead: DemoLead; index: number }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const reading = readLead(lead.text, extractNeedFromPost(lead.text));
  const area = extractLocationFromPost(lead.text);
  const contact = extractContactFromPost(lead.text);
  const isFresh = lead.postedMinutesAgo < 60;

  return <li className="demo-lead" style={{ animationDelay: `${index * 110}ms` }}>
    <div className="demo-lead-top">
      <ul className="signal-chips" aria-label="Tín hiệu trong bài">{reading.signals.slice(0, 2).map(signal => <li key={signal}>{signal}</li>)}</ul>
      <span className={`freshness ${isFresh ? 'is-fresh' : ''}`}><Icon name="clock" size={14}/>Đăng {minutesLabel(lead.postedMinutesAgo)}</span>
    </div>
    <p className="demo-lead-need">{reading.evidence}</p>
    <div className="demo-lead-meta">
      <span><Icon name="user" size={15}/>{lead.author} · <span className="muted-text">{lead.group}</span></span>
      <span className={area.location ? '' : 'muted-text'}><Icon name="pin" size={15}/>{area.location ?? 'Bài chưa nêu rõ khu vực'}</span>
      {contact ? <span className="has-contact"><Icon name="phone" size={15}/>{contact.number}</span> : <span className="muted-text"><Icon name="phone" size={15}/>Bài không ghi số</span>}
    </div>
    {open && <blockquote className="demo-lead-post" id={`demo-post-${lead.id}`}>{lead.text}<small>QLead phát hiện {minutesLabel(lead.detectedMinutesAgo)}</small></blockquote>}
    <div className="demo-lead-actions">
      <button type="button" className="btn btn-sm btn-outline" aria-expanded={open} aria-controls={`demo-post-${lead.id}`} onClick={() => setOpen(value => !value)}>{open ? 'Thu gọn' : 'Xem bài đầy đủ'}</button>
      <button type="button" className={`btn btn-sm ${saved ? 'btn-saved' : 'btn-ghost'}`} aria-pressed={saved} onClick={() => setSaved(value => !value)}><Icon name="bookmark" size={15}/>{saved ? 'Đã lưu' : 'Lưu'}</button>
    </div>
  </li>;
}

export function HeroDemo() {
  const [request, setRequest] = useState(defaultRequest);
  const [persona, setPersona] = useState<PersonaId | null>('pos_fnb');
  const [phase, setPhase] = useState<Phase>('found');
  const [runId, setRunId] = useState(0);
  const timer = useRef<number | null>(null);
  const typing = useRef<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (typing.current) window.clearInterval(typing.current);
  }, []);

  function show(nextPersona: PersonaId | null) {
    setPersona(nextPersona);
    setRunId(value => value + 1);
    if (timer.current) window.clearTimeout(timer.current);
    if (!nextPersona) { setPhase('no-sample'); return; }
    if (prefersReducedMotion()) { setPhase('found'); return; }
    setPhase('searching');
    timer.current = window.setTimeout(() => setPhase('found'), 700);
  }

  function analyse(text: string) {
    show(personaForRequest(text));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request.trim()) { inputRef.current?.focus(); return; }
    analyse(request);
  }

  /** Types the example into the input, then searches, so it reads like a real request. */
  function applySuggestion(text: string) {
    if (typing.current) window.clearInterval(typing.current);
    inputRef.current?.focus();
    if (prefersReducedMotion()) { setRequest(text); analyse(text); return; }
    let length = 0;
    typing.current = window.setInterval(() => {
      length = Math.min(text.length, length + 3);
      setRequest(text.slice(0, length));
      if (length === text.length) {
        window.clearInterval(typing.current!);
        typing.current = null;
        analyse(text);
      }
    }, 16);
  }


  // Two sample leads keep the results column about as tall as the input column.
  const leads = persona ? demoLeadsFor(persona).slice(0, 2) : [];

  return <div className="demo">
    <div className="demo-side">
      <form className="demo-search" onSubmit={submit}>
        <div className="demo-side-head">
          <h3 id="demo-request-label">Bạn muốn tìm khách hàng nào?</h3>
        </div>
        <textarea id="demo-request" ref={inputRef} rows={4} maxLength={300} value={request} onChange={event => setRequest(event.target.value)} aria-labelledby="demo-request-label" placeholder={defaultRequest}/>
        <div className="suggestions" role="group" aria-label="Gợi ý mô tả">
          <span>Gợi ý:</span>
          {suggestions.map(item => <button key={item.label} type="button" onClick={() => applySuggestion(item.text)}>{item.label}</button>)}
        </div>
        <button type="submit" className="btn btn-primary full">Tìm khách hàng <Icon name="arrow" size={16}/></button>
      </form>

    </div>

    <div className="demo-results">
      <div className="demo-results-head" aria-live="polite">
        <span className="goat-badge"><GoatMascot size="xs"/></span>
        <div>
          <b>{phase === 'searching' ? 'Đang lọc bài đăng phù hợp…' : phase === 'found' ? `${leads.length} lead mẫu` : 'Đã hiểu mô tả của bạn'}</b>
          {phase === 'no-sample' && <span>Bản demo chưa có bài mẫu cho ngành này</span>}
        </div>
      </div>
      {phase === 'searching' && <div className="demo-progress" aria-hidden="true"><i/></div>}
      {phase === 'searching' && <ul className="demo-lead-list" aria-hidden="true">{[0, 1].map(index => <li key={index} className="skeleton-item"><span/><span/><span/></li>)}</ul>}
      {phase === 'found' && <ul className="demo-lead-list" key={runId}>{leads.map((lead, index) => <DemoLeadCard key={lead.id} lead={lead} index={index}/>)}</ul>}
      {phase === 'no-sample' && <div className="demo-empty">
        <p>Khi dùng thật, QLead theo dõi bài đăng theo đúng điều kiện bạn vừa mô tả. Bản demo chỉ có một ít bài mẫu nên chưa có kết quả cho ngành này.</p>
        <p className="muted-text">Bấm một gợi ý bên trái để xem một lead trông như thế nào.</p>
      </div>}
      <div className="demo-results-foot">
        <Link href="/app/bai-viet" className="text-link">Mở bảng lead mẫu <Icon name="arrow" size={16}/></Link>
      </div>
    </div>
  </div>;
}
