'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { clearLandingHandoff, readLandingHandoff, type LandingHandoff } from '@/lib/landing-client';
import { exactTime } from '@/lib/lead-format';
import { draftPayload, emptyDraft, withDescription } from '@/lib/profile-draft';
import { Icon } from './visuals';

type Full = { key: string; text: string; summarized: boolean; original: string | null; author: string | null; url: string | null; publishedAt: string | null; area: string | null; contact: string | null };
type Load = { status: 'none' } | { status: 'loading'; handoff: LandingHandoff } | { status: 'ok'; handoff: LandingHandoff; leads: Full[] }
  | { status: 'expired' | 'error'; handoff: LandingHandoff };

/** Reads the landing hand-off saved before sign-up / sign-in and opens the full details of the leads it showed. */
export function useLandingHandoff(): Load {
  const [load, setLoad] = useState<Load>({ status: 'none' });
  useEffect(() => {
    const handoff = readLandingHandoff();
    if (!handoff) return;
    setLoad({ status: 'loading', handoff });
    let cancelled = false;
    fetch(`/api/landing/previews/${handoff.previewId}`, { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) await response.body?.cancel().catch(() => undefined);
        if (cancelled) return;
        if (response.status === 410 || response.status === 404) { setLoad({ status: 'expired', handoff }); return; }
        if (!response.ok) { setLoad({ status: 'error', handoff }); return; }
        const data = await response.json() as { leads: Full[] };
        setLoad({ status: 'ok', handoff, leads: data.leads });
      })
      .catch(() => { if (!cancelled) setLoad({ status: 'error', handoff }); });
    return () => { cancelled = true; };
  }, []);
  return load;
}

function FullLead({ lead }: { lead: Full }) {
  return <li className="handoff-lead">
    <p className="handoff-lead-text">{lead.summarized && <span className="demo-lead-kind">QLead tóm tắt</span>}{lead.text}</p>
    {lead.original && <details className="handoff-original"><summary>Nội dung gốc</summary><p>{lead.original}</p></details>}
    <div className="demo-lead-meta">
      {lead.author && <span><Icon name="user" size={15}/>{lead.author}</span>}
      {lead.area && <span><Icon name="pin" size={15}/>{lead.area}</span>}
      {lead.publishedAt && <span><Icon name="clock" size={15}/>Đăng {exactTime(lead.publishedAt)}</span>}
      {lead.contact && <span className="has-contact"><Icon name="phone" size={15}/>{lead.contact}</span>}
    </div>
    {lead.url && <a className="text-link" href={lead.url} target="_blank" rel="noopener noreferrer">Mở bài Facebook <Icon name="external" size={15}/></a>}
  </li>;
}

/** The leads found on the landing page, shown in full after sign-up (onboarding) or sign-in (/app/thu-tim). */
export function LandingHandoffLeads({ load, compact = false }: { load: Load; compact?: boolean }) {
  if (load.status === 'none') return null;
  return <section className={`handoff ${compact ? 'is-compact' : ''}`} aria-labelledby="handoff-title" aria-busy={load.status === 'loading'}>
    <h2 id="handoff-title"><Icon name="check" size={18}/>{load.status === 'ok' && load.leads.length ? `${load.leads.length} lead bạn vừa tìm thấy, đầy đủ thông tin` : 'Lần tìm thử của bạn'}</h2>
    {load.status === 'loading' && <p className="muted-text">Đang mở kết quả…</p>}
    {load.status === 'ok' && load.leads.length > 0 && <ul className="handoff-list">{load.leads.map(lead => <FullLead key={lead.key} lead={lead}/>)}</ul>}
    {load.status === 'ok' && load.leads.length === 0 && <p className="muted-text">Lần tìm thử chưa có lead phù hợp. Lưu mô tả bên dưới để QLead bắt đầu tìm riêng cho bạn.</p>}
    {load.status === 'expired' && <p className="muted-text">Kết quả tìm thử đã hết hạn (giữ trong 24 giờ). Mô tả của bạn vẫn còn: lưu lại để QLead tìm mới cho bạn.</p>}
    {load.status === 'error' && <p className="muted-text">Chưa mở được kết quả tìm thử. Tải lại trang để thử lại.</p>}
  </section>;
}

/** /app/thu-tim: a signed-in customer who came from the landing search sees the full leads and can follow the need. */
export function LandingHandoffPage() {
  const load = useLandingHandoff();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = load.status === 'none' ? '' : load.handoff.query;

  async function follow() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: draftPayload(withDescription(emptyDraft, query)), enabled: true }) });
      if (!response.ok) throw new Error();
      clearLandingHandoff();
      window.location.assign('/app/bo-loc');
    } catch {
      setError('Chưa lưu được nhu cầu. Bạn có thể tạo nhu cầu trong trang Bộ lọc.');
      setBusy(false);
    }
  }

  if (load.status === 'none') return <div className="handoff-page">
    <h1>Tìm thử</h1>
    <p className="muted-text">Trình duyệt này chưa có lần tìm thử nào từ trang chủ.</p>
    <Link className="btn btn-outline" href="/#demo">Tìm thử trên trang chủ</Link>
  </div>;
  return <div className="handoff-page">
    <h1>Kết quả tìm thử</h1>
    <blockquote className="onboarding-quote">“{query}”</blockquote>
    <LandingHandoffLeads load={load}/>
    <div className="handoff-actions">
      <button type="button" className="btn btn-primary" disabled={busy || !query} onClick={follow}>{busy ? 'Đang lưu…' : 'Theo dõi nhu cầu này'} {!busy && <Icon name="arrow" size={16}/>}</button>
      <Link className="btn btn-ghost" href="/app" onClick={() => clearLandingHandoff()}>Để sau</Link>
    </div>
    <p className="muted-text">QLead sẽ tìm trên Facebook theo mô tả này và báo khi có lead mới.</p>
    {error && <p className="warning-line" role="alert"><Icon name="info" size={16}/>{error}</p>}
  </div>;
}
