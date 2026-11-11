export const QUIET_HOURS_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const QUIET_HOURS_START_MINUTE = 30;
export const QUIET_HOURS_END_MINUTE = 6 * 60 + 30;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export type QuietHoursState = { active: boolean; timeZone: typeof QUIET_HOURS_TIME_ZONE; nextAllowedScanAt: string | null };

function vietnamParts(at: Date): { year: number; month: number; day: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: QUIET_HOURS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), minuteOfDay: get('hour') * 60 + get('minute') };
}

export function isSearchQuietHours(at = new Date()): boolean {
  const { minuteOfDay } = vietnamParts(at);
  return minuteOfDay >= QUIET_HOURS_START_MINUTE && minuteOfDay < QUIET_HOURS_END_MINUTE;
}

export function nextAllowedScanAt(at = new Date()): Date | null {
  const parts = vietnamParts(at);
  if (parts.minuteOfDay < QUIET_HOURS_START_MINUTE || parts.minuteOfDay >= QUIET_HOURS_END_MINUTE) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 6, 30) - VIETNAM_OFFSET_MS);
}

export function quietHoursState(at = new Date()): QuietHoursState {
  const next = nextAllowedScanAt(at);
  return { active: next !== null, timeZone: QUIET_HOURS_TIME_ZONE, nextAllowedScanAt: next?.toISOString() ?? null };
}
