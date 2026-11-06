/**
 * Coarse device facts for a sign-in, parsed once from the User-Agent header and then discarded: the raw string is never
 * stored or logged. Only broad families are returned (no versions, models or anything that narrows down one device),
 * and anything not recognised is null so the Admin sees "Không rõ" instead of a guess.
 *
 * Known limit: iPadOS Safari presents itself as macOS desktop by default, so such a sign-in is recorded as desktop/macOS.
 */
export type LoginDevice = { device: 'desktop' | 'mobile' | 'tablet' | null; os: string | null; browser: string | null };

const MAX_UA = 512;

export function loginDevice(userAgent: string | null | undefined): LoginDevice {
  const ua = (userAgent ?? '').slice(0, MAX_UA);
  if (!ua.trim()) return { device: null, os: null, browser: null };

  let os: string | null = null;
  if (/iPad/.test(ua)) os = 'iPadOS';
  else if (/iPhone|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows NT|Windows Phone/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux|X11/.test(ua)) os = 'Linux';

  let device: LoginDevice['device'] = null;
  if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) device = 'mobile';
  else if (os && ['Windows', 'macOS', 'Linux', 'ChromeOS'].includes(os)) device = 'desktop';

  // Order matters: most browsers also claim "Chrome" and "Safari", so the specific ones are checked first.
  let browser: string | null = null;
  if (/FBAN|FBAV|FB_IAB/.test(ua)) browser = 'Facebook (trong ứng dụng)';
  else if (/Zalo/i.test(ua)) browser = 'Zalo (trong ứng dụng)';
  else if (/coc_coc_browser|CocCoc/i.test(ua)) browser = 'Cốc Cốc';
  else if (/Edg(A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';

  return { device, os, browser };
}

export const DEVICE_LABEL = { desktop: 'Máy tính', mobile: 'Điện thoại', tablet: 'Máy tính bảng' } as const;
