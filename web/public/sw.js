/*
 * QLead service worker: push notifications only.
 *
 * It has no fetch handler and uses no Cache Storage, so pages, API responses, lead data and credentials never pass
 * through it or get stored by it; the browser loads everything from the network exactly as without a worker.
 * Bump SW_VERSION when this file changes (the browser re-checks /sw.js on every navigation; see next.config.ts).
 */
const SW_VERSION = '2026-11-05.1';
const FALLBACK_URL = '/app/bai-viet';
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';

self.addEventListener('install', () => {
  // Nothing is cached, so a new version can take over at once without serving stale assets.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Earlier experiments or tools may have left caches on this origin; the push-only worker keeps none.
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'qlead:sw-version' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: SW_VERSION });
});

/** Only same-origin paths inside the signed-in app are allowed as destinations; anything else opens the lead list. */
function safeAppPath(value) {
  if (typeof value !== 'string' || value.length > 512) return FALLBACK_URL;
  let url;
  try { url = new URL(value, self.location.origin); } catch { return FALLBACK_URL; }
  if (url.origin !== self.location.origin) return FALLBACK_URL;
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return FALLBACK_URL;
  return url.pathname + url.search + url.hash;
}

function text(value, fallback, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const kind = data.kind === 'test' ? 'test' : 'new_leads';
  const title = text(data.title, kind === 'test' ? 'QLead' : 'QLead có cơ hội mới', 80);
  const body = text(data.body, kind === 'test' ? 'Thông báo đã bật trên thiết bị này.' : 'Nhấn để xem khách hàng tiềm năng mới.', 180);
  const tag = text(data.tag, kind === 'test' ? 'qlead-test' : 'new-leads', 64);
  const url = kind === 'test' ? safeAppPath(data.url || '/app') : safeAppPath(data.url);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: ICON,
    badge: BADGE,
    tag,
    // A newer batch replaces the previous one under the same tag, and still alerts the user.
    renotify: true,
    lang: 'vi',
    timestamp: Date.now(),
    data: { url },
  }));
});

/**
 * Focuses a QLead window and sends it to the lead page, or opens one. /mo checks the session on the server: signed in
 * → the lead page; signed out or expired → login, then back to the lead page.
 */
async function openFromNotification(url) {
  const opener = `/mo?den=${encodeURIComponent(safeAppPath(url))}`;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const same = windows.filter(client => new URL(client.url).origin === self.location.origin);
  // Prefer a QLead window that is already in the app; otherwise any QLead window.
  const existing = same.find(client => new URL(client.url).pathname.startsWith('/app')) || same[0];
  if (existing) {
    try {
      const focused = await existing.focus();
      if (focused && 'navigate' in focused) {
        const navigated = await focused.navigate(opener);
        if (navigated) return 'focused';
      }
    } catch { /* navigate() fails for windows this worker does not control; open a new one instead. */ }
  }
  await self.clients.openWindow(opener);
  return 'opened';
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openFromNotification(event.notification.data && event.notification.data.url));
});

// The push service rotated or expired the subscription: subscribe again with the same key and tell the server.
// If the session has ended the server refuses it, and the app re-registers on its next open (see lib/push-client.ts).
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      let next = event.newSubscription || null;
      const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!next && key) next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (!next) return;
      await fetch('/api/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: next.toJSON(), platform: 'other', standalone: false, origin: self.location.origin }),
      });
    } catch { /* Best effort; the app repairs the subscription when it is next opened. */ }
  })());
});
