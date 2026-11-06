import Link from 'next/link';
import { Icon } from '@/components/visuals';
import { requireAdmin } from '@/lib/server/admin';
import { adminFeedbackReport, type AdminFeedbackItem, type AdminFeedbackReport, type FeedbackFilter } from '@/lib/server/feedback';
import './feedback.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Phản hồi khách hàng · Quản trị QLead' };

const PAGE_SIZE = 30;
const timeFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });
const average = (value: number | null) => (value === null ? '—' : value.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));

function Stars({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="fbr-stars is-empty">{label}: <span>không chấm</span></span>;
  return <span className="fbr-stars" aria-label={`${label}: ${value} trên 5 sao`}>
    <span aria-hidden="true">{label}</span>
    <span className={`fbr-star-row${value <= 2 ? ' is-low' : ''}`} aria-hidden="true">{'★'.repeat(value)}<i>{'★'.repeat(5 - value)}</i></span>
    <b aria-hidden="true">{value}/5</b>
  </span>;
}

/** Five horizontal bars, 5 stars on top. Bars are scaled to the question's own count, so both read the same way. */
function Distribution({ title, counts, total, avg }: { title: string; counts: number[]; total: number; avg: number | null }) {
  return <section className="fbr-dist" aria-label={title}>
    <header><h3>{title}</h3><p><b>{average(avg)}</b><span> / 5 · {total} lượt chấm</span></p></header>
    <ol>{[5, 4, 3, 2, 1].map(star => {
      const count = counts[star - 1] ?? 0;
      const share = total ? Math.round((count / total) * 100) : 0;
      return <li key={star}>
        <span className="fbr-dist-label">{star} sao</span>
        <span className={`fbr-dist-bar${star <= 2 ? ' is-low' : ''}`} aria-hidden="true"><i style={{ width: `${share}%` }}/></span>
        <span className="fbr-dist-count">{count}<small> · {share}%</small></span>
      </li>;
    })}</ol>
  </section>;
}

function FeedbackRow({ item }: { item: AdminFeedbackItem }) {
  return <li className="fbr-item">
    <header>
      <div className="fbr-who">
        {item.user
          ? <><b>{item.user.displayName}</b>{item.user.email && <span>{item.user.email}</span>}<Link className="text-link small" href={`/admin/users?q=${encodeURIComponent(item.user.email ?? item.user.id)}`}>Xem khách hàng</Link></>
          : <b className="muted-text">Tài khoản đã xóa</b>}
      </div>
      <div className="fbr-meta">
        <time dateTime={item.createdAt}>{timeFormat.format(new Date(item.createdAt))}</time>
        <span className={`pill ${item.source === 'invitation' ? 'pill-active' : ''}`}>{item.source === 'invitation' ? 'Từ lời mời' : 'Tự gửi'}</span>
      </div>
    </header>
    <div className="fbr-ratings">
      <Stars value={item.easeRating} label="Dễ dùng"/>
      <Stars value={item.needsRating} label="Đáp ứng nhu cầu"/>
    </div>
    {item.unmetReason && <div className="fbr-text"><h4>Điểm chưa đáp ứng tốt</h4><p>{item.unmetReason}</p></div>}
    {item.improvement && <div className="fbr-text"><h4>Muốn cải tiến, bổ sung</h4><p>{item.improvement}</p></div>}
    {!item.unmetReason && !item.improvement && <p className="muted-text small">Không viết thêm.</p>}
  </li>;
}

function pageHref(filter: FeedbackFilter, page: number) {
  const params = new URLSearchParams();
  if (filter === 'low') params.set('loc', 'thap');
  if (page > 1) params.set('trang', String(page));
  const query = params.toString();
  return `/admin/feedback${query ? `?${query}` : ''}`;
}

/**
 * Customer feedback for Admins (server-side allowlist, same guard as every /admin page). Ratings and averages count only
 * real answers; closing the invitation is shown separately and is never a rating.
 */
export default async function AdminFeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Layouts and pages render in parallel, so the page checks admin access itself before reading anything.
  await requireAdmin();
  const params = await searchParams;
  const filter: FeedbackFilter = params.loc === 'thap' ? 'low' : 'all';
  const page = Math.min(100_000, Math.max(1, Number.parseInt(typeof params.trang === 'string' ? params.trang : '1', 10) || 1));
  let report: AdminFeedbackReport | null = null;
  try { report = await adminFeedbackReport(filter, PAGE_SIZE, (page - 1) * PAGE_SIZE); }
  catch (error) { console.error('Admin feedback report failed:', error instanceof Error ? error.name : 'unknown'); }

  return <div className="admin-page fbr-page">
    <div className="page-head"><div><h1>Phản hồi khách hàng</h1><p>Đánh giá và góp ý khách hàng gửi qua lời mời một lần hoặc tự gửi. Mới nhất trước.</p></div></div>
    {!report ? <div className="admin-alert admin-alert-error" role="alert"><Icon name="info" size={18}/><span>Chưa đọc được phản hồi. Tải lại trang sau ít phút.</span></div> : <>
      <section className="admin-section" aria-labelledby="fbr-overview">
        <h2 id="fbr-overview">Tổng quan</h2>
        <dl className="stat-grid fbr-stats">
          <div><dt>Lượt góp ý</dt><dd>{report.stats.responses}</dd></div>
          <div><dt>Có chấm sao</dt><dd>{report.stats.ratedResponses}</dd></div>
          <div><dt>Dễ sử dụng (TB)</dt><dd>{average(report.stats.easeAverage)}<small>/5</small></dd></div>
          <div><dt>Đáp ứng nhu cầu (TB)</dt><dd>{average(report.stats.needsAverage)}<small>/5</small></dd></div>
          <div><dt>Có nội dung viết</dt><dd>{report.stats.withText}</dd></div>
          <div><dt>Điểm thấp (1–2 sao)</dt><dd className={report.stats.lowRated ? 'is-low' : ''}>{report.stats.lowRated}</dd></div>
        </dl>
        <div className="fbr-dists">
          <Distribution title="Giao diện dễ hiểu, dễ sử dụng" counts={report.stats.easeDistribution} total={report.stats.easeCount} avg={report.stats.easeAverage}/>
          <Distribution title="Đáp ứng nhu cầu tìm khách hàng" counts={report.stats.needsDistribution} total={report.stats.needsCount} avg={report.stats.needsAverage}/>
        </div>
        <p className="fbr-invites small"><Icon name="info" size={16}/><span>Lời mời tự động: <b>{report.stats.invitations.submitted}</b> đã góp ý · <b>{report.stats.invitations.declined}</b> đã đóng (không tính là đánh giá) · <b>{report.stats.invitations.shown}</b> đã hiện, chưa trả lời.</span></p>
      </section>

      <section className="admin-section" aria-labelledby="fbr-list">
        <div className="fbr-list-head">
          <h2 id="fbr-list">Danh sách góp ý</h2>
          <nav className="toggle-chips" aria-label="Lọc góp ý">
            <Link href={pageHref('all', 1)} aria-current={filter === 'all' ? 'page' : undefined} className={filter === 'all' ? 'is-on' : ''}>Tất cả ({report.stats.responses})</Link>
            <Link href={pageHref('low', 1)} aria-current={filter === 'low' ? 'page' : undefined} className={filter === 'low' ? 'is-on' : ''}>Điểm thấp ({report.stats.lowRated})</Link>
          </nav>
        </div>
        {report.items.length === 0
          ? <p className="muted-text fbr-empty">{filter === 'low' ? 'Chưa có góp ý nào chấm 1–2 sao.' : 'Chưa có góp ý nào.'}</p>
          : <ol className="fbr-items">{report.items.map(item => <FeedbackRow key={item.id} item={item}/>)}</ol>}
        {report.total > PAGE_SIZE && <nav className="fbr-pager" aria-label="Trang">
          {page > 1 ? <Link className="btn btn-outline btn-sm" href={pageHref(filter, page - 1)}>Mới hơn</Link> : <span/>}
          <span className="muted-text small">Trang {page}/{Math.max(1, Math.ceil(report.total / PAGE_SIZE))}</span>
          {page * PAGE_SIZE < report.total ? <Link className="btn btn-outline btn-sm" href={pageHref(filter, page + 1)}>Cũ hơn</Link> : <span/>}
        </nav>}
      </section>
    </>}
  </div>;
}
