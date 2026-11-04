'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './visuals';

/** Sticky nav gains a border and shadow once the page scrolls. */
export function NavScrollState() {
  useEffect(() => {
    const nav = document.querySelector('.site-nav');
    if (!nav) return;
    const update = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  return null;
}

const fields = [
  { key: 'need', icon: 'spark', title: 'Nội dung bài' },
  { key: 'signal', icon: 'target', title: 'Tín hiệu kinh doanh' },
  { key: 'author', icon: 'user', title: 'Người đăng' },
  { key: 'area', icon: 'pin', title: 'Khu vực' },
  { key: 'time', icon: 'clock', title: 'Thời gian đăng' },
  { key: 'phone', icon: 'phone', title: 'Số liên hệ' },
] as const;
type FieldKey = typeof fields[number]['key'];

/**
 * Sample lead card linked to its field list: the active field is highlighted in the card. Cycles while the
 * section is on screen; hovering or focusing a field takes over.
 */
export function AnatomyShowcase() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (visible) setSeen(true); }, [visible]);

  useEffect(() => {
    const element = root.current;
    if (!element || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.3 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setActive(value => (value + 1) % fields.length), 1800);
    return () => window.clearInterval(timer);
  }, [visible, paused]);

  const on = (key: FieldKey) => fields[active].key === key ? 'is-lit' : '';
  return <div className="anatomy-layout" ref={root} onMouseLeave={() => setPaused(false)}>
    <article className="anatomy-card" aria-label="Ví dụ một lead" data-reveal>
      <div className="anatomy-card-top">
        <ul className={`signal-chips ${on('signal')}`}><li>Sắp mở cửa</li><li>Đang tuyển nhân sự</li></ul>
        <span className={`freshness is-fresh ${on('time')}`}><Icon name="clock" size={14}/>22 phút trước</span>
      </div>
      <p className={`anatomy-need ${on('need')}`}>Quán cafe Mây chuẩn bị khai trương ở TP.HCM, ngay trung tâm Quận 3.</p>
      <ul>
        <li className={on('author')}><Icon name="user" size={16}/>Minh Thư · Việc làm F&amp;B Sài Gòn</li>
        <li className={on('area')}><Icon name="pin" size={16}/>TP.HCM</li>
        <li className={on('phone')}><Icon name="phone" size={16}/>0900 000 128</li>
      </ul>
      <div className="anatomy-actions"><span className="btn btn-sm btn-primary" aria-hidden="true">Mở bài Facebook <Icon name="external" size={14}/></span><span className="btn btn-sm btn-outline" aria-hidden="true">Lưu lead</span></div>
    </article>
    <ul className="anatomy-list">{fields.map((item, index) => <li key={item.key} data-reveal style={{ transitionDelay: `${index * 80}ms` }}
      // React owns className here, so it carries is-visible itself (RevealOnScroll's class would be overwritten).
      className={`${seen ? 'is-visible' : ''} ${index === active ? 'is-active' : ''}`} tabIndex={0}
      onMouseEnter={() => { setPaused(true); setActive(index); }} onFocus={() => { setPaused(true); setActive(index); }} onBlur={() => setPaused(false)}>
      <span className="anatomy-icon"><Icon name={item.icon} size={20}/></span><h3>{item.title}</h3>
    </li>)}</ul>
  </div>;
}
