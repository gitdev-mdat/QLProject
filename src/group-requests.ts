import type { Pool, PoolClient } from 'pg';
import { GROUP_URL_ERRORS, normalizeFacebookGroupUrl } from './group-url.js';

/**
 * Customer Facebook group suggestions and their Admin review. Ownership is always the authenticated user id passed
 * by the caller. Review only records a decision: nothing here joins a group, fetches a URL or changes a Muse connector.
 */
export const GROUP_REQUEST_STATUSES = ['pending', 'reviewing', 'approved', 'rejected', 'added'] as const;
export type GroupRequestStatus = typeof GROUP_REQUEST_STATUSES[number];

// Approval is a decision; "added" means Admin joined the group and verified a worker can search it, so it needs approval first.
export const ALLOWED_TRANSITIONS: Record<GroupRequestStatus, GroupRequestStatus[]> = {
  pending: ['reviewing', 'approved', 'rejected'],
  reviewing: ['pending', 'approved', 'rejected'],
  approved: ['reviewing', 'added', 'rejected'],
  rejected: ['reviewing'],
  added: ['approved'],
};

export class GroupRequestError extends Error {
  constructor(public code: string, message: string, public status = 400, public existing?: unknown) { super(message); }
}

type Db = Pool | PoolClient;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
/** Strips control characters (keeps line breaks) and trims; returns null when nothing is left. */
export function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new GroupRequestError('invalid_note', 'Ghi chú không hợp lệ.');
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (text.length > max) throw new GroupRequestError('note_too_long', `Ghi chú tối đa ${max} ký tự.`);
  return text || null;
}

export type CustomerGroupRequest = { id: string; groupUrl: string; note: string | null; status: GroupRequestStatus; adminNote: string | null; createdAt: string; updatedAt: string };
const toCustomer = (r: any): CustomerGroupRequest => ({ id: r.id, groupUrl: r.group_url, note: r.note, status: r.status, adminNote: r.admin_note, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });

export async function listRequestsForUser(db: Db, userId: string): Promise<CustomerGroupRequest[]> {
  const { rows } = await db.query('SELECT id, group_url, note, status, admin_note, created_at, updated_at FROM facebook_group_requests WHERE user_id = $1 ORDER BY created_at DESC, id', [userId]);
  return rows.map(toCustomer);
}

export async function createRequest(db: Db, userId: string, input: { url: unknown; note?: unknown }): Promise<CustomerGroupRequest> {
  if (typeof input.url !== 'string') throw new GroupRequestError('empty', GROUP_URL_ERRORS.empty);
  const parsed = normalizeFacebookGroupUrl(input.url);
  if (!parsed.ok) throw new GroupRequestError(parsed.reason, GROUP_URL_ERRORS[parsed.reason]);
  const note = cleanText(input.note, 1000);
  const { rows } = await db.query(`INSERT INTO facebook_group_requests (user_id, group_key, group_url, submitted_url, note) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, group_key) DO NOTHING RETURNING id, group_url, note, status, admin_note, created_at, updated_at`, [userId, parsed.key, parsed.url, input.url.trim(), note]);
  if (rows[0]) return toCustomer(rows[0]);
  const { rows: [existing] } = await db.query('SELECT id, group_url, note, status, admin_note, created_at, updated_at FROM facebook_group_requests WHERE user_id = $1 AND group_key = $2', [userId, parsed.key]);
  throw new GroupRequestError('duplicate', 'Bạn đã đề xuất nhóm này rồi. Trạng thái hiện tại nằm trong "Yêu cầu của tôi".', 409, existing ? toCustomer(existing) : undefined);
}

export type AdminGroupRequest = CustomerGroupRequest & { requester: string; submittedUrl: string; reviewedAt: string | null; reviewer: string | null; sameGroupRequests: number };

export async function listRequestsForAdmin(db: Db): Promise<AdminGroupRequest[]> {
  const { rows } = await db.query(`SELECT r.*, u.display_name AS requester, rv.display_name AS reviewer,
      (SELECT count(*)::int FROM facebook_group_requests x WHERE x.group_key = r.group_key) AS same_group
    FROM facebook_group_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users rv ON rv.id = r.reviewed_by_user_id
    ORDER BY (r.status IN ('pending', 'reviewing')) DESC, r.created_at DESC, r.id LIMIT 500`);
  return rows.map(r => ({ ...toCustomer(r), requester: r.requester, submittedUrl: r.submitted_url, reviewedAt: iso(r.reviewed_at), reviewer: r.reviewer, sameGroupRequests: r.same_group }));
}

/** Admin decision. The caller must already have verified admin rights on the server. */
export async function updateRequestStatus(db: Db, adminUserId: string, id: string, input: { status: unknown; adminNote?: unknown }): Promise<CustomerGroupRequest> {
  const status = input.status as GroupRequestStatus;
  if (!GROUP_REQUEST_STATUSES.includes(status)) throw new GroupRequestError('invalid_status', 'Trạng thái không hợp lệ.');
  const adminNote = cleanText(input.adminNote, 1000);
  const { rows: [current] } = await db.query('SELECT status FROM facebook_group_requests WHERE id = $1 FOR UPDATE', [id]);
  if (!current) throw new GroupRequestError('not_found', 'Không tìm thấy yêu cầu.', 404);
  if (current.status !== status && !ALLOWED_TRANSITIONS[current.status as GroupRequestStatus].includes(status)) {
    throw new GroupRequestError('invalid_transition', status === 'added' ? 'Cần chấp thuận trước, rồi mới đánh dấu đã bổ sung sau khi xác minh nguồn.' : 'Không thể chuyển sang trạng thái này từ trạng thái hiện tại.', 409);
  }
  const { rows: [row] } = await db.query(`UPDATE facebook_group_requests SET status = $2, admin_note = $3, reviewed_by_user_id = $4, reviewed_at = now(), updated_at = now()
    WHERE id = $1 RETURNING id, group_url, note, status, admin_note, created_at, updated_at`, [id, status, adminNote, adminUserId]);
  return toCustomer(row);
}
