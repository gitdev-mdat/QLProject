import type { AdminUserMonitoring } from './server/monitoring';

/** Shared by the /admin/users server page and its client component. Display rules only; the server owns every state. */
export const USERS_PAGE_SIZE = 25;

export type AdminUserRow = AdminUserMonitoring;
export type AdminUserProfile = {
  id: string; name: string; profileStatus: string; enabled: boolean; version: number; frequencyMinutes: number;
  description: string | null; lastScanAt: string | null; leadCount: number;
};
export type AdminUserDetail = AdminUserRow & { profiles: AdminUserProfile[] };
export type AdminUserPage = { users: AdminUserRow[]; total: number; limit: number; offset: number };
export type MonitoringChange = {
  changed: boolean; userId: string; status: 'active' | 'suspended'; changedAt: string; changedByUserId: string | null;
  suspendedAt: string | null; suspendedByUserId: string | null; reason: string | null; inFlightJobCount: number;
};
export type UserDeletionImpact = {
  targetUserId: string; profileCount: number; legacyConnectionCount: number; museCredentialCount: number; searchConfigCount: number; jobCount: number; attemptCount: number;
  scanCount: number; customerLeadCount: number; leadStatusCount: number; noteCount: number;
  sessionCount: number; loginCredentialCount: number; groupRequestCount: number;
  activeJobs: Array<{ profileName: string; leaseExpiresAt: string }>;
};

export const MONITORING_LABEL = { active: 'Đang tìm lead', suspended: 'Đã ngưng tìm lead' } as const;

/** A profile's own setting and what the account status does to it, kept apart so the Admin never mistakes one for the other. */
export function profileEffect(profile: AdminUserProfile, account: 'active' | 'suspended'): { label: string; tone: 'ok' | 'paused' | 'blocked' | 'removed'; note: string } {
  if (profile.profileStatus !== 'active') return { label: 'Đã xóa', tone: 'removed', note: 'Khách đã xóa nhu cầu này.' };
  if (!profile.enabled) return { label: 'Khách tạm dừng', tone: 'paused', note: account === 'suspended' ? 'Khách tự tạm dừng. Vẫn giữ tạm dừng sau khi kích hoạt lại.' : 'Khách tự tạm dừng nhu cầu này.' };
  if (account === 'suspended') return { label: 'Không quét mới', tone: 'blocked', note: 'Khách vẫn bật, nhưng tài khoản đang ngưng tìm lead. Tự quét lại khi kích hoạt.' };
  return { label: 'Đang theo dõi', tone: 'ok', note: 'Quét theo lịch.' };
}

export function frequencyText(minutes: number): string {
  if (minutes % 1440 === 0) return `mỗi ${minutes / 1440} ngày`;
  if (minutes % 60 === 0) return `mỗi ${minutes / 60} giờ`;
  return `mỗi ${minutes} phút`;
}

export function apiErrorText(status: number, data: { error?: string; message?: string } | null, what: 'list' | 'detail' | 'change' | 'deletion'): string {
  if (status === 0) return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  if (status === 401) return 'Phiên đăng nhập đã hết hạn. Đăng nhập lại để tiếp tục.';
  if (status === 409 && data?.error === 'active_jobs') return 'Khách đang có lượt tìm chạy dở. Đợi lượt tìm kết thúc rồi thử lại.';
  if (status === 403 && data?.error === 'protected_admin') return 'Đây là tài khoản quản trị viên nên không thể xóa tại đây.';
  if (status === 403 && data?.error === 'self_delete') return 'Bạn không thể tự xóa tài khoản đang đăng nhập.';
  if (status === 400 && (data?.error === 'stale_confirmation' || data?.error === 'invalid_confirmation')) return 'Xác nhận không khớp với tài khoản đang mở. Đóng hộp thoại, mở lại khách hàng rồi thử lại.';
  if (status === 403) return 'Máy chủ từ chối yêu cầu vì không xác minh được phiên quản trị. Tải lại trang rồi thử lại.';
  if (status === 404) return what === 'list' ? 'Tài khoản này không có quyền quản trị.' : what === 'deletion' ? 'Tài khoản này không còn tồn tại, có thể đã được xóa ở nơi khác.' : 'Không tìm thấy khách hàng này. Có thể tài khoản đã bị xóa.';
  if (status === 400) return what === 'list' ? 'Từ khóa hoặc số trang không hợp lệ.' : what === 'change' ? 'Yêu cầu không hợp lệ. Lý do tối đa 1000 ký tự.' : 'Yêu cầu không hợp lệ. Tải lại trang rồi thử lại.';
  if (what === 'deletion') return data?.message ?? 'Máy chủ không xóa được tài khoản. Chưa có thay đổi nào; thử lại sau ít phút.';
  return data?.message ?? 'Máy chủ gặp lỗi. Thử lại sau ít phút.';
}
