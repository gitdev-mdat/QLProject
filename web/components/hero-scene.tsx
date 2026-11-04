'use client';

import { useEffect, useState } from 'react';
import { Icon } from './visuals';

/**
 * Hero animation: a Facebook-style feed scrolls past a scan line; posts with a business signal light up and
 * drop into a "new leads" list. All posts are fictional and the scene is labelled as an illustration.
 */
type Post = { author: string; text: string; lead?: { signal: string; area: string } };
const posts: Post[] = [
  { author: 'Minh Thư', text: 'Quán cafe của mình sắp khai trương ở Thủ Đức, cần tìm phần mềm tính tiền.', lead: { signal: 'Sắp khai trương', area: 'TP.HCM' } },
  { author: 'Gia Huy', text: 'Cuối tuần này cả nhóm đi Đà Lạt, ai đi chung không?' },
  { author: 'Hoàng Yến', text: 'Chuỗi trà sữa Lá chuẩn bị mở chi nhánh thứ ba tại Bình Dương.', lead: { signal: 'Mở chi nhánh', area: 'Bình Dương' } },
  { author: 'Tuấn Anh', text: 'Pass lại xe máy cũ, giá mềm cho bạn nào cần.' },
  { author: 'Thu Hằng', text: 'Khách sạn mới ở Quảng Ninh sắp hoạt động, tuyển lễ tân và buồng phòng.', lead: { signal: 'Đang tuyển người', area: 'Quảng Ninh' } },
  { author: 'Bảo Ngọc', text: 'Review quán bún bò ngon ở quận 3, ai thích thì ghé nha.' },
  { author: 'Ngọc Trâm', text: 'Shop mỹ phẩm Hạ sắp khai trương tại Hải Phòng, đang tuyển nhân viên.', lead: { signal: 'Sắp khai trương', area: 'Hải Phòng' } },
  { author: 'Khánh Linh', text: 'Có ai có kinh nghiệm nuôi mèo con chỉ mình với.' },
];
const VISIBLE = 5;
const SCAN_ROW = 2;
const STEP_MS = 1500;

type Found = { key: number; author: string; signal: string; area: string };

export function HeroScene() {
  const [step, setStep] = useState(0);
  const [found, setFound] = useState<Found[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFound(posts.filter(post => post.lead).slice(0, 3).map((post, index) => ({ key: index, author: post.author, ...post.lead! })));
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
    setFound(current => [{ key: step, author: post.author, ...post.lead! }, ...current].slice(0, 3));
    setTotal(value => value + 1);
  }, [step]);

  // One extra row above (sliding out) and one below (sliding in), so the feed never shows a gap mid-move.
  const rows = Array.from({ length: VISIBLE + 2 }, (_, offset) => step + offset - 1);
  return <div className="scan-scene" aria-hidden="true">
    <div className="scan-window">
      <div className="scan-window-bar">
        <span className="scan-dots"><i/><i/><i/></span>
        <span className="scan-window-title">Bảng tin Facebook</span>
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
            <div><b>{post.author}</b><p>{post.text}</p></div>
            {matched && <span className="scan-tag">Lead phù hợp</span>}
          </div>;
        })}
        <div className="scan-beam" style={{ top: `${SCAN_ROW * 20}%` }}/>
      </div>
    </div>

    <div className="scan-found">
      <div className="scan-found-head"><Icon name="spark" size={16}/>Lead mới tìm thấy<span>{total}</span></div>
      <ul>
        {found.length === 0 && <li className="scan-found-empty">Đang chờ bài phù hợp…</li>}
        {found.map(item => <li key={item.key}><b>{item.author}</b><span>{item.signal} · {item.area}</span></li>)}
      </ul>
    </div>

    <div className="scan-cadence"><span className="scene-radar"><Icon name="radar" size={16}/></span>Tự quét lại mỗi 30 phút</div>
    <span className="scan-caption">Minh họa</span>
  </div>;
}
