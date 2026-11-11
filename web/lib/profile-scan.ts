import { quietHoursState } from '../../src/quiet-hours';
import { USAGE_GATED_NOTE } from './engagement-gate';

/**
 * Customer-facing progress of the latest scan of one search profile, derived on the server from search_jobs and
 * scan_runs (never from browser state), so it survives refresh, navigation and other devices.
 *
 * queued:  the job exists and is eligible, nothing has picked it up yet. Not "searching".
 * running: a search claimed it and holds a valid lease. This is the only state that says work is happening.
 * delayed: waiting longer than expected, retrying, lease expired or blocked.
 * results / no_results / failed: what the finished scan actually recorded.
 */
export type ProfileScanState = 'queued' | 'running' | 'delayed' | 'results' | 'no_results' | 'failed';
/** 'followup': the one extra search QLead may run shortly after a first search that found little. */
export type ProfileScanKind = 'initial' | 'scheduled' | 'manual' | 'followup';

export type ProfileScan = {
  state: ProfileScanState;
  kind: ProfileScanKind;
  /** Configuration version this scan uses; lower than the profile's version when the profile was edited after it started. */
  version: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  newPosts: number | null;
  totalFound: number | null;
  scheduledFor: string | null;
  quietHours: ReturnType<typeof quietHoursState>;
};

export const SCAN_OPEN: ProfileScanState[] = ['queued', 'running', 'delayed'];

/** A queued scan with no pickup after this long is reported as delayed (the wake signal's last recovery is at 15 min). */
export const QUEUED_GRACE_MINUTES = 20;

export type ScanRow = {
  kind: ProfileScanKind; configuration_version: number; status: string; attempts: number; created_at: Date | string;
  lease_expires_at: Date | string | null; claimed_at: Date | string | null;
  run_status: string | null; run_at: Date | string | null; new_posts: number | null; total_found: number | null;
  scheduled_for: Date | string;
};

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

export function deriveProfileScan(row: ScanRow, now: number): ProfileScan {
  let state: ProfileScanState;
  if (row.run_at) state = row.run_status === 'failed' ? 'failed' : (row.new_posts ?? 0) > 0 ? 'results' : 'no_results';
  else if (row.status === 'failed') state = 'failed';
  else if (row.status === 'claimed') state = row.lease_expires_at && new Date(row.lease_expires_at).getTime() >= now ? 'running' : 'delayed';
  else if (row.status === 'blocked' || row.status === 'needs_reauthorization') state = 'delayed';
  else state = quietHoursState(new Date(now)).active ? 'queued'
    : row.attempts > 0 || now - new Date(row.created_at).getTime() > QUEUED_GRACE_MINUTES * 60_000 ? 'delayed' : 'queued';
  return {
    state, kind: row.kind, version: row.configuration_version, queuedAt: iso(row.created_at)!,
    startedAt: iso(row.claimed_at), finishedAt: iso(row.run_at),
    newPosts: row.run_at ? row.new_posts : null, totalFound: row.run_at ? row.total_found : null,
    scheduledFor: iso(row.scheduled_for), quietHours: quietHoursState(new Date(now)),
  };
}

export const SCAN_COPY: Record<ProfileScanState, { title: string; text: string }> = {
  queued: { title: 'Đã thêm lượt tìm mới vào hàng chờ.', text: 'QLead sẽ bắt đầu ngay khi hệ thống tìm kiếm nhận lượt này. Bạn có thể rời trang, trạng thái vẫn được lưu.' },
  running: { title: 'QLead đã nhận lượt tìm và đang xử lý.', text: 'Kết quả sẽ hiện ở đây ngay khi lượt tìm hoàn tất.' },
  delayed: { title: 'Lượt tìm đang chậm hơn dự kiến.', text: 'Yêu cầu vẫn được giữ trong hàng chờ và sẽ chạy khi hệ thống tìm kiếm sẵn sàng. Bạn không cần bấm lại.' },
  results: { title: 'Đã tìm thấy cơ hội phù hợp.', text: '' },
  no_results: { title: 'Đã hoàn tất lượt tìm, chưa có bài phù hợp.', text: 'Bạn có thể mô tả rõ hơn loại khách hoặc dấu hiệu cần tìm để QLead tìm đúng hơn.' },
  failed: { title: 'Lượt tìm chưa hoàn tất.', text: 'QLead sẽ thử lại ở lượt theo dõi kế tiếp. Nếu cần ngay, bạn có thể bấm tìm lại sau ít phút.' },
};

/** Request outcomes returned by POST /api/profiles/:id/scan and by "Lưu và tìm lại". */
export type ScanRequestOutcome =
  | { outcome: 'queued' | 'existing'; quietHoursActive?: boolean; nextAllowedScanAt?: string | null }
  | { outcome: 'cooldown'; retryAfterSeconds: number; lastFinishedAt: string }
  | { outcome: 'daily_limit' | 'paused' | 'suspended' | 'usage_gated' };

export function scanRequestMessage(request: ScanRequestOutcome): string {
  switch (request.outcome) {
    case 'queued': return 'Đã thêm lượt tìm mới vào hàng chờ.';
    case 'existing': return 'Nhu cầu này đang có một lượt tìm. QLead hiển thị trạng thái của lượt đó thay vì tạo thêm.';
    case 'cooldown': return `Nhu cầu này vừa được tìm xong với cùng điều kiện. Bạn có thể tìm lại sau khoảng ${Math.ceil(request.retryAfterSeconds / 60)} phút.`;
    case 'daily_limit': return 'Hôm nay bạn đã dùng hết lượt tìm lại. Lịch theo dõi tự động vẫn chạy bình thường.';
    case 'paused': return 'Nhu cầu đang tạm dừng. Bật lại theo dõi để tìm.';
    case 'suspended': return 'Tính năng tìm lead của tài khoản đang tạm dừng. Lượt tìm mới chưa được tạo.';
    case 'usage_gated': return USAGE_GATED_NOTE;
  }
}
