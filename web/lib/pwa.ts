/**
 * Browser-side facts about installing QLead and Web Push support. Every function is safe to call during render on the
 * server (it then reports the most conservative answer), but the UI only trusts them after mount.
 */

export type Platform = 'ios' | 'android' | 'desktop' | 'other';

/** The install path the browser actually offers. Only these are shown; nothing is promised for other browsers. */
export type InstallPath =
  | 'installed'        // already running as the Home Screen / desktop app
  | 'prompt'           // Chromium fired beforeinstallprompt: one tap opens the native dialog
  | 'ios-safari'       // iPhone/iPad Safari: Share → Add to Home Screen
  | 'ios-other'        // iOS in another browser or an in-app browser: open in Safari first (iOS 16.4–17.x)
  | 'unavailable';     // nothing reliable to offer (desktop Firefox, Chromium before its prompt fires, …)

type NavigatorExtras = Navigator & { standalone?: boolean; userAgentData?: { mobile?: boolean; platform?: string } };

const hasWindow = () => typeof window !== 'undefined' && typeof navigator !== 'undefined';

export function detectPlatform(): Platform {
  if (!hasWindow()) return 'other';
  const nav = navigator as NavigatorExtras;
  const ua = nav.userAgent;
  // iPadOS 13+ reports itself as a Mac; a touch-capable "Mac" is an iPad.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (nav.userAgentData?.mobile === false || /Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

/** True when QLead runs from the Home Screen / as an installed app window. */
export function isStandalone(): boolean {
  if (!hasWindow()) return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || window.matchMedia?.('(display-mode: minimal-ui)').matches
    || (navigator as NavigatorExtras).standalone === true;
}

/** Safari on iOS, not Chrome/Firefox/Edge for iOS (CriOS/FxiOS/EdgiOS) or an in-app browser (Facebook, Zalo, …). */
export function isIosSafari(): boolean {
  if (!hasWindow()) return false;
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\//i.test(ua)) return false;
  return /Safari\//i.test(ua) && /Version\//i.test(ua);
}

/** iOS major version, or null when not iOS / unknown. Web Push on iOS needs 16.4+ and a Home Screen app. */
export function iosVersion(): number | null {
  if (!hasWindow()) return null;
  const match = navigator.userAgent.match(/OS (\d+)_(\d+)/i) ?? navigator.userAgent.match(/Version\/(\d+)\.(\d+)/i);
  // Compared as major + minor/100: "16_4" is 16.04, so callers compare against 16.04 (not 16.4, which reads as 16.40).
  return match ? Number(match[1]) + Number(match[2]) / 100 : null;
}

/** Whether this context can use the Push API at all right now. */
export function pushSupported(): boolean {
  if (!hasWindow()) return false;
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Why push cannot be enabled here, in the order a person would fix it. iOS only exposes Web Push to Home Screen apps
 * (16.4+), so a Safari tab is told to add QLead to the Home Screen first rather than shown a broken button.
 */
export function pushBlocker(): 'ios-needs-install' | 'ios-too-old' | 'unsupported' | null {
  const platform = detectPlatform();
  if (platform === 'ios') {
    const version = iosVersion();
    if (version !== null && version < 16.04) return 'ios-too-old';
    if (!isStandalone()) return 'ios-needs-install';
  }
  return pushSupported() ? null : 'unsupported';
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

/** Small persistent flags (dismissals, visit counts). Storage can be unavailable (private mode); every call tolerates that. */
export const localFlag = {
  get(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key: string): void { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
};
