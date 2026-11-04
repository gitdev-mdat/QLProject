import { QUEUED_GRACE_MINUTES, type ProfileScan } from './profile-scan';

/**
 * Customer-facing state of a saved search profile, derived on the server from scan_configs, scan_runs and
 * search_jobs. Nothing here describes workers or connectors.
 */
export type ProfileState = 'draft' | 'paused' | 'pending_first_scan' | 'active' | 'waiting_worker' | 'delayed' | 'attention';

export type SearchProfile = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  versions: number;
  /** True once the search terms or area were edited (pausing and resuming also add versions, but change neither). */
  conditionsChanged: boolean;
  keywords: string[];
  /** 'description': QLead generated the phrases from the description. 'manual': the customer maintains them. */
  keywordsSource: 'description' | 'manual';
  /** '' when the customer set no geographic limit. */
  location: string;
  frequencyMinutes: number;
  /** The scan to show progress for: an open one, or a finished one the customer asked for recently. */
  scan: ProfileScan | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastScan: { at: string; status: string; newPosts: number; totalFound: number } | null;
  lastSuccessAt: string | null;
  leadCount: number;
  state: ProfileState;
};

/** Leads stored by older integrations that recorded no search request. */
export type LegacySummary = { leadCount: number; lastScanAt: string | null };

export const PROFILE_STATE_LABEL: Record<ProfileState, string> = {
  draft: 'Bản nháp',
  paused: 'Tạm dừng',
  pending_first_scan: 'Chờ lượt quét đầu',
  active: 'Đang theo dõi',
  waiting_worker: 'Đến lịch · chờ xử lý',
  delayed: 'Đang chậm',
  attention: 'Cần kiểm tra',
};

export const PROFILE_STATE_HINT: Record<ProfileState, string> = {
  draft: 'Đã lưu nhưng chưa bật theo dõi.',
  paused: 'Không quét bài mới. Lead cũ vẫn được giữ.',
  pending_first_scan: 'Lượt quét đầu tiên sẽ chạy trong lịch tới.',
  active: 'Đang theo dõi. Lượt tiếp theo sẽ được đưa vào xử lý khi đến lịch.',
  waiting_worker: 'Lượt theo dõi đã đến lịch và đang chờ hệ thống nhận việc. Bạn không cần bấm lại.',
  delayed: 'Lượt theo dõi đã quá lịch dự kiến và chưa được nhận xử lý. Yêu cầu vẫn được giữ; bạn không cần bấm lại.',
  attention: 'Lượt quét gần nhất không thành công. QLead đang xử lý.',
};

export const PROFILE_FREQUENCIES = [30, 60, 360, 1440] as const;

export const NO_LOCATION_LABEL = 'Không giới hạn khu vực';
/** The same choice inside a select labelled "Khu vực", where the short form fits. */
export const NO_LOCATION_OPTION = 'Không giới hạn';
export const locationLabel = (location: string) => location || NO_LOCATION_LABEL;

export function frequencyLabel(minutes: number): string {
  if (minutes === 1440) return 'mỗi ngày';
  if (minutes % 60 === 0) return minutes === 60 ? 'mỗi giờ' : `mỗi ${minutes / 60} giờ`;
  return `mỗi ${minutes} phút`;
}

/** A profile is being monitored when it is enabled, whatever the latest scan outcome. */
export function isMonitoring(profile: SearchProfile): boolean {
  return profile.enabled;
}

export function deriveProfileState(input: { enabled: boolean; everEnabled: boolean; frequencyMinutes: number; enabledSince: string; lastScan: SearchProfile['lastScan']; lastSuccessAt: string | null; blocked: boolean; recurringDueAt?: string | null }, now: number): ProfileState {
  if (!input.enabled) return input.everEnabled ? 'paused' : 'draft';
  if (input.blocked || input.lastScan?.status === 'failed') return 'attention';
  const grace = 2 * input.frequencyMinutes * 60_000;
  const reference = Math.max(new Date(input.enabledSince).getTime(), input.lastSuccessAt ? new Date(input.lastSuccessAt).getTime() : 0);
  if (input.recurringDueAt) return now - new Date(input.recurringDueAt).getTime() > QUEUED_GRACE_MINUTES * 60_000 || now - reference > grace ? 'delayed' : 'waiting_worker';
  if (now - reference <= grace) return input.lastSuccessAt ? 'active' : 'pending_first_scan';
  return 'delayed';
}
