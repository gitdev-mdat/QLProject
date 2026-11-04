import type { GroupRequestStatus } from '../../src/group-requests';

/** Customer-facing wording: plain outcomes, no internal source or worker terms. */
export const customerStatusLabel: Record<GroupRequestStatus, string> = {
  pending: 'Chờ xem xét',
  reviewing: 'Đang xem xét',
  approved: 'Đã chấp thuận',
  rejected: 'Không thể hỗ trợ',
  added: 'Đã bổ sung vào nguồn tìm kiếm',
};

export const customerStatusHint: Record<GroupRequestStatus, string> = {
  pending: 'QLead sẽ xem nhóm này trong thời gian sớm nhất.',
  reviewing: 'QLead đang kiểm tra nhóm.',
  approved: 'QLead đồng ý bổ sung nhóm và đang chuẩn bị đưa vào nguồn tìm kiếm.',
  rejected: 'QLead chưa thể đưa nhóm này vào nguồn tìm kiếm.',
  added: 'Nhóm đã nằm trong nguồn tìm kiếm của QLead.',
};

export const adminStatusLabel: Record<GroupRequestStatus, string> = {
  pending: 'Chờ xem xét',
  reviewing: 'Đang xem xét',
  approved: 'Đã chấp thuận bổ sung',
  rejected: 'Không thể hỗ trợ',
  added: 'Đã bổ sung và xác minh nguồn',
};
