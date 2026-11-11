'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ScanRun, ScanTotals } from '@/lib/server/leads';
import type { Lead } from '@/lib/lead-source';
import { compareLeadRank } from '@/lib/lead-ranking';
import { frequencyLabel, PROFILE_STATE_LABEL, type LegacySummary, type SearchProfile } from '@/lib/profile-state';
import { AppShell, useMonitoringSuspended } from './app-shell';
import { Icon } from './visuals';
import { GoatMascot } from './goat-mascot';
import { LatestDeliveryBand, LeadListItem } from './lead-results';
import { latestDelivery } from '@/lib/lead-delivery';
import { FirstScanView } from './first-scan';
import { DiscoveryNotice } from './discovery-notice';
import type { FirstScan } from '@/lib/first-scan';
import { useLeadWorkflow, useNow } from '@/lib/lead-state';
import type { WorkflowMap } from '@/lib/lead-workflow';
import { recentActivity, scanTime, shortScanTime } from '@/lib/scan-history';
import { QuietScansRow, ScanRow } from './scan-outcome';
import { HotLeadBand } from './hot-lead';
import { QuietHoursNote } from './quiet-hours';
import { InstallHint } from './pwa-runtime';
import { hotLeads } from '@/lib/hot-lead';
import { isSearchQuietHours, nextAllowedScanAt } from '../../src/quiet-hours';

export function Dashboard({ records, profiles, legacy, scans, scanTotals, firstRun, discovery, workflow: initialWorkflow, rankingNow }: { records: Lead[]; profiles: SearchProfile[]; legacy: LegacySummary | null; scans: ScanRun[]; scanTotals: ScanTotals; firstRun: FirstScan | null; discovery: FirstScan | null; workflow: WorkflowMap; rankingNow: number }) {
  const now = useNow();
  const workflow = useLeadWorkflow(initialWorkflow);
  const byPriority = [...records].sort((a, b) => compareLeadRank(a, b, rankingNow));
  const unseen = byPriority.filter(lead => workflow.get(lead.id).status === "new");
  const contacted = records.filter(lead => workflow.get(lead.id).status === "contacted").length;
  const interested = records.filter(lead => workflow.get(lead.id).status === "interested").length;
  const suspended = useMonitoringSuspended();
  // The newest bounded delivery leads Today with one "start here" line; the full list keeps every older lead.
  const latest = latestDelivery(records);
  const hot = hotLeads(records, now);
  const today = now ? new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).format(now) : '';

  return <AppShell active="Hôm nay">
    <div className="page-head">
      <div><h1>Hôm nay</h1>{suspended
        // The one place on this page that states the account hold (the event itself lives in Thông báo).
        ? <>{today && <p><span className="capitalize">{today}</span></p>}<p className="hold-note"><span className="hold-dot" aria-hidden="true"/><span>Tìm lead mới đang tạm dừng. Lead đã lưu vẫn xem được.</span></p></>
        : <p>{today && <span className="capitalize">{today}</span>}{today && ' · '}Ưu tiên bài mới, đúng nhu cầu và còn cơ hội.</p>}</div>
      <Link href="/app/bai-viet" className="btn btn-primary">Xem tất cả lead <Icon name="arrow" size={16}/></Link>
    </div>

    {/* Until the first scan finishes, its real status leads the page instead of zero counts and an empty list. */}
    {firstRun ? <FirstScanView initial={firstRun} compact/> : <>
    {discovery && <DiscoveryNotice initial={discovery} place="today"/>}
    <HotLeadBand leads={hot} now={now} compact/>
    {/* Installing is suggested only once there are real leads; a Hot Lead band carries its own install line. */}
    {records.length > 0 && hot.length === 0 && <InstallHint/>}
    {latest && <LatestDeliveryBand latest={latest} workflow={workflow} now={now} compact/>}
    <dl className="summary-row" aria-label="Tóm tắt">
      <div><dt>Chưa xem</dt><dd>{unseen.length}</dd></div>
      <div><dt>Đã liên hệ</dt><dd>{contacted}</dd></div>
      <div><dt>Quan tâm</dt><dd>{interested}</dd></div>
    </dl>

    <div className="today-grid">
      <section className="panel" aria-labelledby="priority-title">
        <div className="panel-head"><h2 id="priority-title">Nên xem trước</h2><span className="muted-text">Chưa xem · mới đăng trước</span></div>
        {records.length === 0 && profiles.length === 0
          ? <div className="empty-state compact"><GoatMascot size="sm"/><h3>QLead chưa biết bạn muốn tìm khách hàng nào.</h3><p>Tạo một nhu cầu tìm kiếm, QLead sẽ quét Facebook theo lịch và đưa lead mới về đây.</p><Link className="btn btn-primary" href="/app/bo-loc?tao=1">Tạo nhu cầu tìm kiếm</Link></div>
          : records.length === 0
          ? <div className="empty-state compact"><GoatMascot size="sm"/><h3>Chưa có lead nào</h3><p>Nhu cầu của bạn đã được lưu. Khi QLead tìm thấy bài phù hợp, lead sẽ xuất hiện ở đây.</p><Link className="btn btn-outline" href="/app/bo-loc">Xem nhu cầu theo dõi</Link></div>
          : unseen.length === 0
            ? <div className="empty-state compact"><GoatMascot size="sm"/><h3>Bạn đã xem hết lead</h3><p>Lead mới sẽ xuất hiện ở đây sau các lượt quét tiếp theo.</p><Link className="btn btn-outline" href="/app/bai-viet">Xem lại danh sách</Link></div>
            : <ul className="lead-list">{unseen.slice(0, 5).map(lead => <LeadListItem key={lead.id} lead={lead} now={now} workflow={workflow}/>)}</ul>}
        {unseen.length > 5 && <Link className="panel-foot-link" href="/app/bai-viet">Còn {unseen.length - 5} lead chưa xem <Icon name="arrow" size={16}/></Link>}
      </section>

      <aside className="today-aside">
        <ScanHistoryPanel profiles={profiles} legacy={legacy} scans={scans} totals={scanTotals} suspended={suspended}/>
      </aside>
    </div>
    </>}
  </AppShell>;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Searches listed by name in the panel; the rest are counted and linked to the requirements page. */
const MONITOR_PREVIEW = 3;

/**
 * What QLead is doing now and what it did recently: the enabled searches, the next slot of the configured schedule,
 * a 24-hour tally of new leads, then a few result-first rows in which back-to-back scans without new leads are folded into one. The
 * panel stays the same size however long QLead has been running; every scan is on /app/lich-su-quet. Jobs only run
 * when a scan is actually picked up, so the next slot is shown as an estimate, and only while scans arrive on time.
 */
function ScanHistoryPanel({ profiles, legacy, scans, totals, suspended }: { profiles: SearchProfile[]; legacy: LegacySummary | null; scans: ScanRun[]; totals: ScanTotals; suspended: boolean }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const monitoring = profiles.filter(profile => profile.enabled);
  const onSchedule = monitoring.filter(profile => profile.state === 'active' || profile.state === 'pending_first_scan');
  const frequencyMs = onSchedule.length ? Math.min(...onSchedule.map(profile => profile.frequencyMinutes)) * 60_000 : 0;
  const next = frequencyMs && now ? Math.ceil(now / frequencyMs) * frequencyMs : null;
  const remaining = next !== null ? next - now : null;
  // Overnight pause (00:30–06:30 Vietnam time, enforced by the backend): no countdown into it and no "late" warning.
  const quiet = now ? isSearchQuietHours(new Date(now)) : false;
  const resumesAt = next !== null ? nextAllowedScanAt(new Date(next)) : null;
  const lastSuccess = monitoring.map(profile => profile.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null;
  const recent = recentActivity(scans);
  const day = totals.last24h;
  // Search names are only needed to tell results apart when more than one search (or older scans) is in play.
  const showSource = profiles.length + (legacy ? 1 : 0) > 1;

  return <section className="panel scan-panel" aria-labelledby="scan-title">
    <div className="panel-head"><h2 id="scan-title">Lịch sử quét</h2><Link className="text-link" href="/app/bo-loc">Nhu cầu ({profiles.length})</Link></div>
    {suspended
      // An Admin hold is a state, not a fault: no countdown, no "late" warning, no per-need status pills.
      ? <div className="monitor-summary"><p><b>Lượt quét theo lịch đang tạm dừng.</b>{monitoring.length > 0 && <span className="muted-text"> {monitoring.length} nhu cầu đang bật sẽ tự tiếp tục.</span>}</p></div>
      : <><div className="monitor-summary">
      {monitoring.length
        ? <p><b>Đang theo dõi {monitoring.length} nhu cầu</b>{profiles.length > monitoring.length && <span className="muted-text"> · {profiles.length - monitoring.length} tạm dừng hoặc nháp</span>}</p>
        : <p><b>Chưa có nhu cầu nào đang bật.</b> {legacy ? 'Lead từ lượt quét trước vẫn ở danh sách.' : ''} <Link className="text-link" href="/app/bo-loc">{profiles.length ? 'Bật lại' : 'Tạo nhu cầu'}</Link></p>}
      {monitoring.length > 0 && <ul className="monitor-list">{monitoring.slice(0, MONITOR_PREVIEW).map(profile => <li key={profile.id}>
        <span className={`profile-state is-${profile.state}`}>{PROFILE_STATE_LABEL[profile.state]}</span>
        <Link href={`/app/bai-viet?nhu-cau=${profile.id}`} title={profile.name}>{profile.name}</Link>
      </li>)}
        {monitoring.length > MONITOR_PREVIEW && <li><Link className="monitor-more" href="/app/bo-loc">+ {monitoring.length - MONITOR_PREVIEW} nhu cầu khác</Link></li>}
      </ul>}
    </div>
    {monitoring.length > 0 && <div className={`scan-next ${remaining === null && now && !quiet ? 'is-late' : ''} ${quiet ? 'is-quiet' : ''}`}>
      {quiet
        ? <QuietHoursNote/>
        : resumesAt
        ? <><span className="scan-next-label">Lượt quét tiếp theo</span><span className="scan-next-at">QLead tạm nghỉ ban đêm từ 00:30, sẽ tìm tiếp từ 06:30.</span></>
        : remaining !== null && next !== null
        ? <>
          <span className="scan-next-label">Lượt quét dự kiến tiếp theo</span>
          <b className="scan-countdown">{clock(remaining)}</b>
          <span className="scan-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, 100 - (remaining / frequencyMs) * 100)}%` }}/></span>
          <span className="scan-next-at">khoảng {scanTime(new Date(next).toISOString()).split(' - ')[1]} · theo lịch {frequencyLabel(frequencyMs / 60_000)}</span>
        </>
        : now ? <span className="scan-late-note">{lastSuccess ? `Chưa có lượt quét mới từ ${scanTime(lastSuccess)}.` : 'Chưa có lượt quét nào hoàn tất.'} Lượt quét đang chậm hơn lịch, lead mới có thể đến muộn.</span>
        : <p className="muted-text">Đang tính…</p>}
    </div>}</>}
    {scans.length > 0 ? <>
      <div className="scan-recent-head">
        <h3>Gần đây</h3>
        <p>{day.scans
          ? <>24 giờ qua · {day.scans} lượt tìm · <b className={day.newLeads ? 'has-leads' : ''}>{day.newLeads} lead mới</b>{day.failed > 0 && <> · <span className="is-error">{day.failed} lỗi</span></>}</>
          : '24 giờ qua chưa có lượt tìm nào.'}</p>
      </div>
      <ol className="scan-rows scan-recent">{recent.map(entry => entry.kind === 'scan'
        ? <ScanRow key={entry.scan.id} scan={entry.scan} when={shortScanTime(entry.scan.scannedAt, now)} showSource={showSource}/>
        : <QuietScansRow key={entry.scans[0].id} scans={entry.scans} when={shortScanTime(entry.scans[0].scannedAt, now)} since={shortScanTime(entry.scans.at(-1)!.scannedAt, now)} showSource={showSource}/>)}</ol>
      <Link className="panel-foot-link" href="/app/lich-su-quet">Xem toàn bộ lịch sử · {totals.total} lượt <Icon name="arrow" size={16}/></Link>
    </> : <p className="muted-text scan-empty">Chưa có lượt quét nào.</p>}
  </section>;
}
