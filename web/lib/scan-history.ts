import type { ScanRun } from './server/leads';

const TZ = 'Asia/Ho_Chi_Minh';

/** Vietnam calendar day as YYYY-MM-DD, the same key the server groups the full history by. */
export function dayKey(value: string | number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function clockTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function scanTime(value: string): string {
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} - ${get('hour')}:${get('minute')}`;
}

/** "22:01" today, "Hôm qua 22:01", otherwise "31/10 22:01". Without a clock yet (server render) the date is always shown. */
export function shortScanTime(value: string, now: number): string {
  const day = dayKey(value);
  if (now && day === dayKey(now)) return clockTime(value);
  if (now && day === dayKey(now - 86_400_000)) return `Hôm qua ${clockTime(value)}`;
  return `${day.slice(8, 10)}/${day.slice(5, 7)} ${clockTime(value)}`;
}

/**
 * What a scan means for the customer, in one phrase. Success is implied by the wording, so no "Thành công" badge:
 * only failed and partial scans carry a status tag. A scan without new leads is a finished search, never a failure.
 */
export type ScanOutcome = { tone: 'leads' | 'none' | 'partial' | 'failed'; tag: string | null; text: string; count: number };

export function scanOutcome(scan: Pick<ScanRun, 'status' | 'newLeads'>): ScanOutcome {
  if (scan.status === 'failed') return { tone: 'failed', tag: 'Lỗi', text: 'Không nhận được kết quả', count: 0 };
  if (scan.status === 'partial') return { tone: 'partial', tag: 'Tìm chưa hết', text: scan.newLeads ? 'lead mới' : 'Chưa có lead mới', count: scan.newLeads };
  return scan.newLeads ? { tone: 'leads', tag: null, text: 'lead mới', count: scan.newLeads } : { tone: 'none', tag: null, text: 'Đã tìm xong · Chưa có lead mới', count: 0 };
}

/** A successful scan that added no lead: the common case on a 30-minute schedule, and the one that may be folded together. */
export const isQuiet = (scan: ScanRun) => scan.status === 'success' && scan.newLeads === 0;

export type RecentEntry = { kind: 'scan'; scan: ScanRun } | { kind: 'quiet'; scans: ScanRun[] };

/**
 * The dashboard's recent activity, newest first. The latest scan is always a full row; after it, scans that found
 * leads, failed or were partial are full rows (at most `max` full rows in all), and every run of back-to-back
 * successful scans without new leads between two of them becomes one folded line, whichever searches ran them.
 */
export function recentActivity(scans: ScanRun[], max = 3): RecentEntry[] {
  const entries: RecentEntry[] = [];
  let rows = 0;
  for (const [index, scan] of scans.entries()) {
    const last = entries.at(-1);
    if (index > 0 && isQuiet(scan)) {
      if (rows === max) break;
      if (last?.kind === 'quiet') last.scans.push(scan);
      else entries.push({ kind: 'quiet', scans: [scan] });
      continue;
    }
    if (rows === max) break;
    entries.push({ kind: 'scan', scan });
    rows += 1;
  }
  return entries;
}

/** Names of the searches behind a set of scans, newest first, without repeats. */
export function sourceNames(scans: ScanRun[]): string[] {
  return [...new Set(scans.map(scan => scan.profile?.name ?? 'Lượt quét trước'))];
}
