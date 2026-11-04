import type { LeadRecord } from '../../src/lead-data';

const DAY = 24 * 60 * 60 * 1000;

export function displayArea(lead: LeadRecord): string | null {
  if (lead.area.ambiguous) return 'Nhiều khu vực';
  return lead.area.location;
}

export function exactTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date(value));
}

/** Relative time ("25 phút trước") for the last six days, exact date after that. Requires a client-side `now`. */
export function relativeTime(value: string, now: number): string {
  if (!now) return exactTime(value);
  const elapsed = now - new Date(value).getTime();
  if (elapsed < 0 || elapsed > 6 * DAY) return exactTime(value);
  if (elapsed < 60_000) return 'Vừa xong';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} phút trước`;
  if (elapsed < DAY) return `${Math.floor(elapsed / (60 * 60_000))} giờ trước`;
  return `${Math.floor(elapsed / DAY)} ngày trước`;
}

export function isRecent(value: string | null, now: number, windowMs = DAY): boolean {
  if (!value) return false;
  const elapsed = now - new Date(value).getTime();
  return elapsed >= 0 && elapsed < windowMs;
}

/**
 * Human label for where the post was found. Only known Facebook source types are shown; other stored values
 * (collection tool names such as 'qlead_shared_worker' or 'Muse') are internal and never reach customers.
 */
export function sourceLabel(lead: LeadRecord): string | null {
  const labels: Record<string, string> = { group: 'Nhóm Facebook', page: 'Trang Facebook', profile: 'Trang cá nhân', public_post: 'Bài đăng công khai' };
  return labels[lead.source_type ?? ''] ?? labels[lead.collected_via ?? ''] ?? null;
}

/**
 * Business signals: events a post literally mentions (opening, hiring, a new branch…). A signal describes the
 * business, never a purchase. Matching is phrase-based, so a signal is only shown when the post says it; nothing
 * is inferred from the search region or the scan time. Server-side signal extraction does not exist yet.
 */
type Signal = { label: string; pattern: RegExp };
const signals: Signal[] = [
  { label: 'Sắp mở cửa', pattern: /(?:sắp|chuẩn bị|dự kiến)\s+(?:khai trương|mở cửa|đi vào hoạt động|mở(?!\s+(?:thêm|chi)))/iu },
  { label: 'Mới mở', pattern: /(?:mới|vừa)\s+(?:khai trương|mở cửa|mở(?!\s+(?:thêm|chi)))/iu },
  { label: 'Mở chi nhánh', pattern: /mở\s+(?:thêm\s+)?chi\s+nhánh|chi\s+nhánh\s+(?:thứ|mới)/iu },
  { label: 'Đang tuyển nhân sự', pattern: /tuyển\s+(?:dụng|gấp|thêm|\d+|nhân\s+viên|lễ\s+tân|pha\s+chế|phục\s+vụ|thu\s+ngân|bếp|phụ\s+bếp|chạy\s+bàn|quản\s+lý|buồng\s+phòng|các\s+bạn)/iu },
  { label: 'Tìm / thuê mặt bằng', pattern: /(?:tìm|thuê|sang\s+nhượng)\s+(?:xong\s+)?mặt\s+bằng/iu },
];

export function detectSignals(content: string): string[] {
  return signals.filter(signal => signal.pattern.test(content)).map(signal => signal.label);
}

export type LeadReading = {
  /** What the post actually says: the sentence carrying the need or the signal, quoted verbatim. */
  evidence: string;
  /** `stated_need`: the poster asks for something. `business_signal`: only a business event is mentioned. */
  kind: 'stated_need' | 'business_signal' | 'unclassified';
  signals: string[];
};

function sentences(content: string): string[] {
  return content.split(/(?<=[.!?])\s+/u).map(sentence => sentence.trim()).filter(Boolean);
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Separates what the post says from the business signals it mentions. The salesperson judges the rest. */
export function readLead(content: string, need: string | null): LeadReading {
  const found = signals.filter(signal => signal.pattern.test(content));
  const kind = need ? 'stated_need' : found.length ? 'business_signal' : 'unclassified';
  const signalSentence = found.length ? sentences(content).find(sentence => found[0].pattern.test(sentence)) : undefined;
  const evidence = clip(need ?? signalSentence ?? sentences(content)[0] ?? content);
  return { evidence, kind, signals: found.map(signal => signal.label) };
}


export async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; }
  catch { return false; }
}
