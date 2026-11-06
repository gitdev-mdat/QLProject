'use client';

import { useEffect, useState } from 'react';
import { Icon } from './visuals';

/**
 * Hero animation: a Facebook feed scrolls past a scan line; posts and Reels that carry a business signal for the
 * tracked description light up and drop into a "new opportunities" list. Several matches never contain the word
 * "khai trương", which is the point: QLead searches by signal, not one keyword. Every post is fictional and the
 * scene is labelled as an illustration. Only formats social.search is verified to return (posts, Reels) appear.
 */
type Kind = 'Bài đăng' | 'Reel';
type Post = { author: string; kind: Kind; text: string; lead?: { signal: string; area: string } };
const posts: Post[] = [
  { author: 'Minh Thư', kind: 'Bài đăng', text: 'Quán cafe của mình sắp khai trương ở Thủ Đức, cần tìm phần mềm tính tiền.', lead: { signal: 'Sắp khai trương', area: 'Thủ Đức' } },
  { author: 'Gia Huy', kind: 'Bài đăng', text: 'Cuối tuần này cả nhóm đi Đà Lạt, ai đi chung không?' },
  { author: 'Hoàng Yến', kind: 'Reel', text: 'Mới nhận mặt bằng, đang sửa sang tiệm trà sữa, tháng sau gặp mọi người nha.', lead: { signal: 'Thuê mặt bằng', area: 'Quận 7' } },
  { author: 'Tuấn Anh', kind: 'Bài đăng', text: 'Pass lại xe máy cũ, giá mềm cho bạn nào cần.' },
  { author: 'Thu Hằng', kind: 'Bài đăng', text: 'Tuyển 6 bạn phục vụ cho quán nướng sắp mở ở Gò Vấp.', lead: { signal: 'Tuyển người', area: 'Gò Vấp' } },
  { author: 'Bảo Ngọc', kind: 'Reel', text: 'Review quán bún bò ngon ở quận 3, ai thích thì ghé nha.' },
  { author: 'Ngọc Trâm', kind: 'Bài đăng', text: 'Chuỗi chè Hạ mở thêm cơ sở thứ ba ở Bình Thạnh.', lead: { signal: 'Mở chi nhánh', area: 'Bình Thạnh' } },
  { author: 'Khánh Linh', kind: 'Bài đăng', text: 'Có ai có kinh nghiệm nuôi mèo con chỉ mình với.' },
];
const VISIBLE = 5;
const SCAN_ROW = 2;
const STEP_MS = 1500;

type Found = { key: number; author: string; kind: Kind; signal: string; area: string };

export function HeroScene() {
  const [step, setStep] = useState(0);
  const [found, setFound] = useState<Found[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFound(posts.filter(post => post.lead).slice(0, 3).map((post, index) => ({ key: index, author: post.author, kind: post.kind, ...post.lead! })));
      setTotal(3);
      return;
    }
    const timer = window.setInterval(() => setStep(value => value + 1), STEP_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The post under the scan line is evaluated once per step.
  useEffect(() => {
    const post = posts[(step + SCAN_ROW) % posts.length];
    if (!post.lead || step === 0) return;
    setFound(current => [{ key: step, author: post.author, kind: post.kind, ...post.lead! }, ...current].slice(0, 3));
    setTotal(value => value + 1);
  }, [step]);

  // One extra row above (sliding out) and one below (sliding in), so the feed never shows a gap mid-move.
  const rows = Array.from({ length: VISIBLE + 2 }, (_, offset) => step + offset - 1);
  return <div className="scan-scene" aria-hidden="true">
    <div className="scan-window">
      <div className="scan-window-bar">
        <span className="scan-dots"><i/><i/><i/></span>
        <span className="scan-window-title">Theo dõi: quán F&amp;B sắp mở</span>
        <span className="scan-live"><span className="scan-live-dot"/>Đang quét</span>
      </div>
      <div className="scan-feed">
        {rows.map((absolute, slot) => {
          const index = slot - 1;
          const post = posts[((absolute % posts.length) + posts.length) % posts.length];
          const scanning = index === SCAN_ROW;
          const matched = scanning && Boolean(post.lead) && step > 0;
          return <div key={absolute} className={`scan-post ${scanning ? 'is-scanning' : ''} ${matched ? 'is-match' : ''}`} style={{ transform: `translateY(${index * 100}%)` }}>
            <span className="scan-avatar">{post.author[0]}</span>
            <div><b>{post.author}<span className={`kind-badge ${post.kind === 'Reel' ? 'is-reel' : ''}`}>{post.kind}</span></b><p>{post.text}</p></div>
            {matched && <span className="scan-tag">Có dấu hiệu</span>}
          </div>;
        })}
        <div className="scan-beam" style={{ top: `${SCAN_ROW * 20}%` }}/>
      </div>
    </div>

    <div className="scan-found">
      <div className="scan-found-head"><Icon name="spark" size={16}/>Cơ hội mới<span>{total}</span></div>
      <ul>
        {found.length === 0 && <li className="scan-found-empty">Đang chờ bài có dấu hiệu…</li>}
        {found.map(item => <li key={item.key}><b>{item.author} <small>· {item.kind}</small></b><span>{item.signal} · {item.area}</span></li>)}
      </ul>
    </div>

    <div className="scan-cadence"><span className="scene-radar"><Icon name="radar" size={16}/></span>Tự quét lại mỗi 30 phút</div>
    <span className="scan-caption">Minh họa</span>
  </div>;
}
