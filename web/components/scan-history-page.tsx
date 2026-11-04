'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ScanDay, ScanHistoryPage } from '@/lib/server/leads';
import { clockTime, dayKey } from '@/lib/scan-history';
import { ScanRow } from './scan-outcome';
import { AppShell } from './app-shell';
import { Icon } from './visuals';

type ProfileOption = { id: string; name: string; enabled: boolean };

function historyUrl(filters: { profileId: string | null; onlyNew: boolean; page?: number }): string {
  const params = new URLSearchParams();
  if (filters.profileId) params.set('nhu-cau', filters.profileId);
  if (filters.onlyNew) params.set('bai-moi', '1');
  if (filters.page && filters.page > 1) params.set('trang', String(filters.page));
  const query = params.toString();
  return `/app/lich-su-quet${query ? `?${query}` : ''}`;
}

function dayTitle(day: string, today: string, yesterday: string): string {
  const date = new Date(`${day}T12:00:00+07:00`);
  const label = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return day === today ? `Hôm nay · ${capitalized}` : day === yesterday ? `Hôm qua · ${capitalized}` : capitalized;
}

function DaySummary({ day }: { day: ScanDay | undefined }) {
  if (!day) return null;
  return <p className="history-day-summary">{day.scans} lượt tìm · <b className={day.newLeads ? 'has-leads' : ''}>{day.newLeads} lead mới</b>{day.failed > 0 && <> · <span className="is-error">{day.failed} lỗi</span></>}</p>;
}

/**
 * The full scan history behind the dashboard's recent rows: every scan, newest first, grouped by Vietnam calendar
 * day with that whole day's tally, filterable by search and by "found new posts", and paged on the server.
 */
export function ScanHistoryView({ history, profiles, hasLegacy, profileId, onlyNew, today, yesterday }: { history: ScanHistoryPage; profiles: ProfileOption[]; hasLegacy: boolean; profileId: string | null; onlyNew: boolean; today: string; yesterday: string }) {
  const router = useRouter();
  const days = new Map(history.days.map(day => [day.day, day]));
  const groups: Array<{ day: string; runs: ScanHistoryPage['runs'] }> = [];
  for (const run of history.runs) {
    const key = dayKey(run.scannedAt);
    if (groups.at(-1)?.day === key) groups.at(-1)!.runs.push(run);
    else groups.push({ day: key, runs: [run] });
  }
  const filtered = Boolean(profileId) || onlyNew;
  const selected = profiles.find(profile => profile.id === profileId);
  // Within one search every row has the same name, so it is only shown when several searches are listed.
  const showSource = !profileId && profiles.length + (hasLegacy ? 1 : 0) > 1;

  return <AppShell active="Hôm nay">
    <Link href="/app" className="back-link"><Icon name="back" size={16}/>Hôm nay</Link>
    <div className="page-head">
      <div><h1>Lịch sử quét</h1><p>Kết quả từng lượt tìm, mới nhất ở trên. Lượt chưa có lead mới vẫn là lượt tìm đã xong.</p></div>
    </div>

    <section className="filter-bar history-filters" aria-label="Lọc lịch sử quét">
      <label className="history-select">
        <span>Nhu cầu</span>
        <select value={profileId ?? ''} onChange={event => router.push(historyUrl({ profileId: event.target.value || null, onlyNew }))}>
          <option value="">Tất cả nhu cầu</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.enabled ? '' : ' (tạm dừng)'}</option>)}
          {hasLegacy && <option value="legacy">Lượt quét trước</option>}
        </select>
      </label>
      <div className="toggle-chips" role="group" aria-label="Lọc nhanh">
        <Link href={historyUrl({ profileId, onlyNew: !onlyNew })} aria-pressed={onlyNew} className="history-chip">Chỉ lượt có lead mới</Link>
        {filtered && <Link href={historyUrl({ profileId: null, onlyNew: false })} className="history-chip clear-chip">Xóa lọc</Link>}
      </div>
    </section>

    <section className="panel history-panel" aria-label="Các lượt quét">
      <div className="panel-head">
        <h2>{history.total} lượt tìm{onlyNew ? ' có lead mới' : ''}</h2>
        {selected && <Link className="text-link" href={`/app/bai-viet?nhu-cau=${selected.id}`}>Lead của nhu cầu này <Icon name="arrow" size={16}/></Link>}
      </div>
      {history.runs.length === 0
        ? <p className="muted-text scan-empty">{filtered ? 'Không có lượt quét nào khớp bộ lọc.' : 'Chưa có lượt quét nào.'}</p>
        : groups.map(group => <div className="history-day" key={group.day}>
          <div className="history-day-head"><h3>{dayTitle(group.day, today, yesterday)}</h3><DaySummary day={days.get(group.day)}/></div>
          <ol className="scan-rows history-runs">{group.runs.map(scan => <ScanRow key={scan.id} scan={scan} when={clockTime(scan.scannedAt)} showSource={showSource} linkSource/>)}</ol>
        </div>)}
      {history.pageCount > 1 && <nav className="history-pager" aria-label="Phân trang">
        {history.page > 1 ? <Link className="btn btn-outline" href={historyUrl({ profileId, onlyNew, page: history.page - 1 })}>Trang trước</Link> : <span/>}
        <span className="muted-text">Trang {history.page}/{history.pageCount}</span>
        {history.page < history.pageCount ? <Link className="btn btn-outline" href={historyUrl({ profileId, onlyNew, page: history.page + 1 })}>Trang sau</Link> : <span/>}
      </nav>}
    </section>
    <p className="scan-footnote history-footnote">Lead mới là bài đăng phù hợp mà QLead ghi nhận cho bạn lần đầu. Một doanh nghiệp có thể đăng nhiều bài, nên số lead là số bài đăng, không phải số doanh nghiệp hay khách đã liên hệ.</p>
  </AppShell>;
}
