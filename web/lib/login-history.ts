import { DEVICE_LABEL } from './login-device';

/**
 * One successful sign-in as the Admin sees it. Built from web_sessions (when, how, and the session's current state)
 * plus web_login_events (coarse device facts, only for sign-ins after migration 020). Never carries a token, token
 * hash, cookie, IP address or raw User-Agent.
 */
export type LoginHistoryEntry = {
  id: string;
  signedInAt: string;
  method: 'password' | 'register' | 'dev_quick_login';
  /** False for sessions created before device facts were recorded: device/os/browser are then unknown, not guessed. */
  recorded: boolean;
  device: 'desktop' | 'mobile' | 'tablet' | null;
  os: string | null;
  browser: string | null;
  session: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  revokedAt: string | null;
};

export type LoginHistoryFilter = 'all' | 'active';

export type LoginHistoryPage = {
  userId: string;
  total: number;
  activeCount: number;
  lastSignInAt: string | null;
  page: number;
  pageSize: number;
  filter: LoginHistoryFilter;
  entries: LoginHistoryEntry[];
};

export const LOGIN_HISTORY_PAGE_SIZE = 20;

export const LOGIN_METHOD_LABEL = { password: 'Email/mật khẩu', register: 'Đăng ký tài khoản', dev_quick_login: 'Đăng nhập nhanh (DEV)' } as const;
export const SESSION_STATE_LABEL = { active: 'Đang hoạt động', expired: 'Đã hết hạn', revoked: 'Đã kết thúc' } as const;

/** "Windows · Chrome", "Điện thoại · iOS · Safari"; null when nothing is known (the UI then says "Không rõ"). */
export function deviceText(entry: Pick<LoginHistoryEntry, 'device' | 'os' | 'browser'>): string | null {
  const parts = [entry.device && entry.device !== 'desktop' ? DEVICE_LABEL[entry.device] : null, entry.os, entry.browser].filter(Boolean);
  if (!parts.length && entry.device === 'desktop') return DEVICE_LABEL.desktop;
  return parts.length ? parts.join(' · ') : null;
}
