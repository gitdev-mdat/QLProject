/**
 * Facebook group URL normalization for customer group suggestions. Pure string handling: the URL is never
 * fetched. Equivalent variants (m./web./mbasic. hosts, http, trailing paths, query strings, letter case of a
 * vanity name) map to the same key, so one customer cannot file the same group twice.
 */
const HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com', 'touch.facebook.com']);
// Paths under /groups/ that are Facebook pages, not a specific group.
const RESERVED = new Set(['feed', 'discover', 'joins', 'create', 'search', 'notifications', 'your_groups', 'categories', 'browse']);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type GroupUrlResult = { ok: true; key: string; url: string } | { ok: false; reason: 'empty' | 'too_long' | 'malformed' | 'not_facebook' | 'not_group' };

export function normalizeFacebookGroupUrl(input: string): GroupUrlResult {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > 2048) return { ok: false, reason: 'too_long' };
  if (/\s/.test(raw)) return { ok: false, reason: 'malformed' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, reason: 'malformed' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'malformed' };
  if (url.username || url.password || url.port) return { ok: false, reason: 'malformed' };
  if (!HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: 'not_facebook' };
  const [first, key] = url.pathname.split('/').filter(Boolean);
  if (first?.toLowerCase() !== 'groups' || !key) return { ok: false, reason: 'not_group' };
  let decoded: string;
  try { decoded = decodeURIComponent(key); } catch { return { ok: false, reason: 'malformed' }; }
  if (!KEY.test(decoded) || RESERVED.has(decoded.toLowerCase())) return { ok: false, reason: 'not_group' };
  const normalized = decoded.toLowerCase();
  return { ok: true, key: normalized, url: `https://www.facebook.com/groups/${normalized}` };
}

export const GROUP_URL_ERRORS: Record<Exclude<GroupUrlResult, { ok: true }>['reason'], string> = {
  empty: 'Hãy nhập đường dẫn nhóm Facebook.',
  too_long: 'Đường dẫn quá dài.',
  malformed: 'Đường dẫn không hợp lệ. Hãy copy đường dẫn từ thanh địa chỉ khi đang mở nhóm.',
  not_facebook: 'Chỉ nhận đường dẫn facebook.com.',
  not_group: 'Đây không phải đường dẫn một nhóm Facebook. Đường dẫn nhóm có dạng facebook.com/groups/tên-hoặc-số-nhóm.',
};
