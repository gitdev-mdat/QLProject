import { frequencyLabel, type SearchProfile } from './profile-state';
import { SCAN_OPEN, type ProfileScan, type ScanRequestOutcome } from './profile-scan';

/**
 * One plain-language answer per search-profile card to "what is QLead doing for this need right now?", derived only
 * from stored server state (profile state + latest scan). Waiting is never shown as running, and nothing names
 * workers, jobs, queues or configuration versions.
 */
export type StatusTone = 'waiting' | 'running' | 'success' | 'quiet' | 'warn' | 'off' | 'idle';
export type StatusAction = 'view_new' | 'edit' | 'resume' | 'enable';

export type ProfileStatus = {
  tone: StatusTone;
  title: string;
  /** One short line: when it happened, or what happens next. */
  detail: string;
  /** True while a search is genuinely running (a search holds it), the only state that animates. */
  live: boolean;
  action?: StatusAction;
  /**
   * 'older': the scan was requested before the customer's latest save, so it does not use that save.
   * 'latest': it uses the latest saved requirement. Null when there is no scan to compare.
   */
  freshness: 'older' | 'latest' | null;
};

type Clock = (iso: string) => string;

export function profileStatus(profile: SearchProfile, scan: ProfileScan | null, suspended: boolean, time: Clock): ProfileStatus {
  const base = { live: false, freshness: null } as const;
  if (suspended && scan?.state !== 'running') return { ...base, tone: 'off', title: 'Tài khoản đang tạm ngưng tìm khách mới', detail: 'QLead chưa tìm thêm cho tài khoản này. Khách hàng đã tìm được vẫn được giữ.' };
  if (!profile.enabled) return profile.state === 'draft'
    ? { ...base, tone: 'off', title: 'Chưa bật theo dõi', detail: 'Đã lưu. Bật theo dõi để QLead bắt đầu tìm.', action: 'enable' }
    : { ...base, tone: 'off', title: 'Đã tạm dừng theo dõi', detail: 'QLead không tìm thêm. Khách hàng đã tìm được vẫn được giữ.', action: 'resume' };

  if (scan?.kind === 'followup') return followupStatus(profile, scan);
  if (scan) {
    const freshness = scan.version < profile.version ? 'older' : 'latest';
    switch (scan.state) {
      case 'queued': return {
        ...base, freshness, tone: 'waiting',
        title: scan.kind === 'manual' ? 'Đã nhận yêu cầu tìm lại' : scan.kind === 'initial' ? 'Sắp tìm lần đầu' : 'Sắp đến lượt tìm',
        detail: 'Chưa bắt đầu. QLead sẽ tìm ngay khi đến lượt, bạn có thể rời trang.',
      };
      case 'running': return { ...base, freshness, live: true, tone: 'running', title: 'Đang tìm khách hàng…', detail: 'Kết quả sẽ hiện ở đây ngay khi tìm xong, bạn có thể rời trang.' };
      case 'delayed': return { ...base, freshness, tone: 'warn', title: 'Chưa bắt đầu, đang chậm hơn thường lệ', detail: 'Yêu cầu vẫn được giữ, bạn không cần bấm lại.' };
      case 'results': return {
        ...base, freshness, tone: 'success', title: `Tìm thấy ${scan.newPosts} khách hàng mới`,
        detail: `QLead vẫn tự tìm lại ${frequencyLabel(profile.frequencyMinutes)}.`, action: 'view_new',
      };
      case 'no_results': return {
        ...base, freshness, tone: 'quiet', title: 'Đã tìm xong, chưa có khách hàng mới',
        detail: `Mô tả cụ thể hơn giúp QLead tìm đúng hơn. QLead vẫn tự tìm lại ${frequencyLabel(profile.frequencyMinutes)}.`, action: 'edit',
      };
      case 'failed': return { ...base, freshness, tone: 'warn', title: 'Lần tìm này chưa thành công', detail: 'QLead sẽ tự thử lại ở lượt sau. Bạn cũng có thể tìm lại sau ít phút.' };
    }
  }

  switch (profile.state) {
    case 'pending_first_scan': return { ...base, tone: 'waiting', title: 'Sắp tìm lần đầu', detail: 'QLead sẽ tìm trong lượt tới.' };
    case 'waiting_worker': return { ...base, tone: 'waiting', title: 'Sắp đến lượt tìm', detail: 'Đã đến giờ tìm định kỳ. QLead sẽ bắt đầu ngay khi đến lượt.' };
    case 'delayed': return { ...base, tone: 'warn', title: 'Lượt tìm định kỳ đang chậm hơn thường lệ', detail: 'Yêu cầu vẫn được giữ, bạn không cần bấm lại.' };
    case 'attention': return { ...base, tone: 'warn', title: 'Lần tìm gần nhất chưa thành công', detail: 'QLead sẽ tự thử lại ở lượt sau.' };
    default: {
      const last = profile.lastScan;
      const every = `QLead tự tìm lại ${frequencyLabel(profile.frequencyMinutes)}.`;
      if (!last) return { ...base, tone: 'idle', title: 'Đang theo dõi', detail: every };
      return last.newPosts > 0
        ? { ...base, tone: 'idle', title: `Lần tìm gần nhất: ${last.newPosts} khách hàng mới`, detail: `Lúc ${time(last.at)}. ${every}` }
        : { ...base, tone: 'idle', title: 'Lần tìm gần nhất: chưa có khách hàng mới', detail: `Lúc ${time(last.at)}. ${every}` };
    }
  }
}

/**
 * The extra search after a first search that found little. Leads already found stay the headline (they can be opened
 * now); the extra search is described as "looking further", with no promise that it finds more.
 */
function followupStatus(profile: SearchProfile, scan: ProfileScan): ProfileStatus {
  const base = { live: false, freshness: 'latest' as const };
  const have = profile.leadCount > 0;
  const view = have ? { action: 'view_new' as const } : {};
  const every = `QLead vẫn tự tìm lại ${frequencyLabel(profile.frequencyMinutes)}.`;
  switch (scan.state) {
    case 'queued': return { ...base, ...view, tone: 'waiting', title: 'QLead sẽ tiếp tục tìm thêm',
      detail: have ? `Đã có ${profile.leadCount} khách hàng để xem ngay. Bạn có thể rời trang, lead mới (nếu có) sẽ tự vào danh sách.` : 'Lần tìm đầu tiên chưa thấy bài phù hợp. Bạn có thể rời trang, QLead sẽ tự cập nhật.' };
    case 'running': return { ...base, ...view, live: true, tone: 'running', title: 'Đang tìm thêm khách hàng…',
      detail: have ? `Đã có ${profile.leadCount} khách hàng để xem ngay. Lead mới (nếu có) sẽ tự vào danh sách.` : 'Lần tìm đầu tiên chưa thấy bài phù hợp. Bạn có thể rời trang, QLead sẽ tự cập nhật.' };
    case 'delayed': return { ...base, ...view, tone: 'warn', title: 'Lượt tìm thêm đang chậm hơn thường lệ', detail: 'Yêu cầu vẫn được giữ, bạn không cần bấm lại.' };
    case 'results': return { ...base, action: 'view_new', tone: 'success', title: `Tìm thêm được ${scan.newPosts} khách hàng mới`, detail: every };
    case 'no_results': return { ...base, ...view, tone: 'quiet', title: 'Đã tìm thêm, chưa có khách hàng mới', detail: every };
    case 'failed': return { ...base, ...view, tone: 'warn', title: 'Lượt tìm thêm chưa hoàn tất', detail: `Khách hàng đã tìm được vẫn được giữ. ${every}` };
  }
}

/** What "Tìm lại ngay" can do right now, so a click never pretends to start a search that cannot start. */
export type RescanButton = { show: boolean; disabled: boolean; label: string; hint?: string };

export function rescanButton(profile: SearchProfile, scan: ProfileScan | null, suspended: boolean, busy: boolean, waitUntil: number | null, now: number): RescanButton {
  if (!profile.enabled || suspended) return { show: false, disabled: true, label: 'Tìm lại ngay' };
  if (busy) return { show: true, disabled: true, label: 'Đang gửi…' };
  // While a search is waiting or running the status stage explains it; a disabled button would only add noise.
  if (scan && SCAN_OPEN.includes(scan.state)) return { show: false, disabled: true, label: 'Tìm lại ngay' };
  if (waitUntil && waitUntil > now) {
    const minutes = Math.max(1, Math.ceil((waitUntil - now) / 60_000));
    return { show: true, disabled: true, label: `Tìm lại sau ${minutes} phút`, hint: 'Vừa tìm xong với mô tả này.' };
  }
  return { show: true, disabled: false, label: 'Tìm lại ngay' };
}

/** A short line after "Tìm lại ngay" or "Lưu và tìm lại" when the request did not simply start a new search. */
export function requestNote(request: ScanRequestOutcome): { text: string; tone: 'ok' | 'warn' } | null {
  switch (request.outcome) {
    case 'queued': return null;
    case 'existing': return { text: 'Nhu cầu này đã có một lượt tìm, QLead không tạo thêm.', tone: 'ok' };
    case 'cooldown': return { text: `Vừa tìm xong với mô tả này. Bạn có thể tìm lại sau khoảng ${Math.ceil(request.retryAfterSeconds / 60)} phút.`, tone: 'warn' };
    case 'daily_limit': return { text: 'Hôm nay bạn đã dùng hết lượt tìm lại. QLead vẫn tự tìm theo lịch.', tone: 'warn' };
    case 'paused': return { text: 'Nhu cầu đang tạm dừng. Bật lại theo dõi để tìm.', tone: 'warn' };
    case 'suspended': return { text: 'Tài khoản đang tạm ngưng tìm khách mới nên chưa tìm lại được.', tone: 'warn' };
  }
}
