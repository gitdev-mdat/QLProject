// PWA install + Web Push UX checks on a production build (`next start`) against muse_bridge_test_nav
// (seed: web/e2e/nav-perf-seed.mts). Usage from web/: npx tsx e2e/pwa-push-e2e.mts <baseUrl> <seed.json> [shotsDir]
//
// What this can and cannot prove. Headless Chromium has no push service (pushManager.subscribe → "Registration failed"),
// and the backend /api/push/* is Codex's work, so in this script:
//   • /api/push/* is answered by an in-test stub that follows docs/pwa-push/PUSH_API_CONTRACT.md (context.route);
//   • PushManager.subscribe/getSubscription are replaced by a fake subscription in the page;
//   • push delivery is simulated with the DevTools ServiceWorker.deliverPushMessage command against the real sw.js.
// Real push delivery, real notification taps and real installs need physical devices and the real backend.
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [BASE = 'http://localhost:3100', SEED = 'nav-perf-seed.json', SHOTS_ARG] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Record<'large' | 'empty' | 'admin', { userId: string; token: string }>;
const SHOTS = resolve(SHOTS_ARG ?? 'docs/pwa-push-20261105/screenshots');
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = new URL(BASE).origin;

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const detail = await fn(); results.push({ name, pass: true, detail: detail ?? '' }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  catch (error) { const detail = (error as Error).message.split('\n')[0]; results.push({ name, pass: false, detail }); console.log(`FAIL ${name} — ${detail}`); }
}
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
// CHROME_PATH: a Chromium/Chrome binary when playwright-core's own browser is not installed (the new headless mode is needed for notifications).
const browser = await chromium.launch({ channel: 'chromium', ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });

type Backend = { enabled: boolean; endpoints: Set<string>; calls: string[]; failNext?: number };

/** In-test stand-in for Codex's /api/push/* (contract: docs/pwa-push/PUSH_API_CONTRACT.md). Not shipped. */
async function stubBackend(context: BackendContext, backend: Backend) {
  await context.route('**/api/push/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() as { endpoint?: string; subscription?: { endpoint?: string } } | null;
    backend.calls.push(`${request.method()} ${path}`);
    if (backend.failNext) { backend.failNext -= 1; return route.fulfill({ status: 502, json: { error: 'push_failed' } }); }
    if (path === '/api/push/config') return route.fulfill({ json: backend.enabled ? { enabled: true, vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } : { enabled: false } });
    if (path === '/api/push/subscription' && request.method() === 'PUT') { backend.endpoints.add(body?.subscription?.endpoint ?? ''); return route.fulfill({ json: { subscribed: true } }); }
    if (path === '/api/push/subscription' && request.method() === 'DELETE') { backend.endpoints.delete(body?.endpoint ?? ''); return route.fulfill({ json: { subscribed: false } }); }
    if (path === '/api/push/subscription/status') return route.fulfill({ json: { subscribed: backend.endpoints.has(body?.endpoint ?? '') } });
    if (path === '/api/push/test') return backend.endpoints.has(body?.endpoint ?? '') ? route.fulfill({ status: 202, json: { sent: true } }) : route.fulfill({ status: 404, json: { error: 'not_subscribed' } });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}
type BackendContext = BrowserContext;

/** Headless Chromium has no push service; a fake subscription lets the UI flow run end to end. */
const FAKE_PUSH = `(() => {
  if (!('PushManager' in self)) return;
  const read = () => JSON.parse(localStorage.getItem('__fakeSub') || 'null');
  const make = data => data && ({ endpoint: data.endpoint, options: { applicationServerKey: null }, toJSON: () => ({ endpoint: data.endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { localStorage.removeItem('__fakeSub'); return true; } });
  PushManager.prototype.getSubscription = async function () { return make(read()); };
  PushManager.prototype.subscribe = async function () { const next = { endpoint: 'https://push.example/ep-' + Math.random().toString(36).slice(2) }; localStorage.setItem('__fakeSub', JSON.stringify(next)); return make(next); };
})()`;

async function ctx(opts: { token?: string | null; width: number; height?: number; ua?: string; mobile?: boolean; permission?: 'granted' | 'denied' | 'default'; fakePush?: boolean; backend?: Backend }) {
  const mobile = opts.mobile ?? opts.width < 768;
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height ?? 860 }, baseURL: BASE, ...(opts.ua ? { userAgent: opts.ua } : {}), ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript('window.__name = (f) => f');
  if (opts.permission === 'granted') await context.grantPermissions(['notifications'], { origin: ORIGIN });
  if (opts.permission === 'denied') await context.addInitScript(`Object.defineProperty(Notification, 'permission', { get: () => 'denied' }); Notification.requestPermission = async () => 'denied';`);
  if (opts.permission === 'default') await context.addInitScript(`(() => { let p = 'default'; Object.defineProperty(Notification, 'permission', { get: () => p }); Notification.requestPermission = async () => { window.__asked = (window.__asked || 0) + 1; return p = 'default'; }; })()`);
  if (opts.fakePush) await context.addInitScript(FAKE_PUSH);
  if (opts.backend) await stubBackend(context, opts.backend);
  if (opts.token !== null) await context.addCookies([{ name: 'qlead_session', value: opts.token ?? seed.large.token, url: BASE }]);
  const page = await context.newPage();
  return { context, page };
}
const card = (page: Page) => page.locator('#thong-bao');
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ── Manifest, icons, headers ────────────────────────────────────────────────────────────────────────────────────────
await check('manifest: id, scope, start_url, standalone, PNG + maskable icons, theme', async () => {
  const response = await fetch(`${BASE}/manifest.webmanifest`);
  const manifest = await response.json() as { id: string; scope: string; start_url: string; display: string; icons: Array<{ src: string; sizes: string; purpose?: string }>; theme_color: string; background_color: string };
  assert(manifest.id === '/' && manifest.scope === '/' && manifest.start_url === '/app' && manifest.display === 'standalone', 'identity/scope/display');
  for (const need of ['192x192', '512x512']) assert(manifest.icons.some(icon => icon.sizes === need && icon.purpose === 'any'), `missing ${need}`);
  assert(manifest.icons.some(icon => icon.purpose === 'maskable'), 'no maskable');
  for (const icon of manifest.icons) { const r = await fetch(`${BASE}${icon.src}`); assert(r.ok, `${icon.src} ${r.status}`); }
  return `${manifest.icons.length} icons, theme ${manifest.theme_color}`;
});

await check('apple-touch-icon + Home Screen meta tags on every page', async () => {
  for (const path of ['/', '/dang-nhap']) {
    const html = await (await fetch(`${BASE}${path}`)).text();
    assert(html.includes('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"'), `apple-touch-icon on ${path}`);
    assert(html.includes('name="apple-mobile-web-app-capable"') || html.includes('name="mobile-web-app-capable"'), `capable meta on ${path}`);
    assert(html.includes('viewport-fit=cover'), `viewport-fit on ${path}`);
  }
  assert((await fetch(`${BASE}/icons/apple-touch-icon.png`)).ok, 'apple icon 404');
});

await check('sw.js: no-store, JS type, strict CSP; worker has no fetch handler and no caching', async () => {
  const response = await fetch(`${BASE}/sw.js`);
  assert(/no-store/.test(response.headers.get('cache-control') ?? ''), 'cache-control');
  assert(/javascript/.test(response.headers.get('content-type') ?? ''), 'content-type');
  assert(/default-src 'self'/.test(response.headers.get('content-security-policy') ?? ''), 'csp');
  const source = await response.text();
  assert(!/addEventListener\(\s*['"]fetch['"]/.test(source), 'fetch handler present');
  assert(!/caches\.open|cache\.put|cache\.add/.test(source), 'cache writes present');
});

// ── Deep link entry (/mo) ───────────────────────────────────────────────────────────────────────────────────────────
await check('/mo: signed out keeps a safe destination for after login; hostile destinations fall back', async () => {
  const cases: Array<[string, string]> = [
    ['/app/bai-viet/123', '/dang-nhap?tiep=%2Fapp%2Fbai-viet%2F123'],
    ['https://evil.example/app', '/dang-nhap?tiep=%2Fapp%2Fbai-viet'],
    ['//evil.example/app', '/dang-nhap?tiep=%2Fapp%2Fbai-viet'],
    ['/\\evil.example', '/dang-nhap?tiep=%2Fapp%2Fbai-viet'],
    ['/admin/workers', '/dang-nhap?tiep=%2Fapp%2Fbai-viet'],
    ['javascript:alert(1)', '/dang-nhap?tiep=%2Fapp%2Fbai-viet'],
  ];
  for (const [den, expected] of cases) {
    const response = await fetch(`${BASE}/mo?den=${encodeURIComponent(den)}`, { redirect: 'manual' });
    const location = new URL(response.headers.get('location') ?? '', BASE);
    assert(response.status === 303 && location.origin === ORIGIN && location.pathname + location.search === expected, `${den} → ${location.href}`);
    assert(response.headers.get('cache-control') === 'no-store', 'no-store');
  }
  return `${cases.length} cases`;
});

await check('/mo: signed in goes straight to the lead page', async () => {
  const response = await fetch(`${BASE}/mo?den=${encodeURIComponent('/app/bai-viet?nhu-cau=all')}`, { redirect: 'manual', headers: { cookie: `qlead_session=${seed.large.token}` } });
  const location = new URL(response.headers.get('location') ?? '', BASE);
  assert(location.origin === ORIGIN && location.pathname + location.search === '/app/bai-viet?nhu-cau=all', location.href);
});

await check('logged-out notification tap: login page keeps the destination, and an expired session lands there after sign-in', async () => {
  const { context, page } = await ctx({ token: null, width: 390 });
  await page.goto(`/mo?den=${encodeURIComponent('/app/bai-viet')}`);
  assert(new URL(page.url()).pathname === '/dang-nhap' && new URL(page.url()).searchParams.get('tiep') === '/app/bai-viet', page.url());
  // Simulate sign-in: the form's redirect handling continues to tiep when the server answers /app.
  await page.route('**/api/auth/login', route => route.fulfill({ json: { redirect: '/app' } }));
  await context.addCookies([{ name: 'qlead_session', value: seed.large.token, url: BASE }]);
  await page.fill('input[type=email]', 'qa@example.com');
  await page.fill('input[type=password]', 'password123');
  await page.click('button[type=submit]');
  await page.waitForURL(url => new URL(url).pathname === '/app/bai-viet', { timeout: 15000 });
  await page.screenshot({ path: resolve(SHOTS, 'deeplink-after-login-390.png') });
  await context.close();
});

await check('login ignores a hostile ?tiep=', async () => {
  const { context, page } = await ctx({ token: null, width: 1440 });
  await page.goto(`/dang-nhap?tiep=${encodeURIComponent('https://evil.example')}`);
  await page.route('**/api/auth/login', route => route.fulfill({ json: { redirect: '/app' } }));
  await context.addCookies([{ name: 'qlead_session', value: seed.large.token, url: BASE }]);
  await page.fill('input[type=email]', 'qa@example.com');
  await page.fill('input[type=password]', 'password123');
  await page.click('button[type=submit]');
  await page.waitForURL(url => new URL(url).pathname === '/app', { timeout: 15000 });
  await context.close();
});

// ── Notification settings page ──────────────────────────────────────────────────────────────────────────────────────
for (const width of [390, 768, 1440]) {
  await check(`${width}px: enable → on → test → disable → re-enable, permission asked only from the click`, async () => {
    const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
    const { context, page } = await ctx({ width, permission: 'granted', fakePush: true, backend });
    await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Bật thông báo' }).waitFor();
    assert(!backend.calls.some(call => call.startsWith('PUT')), 'subscribed without a click');
    await page.screenshot({ path: resolve(SHOTS, `settings-off-${width}.png`), fullPage: true });
    assert(await noHorizontalScroll(page), 'horizontal scroll');
    await page.getByRole('button', { name: 'Bật thông báo' }).click();
    await card(page).locator('.pwa-status.is-on').waitFor();
    assert(backend.endpoints.size === 1, 'server did not store the subscription');
    await page.getByRole('button', { name: 'Gửi thông báo thử' }).click();
    await card(page).getByText('Đã gửi.').waitFor();
    await page.screenshot({ path: resolve(SHOTS, `settings-on-${width}.png`), fullPage: true });
    // Refresh keeps the true state (asks the server, not a local flag).
    await page.reload({ waitUntil: 'networkidle' });
    await card(page).locator('.pwa-status.is-on').waitFor();
    await page.getByRole('button', { name: 'Tắt thông báo' }).click();
    await card(page).locator('.pwa-status:not(.is-on)').waitFor();
    assert(backend.endpoints.size === 0, 'server kept the subscription after disable');
    await page.getByRole('button', { name: 'Bật thông báo' }).click();
    await card(page).locator('.pwa-status.is-on').waitFor();
    await context.close();
    return backend.calls.join(', ');
  });
}

await check('permission dismissed: no false "on", no automatic re-prompt', async () => {
  const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
  const { context, page } = await ctx({ width: 390, permission: 'default', fakePush: true, backend });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  assert(await page.evaluate(() => (window as unknown as { __asked?: number }).__asked ?? 0) === 0, 'prompted on load');
  await page.getByRole('button', { name: 'Bật thông báo' }).click();
  await card(page).getByText('Bạn chưa cho phép').waitFor();
  assert(backend.endpoints.size === 0 && !(await card(page).locator('.pwa-status.is-on').count()), 'claimed enabled');
  assert(await page.evaluate(() => (window as unknown as { __asked?: number }).__asked) === 1, 'asked more than once');
  await context.close();
});

for (const width of [390, 1440]) {
  await check(`${width}px: permission denied shows where to allow it, no request button`, async () => {
    const { context, page } = await ctx({ width, permission: 'denied', fakePush: true, backend: { enabled: true, endpoints: new Set(), calls: [] }, ...(width === 390 ? { ua: UA.android } : {}) });
    await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
    await card(page).getByText('đang bị chặn').waitFor();
    assert(!(await page.getByRole('button', { name: 'Bật thông báo' }).count()), 'enable button shown while denied');
    await page.screenshot({ path: resolve(SHOTS, `settings-denied-${width}.png`), fullPage: true });
    await context.close();
  });
}

await check('backend not deployed yet (404) → calm "đang được chuẩn bị", no errors', async () => {
  const { context, page } = await ctx({ width: 390, permission: 'granted' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await card(page).getByText('đang được chuẩn bị').waitFor();
  assert(errors.length === 0, errors.join('; '));
  await context.close();
});

await check('transient API error → message, state not faked', async () => {
  const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
  const { context, page } = await ctx({ width: 390, permission: 'granted', fakePush: true, backend });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  backend.failNext = 1;
  await page.getByRole('button', { name: 'Bật thông báo' }).click();
  await card(page).getByText('Không kết nối được').waitFor();
  assert(!(await card(page).locator('.pwa-status.is-on').count()), 'claimed enabled after a failed save');
  assert(await page.evaluate(async () => !(await (await navigator.serviceWorker.ready).pushManager.getSubscription())), 'browser subscription left behind');
  await context.close();
});

await check('browser without Push API → unsupported message', async () => {
  const { context, page } = await ctx({ width: 1440 });
  await context.addInitScript('delete window.PushManager');
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await card(page).getByText('chưa hỗ trợ thông báo đẩy').waitFor();
  await context.close();
});

await check('expired session on the settings page → sign-in link back to it', async () => {
  const { context, page } = await ctx({ width: 390, permission: 'granted' });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await context.route('**/api/push/config', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const link = card(page).getByRole('link', { name: 'Đăng nhập lại' });
  await link.waitFor();
  assert(await link.getAttribute('href') === '/dang-nhap?tiep=%2Fapp%2Fthong-bao', 'link target');
  await context.close();
});

// ── iPhone ───────────────────────────────────────────────────────────────────────────────────────────────────────────
await check('iPhone Safari (tab): Add to Home Screen steps, push explains install-first', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.iphoneSafari });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await page.getByText('Thêm vào MH chính').waitFor();
  await card(page).getByText('thêm QLead vào màn hình chính').waitFor();
  assert(!(await page.getByRole('button', { name: 'Bật thông báo' }).count()), 'enable shown in a Safari tab');
  assert(!(await page.getByRole('button', { name: 'Cài QLead' }).count()), 'fake install button on iOS');
  await page.screenshot({ path: resolve(SHOTS, 'ios-safari-settings-390.png'), fullPage: true });
  await context.close();
});

await check('iPhone Chrome: told to open in Safari (no impossible steps)', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.iphoneChrome });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await page.getByText('bằng Safari').waitFor();
  assert(!(await page.getByText('Thêm vào MH chính').count()), 'Safari steps in Chrome');
  await context.close();
});

await check('iPhone Home Screen app (standalone): no install guide, enable available', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.iphoneSafari, permission: 'granted', fakePush: true, backend: { enabled: true, endpoints: new Set(), calls: [] } });
  await context.addInitScript(`Object.defineProperty(navigator, 'standalone', { get: () => true });`);
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await page.getByText('QLead đã được cài').waitFor();
  await page.getByRole('button', { name: 'Bật thông báo' }).waitFor();
  assert(!(await page.getByText('Thêm vào MH chính').count()), 'install steps while installed');
  await page.screenshot({ path: resolve(SHOTS, 'ios-standalone-settings-390.png'), fullPage: true });
  await context.close();
});

// ── Install hint on Hôm nay ─────────────────────────────────────────────────────────────────────────────────────────
const fireInstallPrompt = `setTimeout(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = async () => { window.__prompted = (window.__prompted || 0) + 1; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); }, 300);`;

await check('Android: hint hidden on first visit, shown on a later visit, native prompt only after tapping "Cài QLead"', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.android });
  await context.addInitScript(fireInstallPrompt);
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  assert(!(await page.locator('.install-hint').count()), 'hint on first visit');
  // A new browser session on the same device (sessionStorage cleared) counts as a second visit.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.install-hint').waitFor({ timeout: 5000 });
  assert(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0) === 0, 'prompted without a tap');
  await page.screenshot({ path: resolve(SHOTS, 'today-install-hint-android-390.png') });
  await page.locator('.install-hint').getByRole('button', { name: 'Cài QLead' }).click();
  await page.waitForFunction(() => (window as unknown as { __prompted?: number }).__prompted === 1);
  await page.locator('.install-hint').waitFor({ state: 'detached' });
  await context.close();
});

await check('"Để sau" hides the hint for good on this device', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.android });
  await context.addInitScript(`localStorage.setItem('qlead.visits', '5');` + fireInstallPrompt);
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.locator('.install-hint').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Để sau' }).click();
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  assert(!(await page.locator('.install-hint').count()), 'hint came back');
  await context.close();
});

await check('No hint on desktop, in standalone, or on other pages', async () => {
  for (const [width, ua, standalone, path] of [[1440, undefined, false, '/app'], [390, UA.android, true, '/app'], [390, UA.android, false, '/app/bai-viet']] as const) {
    const { context, page } = await ctx({ width, ...(ua ? { ua } : {}) });
    await context.addInitScript(`localStorage.setItem('qlead.visits', '5');` + fireInstallPrompt + (standalone ? `const mm = window.matchMedia.bind(window); window.matchMedia = q => q.includes('standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q);` : ''));
    await page.goto(path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    assert(!(await page.locator('.install-hint').count()), `hint at ${width}/${standalone}/${path}`);
    await context.close();
  }
});

await check('iPhone Safari: hint links to the short guide (no fake install button)', async () => {
  const { context, page } = await ctx({ width: 390, ua: UA.iphoneSafari });
  await context.addInitScript(`localStorage.setItem('qlead.visits', '3');`);
  await page.goto('/app', { waitUntil: 'networkidle' });
  const link = page.locator('.install-hint').getByRole('link', { name: 'Cài QLead' });
  await link.waitFor({ timeout: 5000 });
  assert(await link.getAttribute('href') === '/app/thong-bao#cai-dat', 'link');
  await page.screenshot({ path: resolve(SHOTS, 'today-install-hint-ios-390.png') });
  await context.close();
});

// ── Service worker ──────────────────────────────────────────────────────────────────────────────────────────────────
await check('service worker: registered after load, controls /app, no caches, push → GOAT notification', async () => {
  const { context, page } = await ctx({ width: 1440, permission: 'granted' });
  await page.goto('/app', { waitUntil: 'networkidle' });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert(scope === `${ORIGIN}/`, scope);
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const registrationId = await new Promise<string>(resolveId => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => { const found = registrations.find((r: { scopeURL: string; isDeleted: boolean }) => r.scopeURL === scope && !r.isDeleted); if (found) resolveId(found.registrationId); });
  });
  const payload = { v: 1, kind: 'new_leads', title: 'QLead tìm thấy 5 cơ hội mới', body: 'Quán F&B sắp khai trương — Nhấn để xem bài Facebook mới.', url: '/app/bai-viet', tag: 'new-leads', count: 5 };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId, data: JSON.stringify(payload) });
  const shown = await page.waitForFunction(async () => {
    const list = await (await navigator.serviceWorker.ready).getNotifications();
    return list.length ? list.map(n => ({ title: n.title, body: n.body, icon: n.icon, badge: n.badge, tag: n.tag, data: n.data })) : null;
  }, null, { timeout: 10000 }).then(handle => handle.jsonValue()) as Array<{ title: string; body: string; icon: string; badge: string; tag: string; data: { url: string } }>;
  assert(shown[0].title === payload.title && shown[0].body === payload.body, 'text');
  assert(shown[0].icon.endsWith('/icons/icon-192.png') && shown[0].badge.endsWith('/icons/badge-96.png'), 'icons');
  assert(shown[0].data.url === '/app/bai-viet' && shown[0].tag === 'new-leads', 'data');
  // A second batch replaces the first (same tag) instead of stacking.
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId, data: JSON.stringify({ ...payload, title: 'QLead tìm thấy 7 cơ hội mới', count: 7 }) });
  await page.waitForFunction(async () => { const list = await (await navigator.serviceWorker.ready).getNotifications(); return list.length === 1 && list[0].title.includes('7'); }, null, { timeout: 10000 });
  // A hostile URL in a payload is replaced by the lead list.
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId, data: JSON.stringify({ ...payload, tag: 'evil', url: 'https://evil.example/app' }) });
  let evil: string | null = null;
  for (let attempt = 0; attempt < 40 && !evil; attempt += 1) {
    evil = await page.evaluate(async () => { const list = await (await navigator.serviceWorker.ready).getNotifications({ tag: 'evil' }); return list[0]?.data?.url ?? null; });
    if (!evil) await page.waitForTimeout(250);
  }
  assert(evil === '/app/bai-viet', `evil url kept: ${evil}`);
  // Malformed payload still shows a generic QLead notification.
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId, data: 'not json' });
  await page.waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n => n.title === 'QLead có cơ hội mới'), null, { timeout: 10000 });
  const cacheKeys = await page.evaluate(async () => caches.keys());
  assert(cacheKeys.length === 0, `caches: ${cacheKeys.join(',')}`);
  await context.close();
  return `scope ${scope}`;
});

await check('notification tap: focuses an open QLead window and sends it through /mo to the lead page', async () => {
  const { context, page } = await ctx({ width: 1440, permission: 'granted' });
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload({ waitUntil: 'networkidle' });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  // focus()/openWindow() need the user activation a real notification tap carries; evaluate() has none, so focus is
  // granted here the way the tap would grant it. The routing logic under test is the worker's own openFromNotification.
  const outcome = await worker.evaluate(async () => {
    (self as unknown as { WindowClient: { prototype: { focus: () => Promise<unknown> } } }).WindowClient.prototype.focus = function () { return Promise.resolve(this); };
    return (self as unknown as { openFromNotification: (url: string) => Promise<string> }).openFromNotification('/app/bai-viet');
  });
  await page.waitForURL(url => new URL(url).pathname === '/app/bai-viet', { timeout: 15000 });
  assert(outcome === 'focused', outcome);
  await context.close();
});

await check('service worker update: a new sw.js version takes over without reload loops', async () => {
  const { context, page } = await ctx({ width: 1440 });
  let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const before = navigations;
  // Serve a byte-different sw.js (SW_FILE: path to web/public/sw.js, restored right after) and ask the browser to update.
  const file = process.env.SW_FILE;
  assert(file, 'set SW_FILE to run this check');
  const original = readFileSync(file!, 'utf8');
  writeFileSync(file!, original.replace("SW_VERSION = '", "SW_VERSION = 'qa-next-"));
  let version = '';
  try {
    version = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      await new Promise(resolveWait => setTimeout(resolveWait, 1500));
      const active = (await navigator.serviceWorker.getRegistration('/'))!.active!;
      const channel = new MessageChannel();
      return new Promise<string>(resolveVersion => { channel.port1.onmessage = event => resolveVersion(event.data.version); active.postMessage({ type: 'qlead:sw-version' }, [channel.port2]); });
    });
  } finally { writeFileSync(file!, original); }
  await page.waitForTimeout(1500);
  assert(version.startsWith('qa-next-'), `still ${version}`);
  assert(navigations === before, `page reloaded ${navigations - before}×`);
  await context.close();
  return version;
});

await check('multiple tabs + logout: device subscription released before the session ends', async () => {
  const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
  const { context, page } = await ctx({ width: 1440, permission: 'granted', fakePush: true, backend });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bật thông báo' }).click();
  await card(page).locator('.pwa-status.is-on').waitFor();
  const second = await context.newPage();
  await second.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await card(second).locator('.pwa-status.is-on').waitFor();
  // Logging out uses a throwaway session so the shared seed session stays valid for the rest of the run.
  await context.route('**/api/auth/logout', route => route.fulfill({ json: { redirect: '/dang-nhap' } }));
  await second.locator('.sidebar .logout-btn').click();
  await second.waitForURL(url => new URL(url).pathname === '/dang-nhap');
  assert(backend.endpoints.size === 0, 'server still has the endpoint');
  const callsBeforeLogout = backend.calls.indexOf('DELETE /api/push/subscription');
  assert(callsBeforeLogout >= 0, 'no DELETE before logout');
  await context.close();
});

await check('account switch on a device: another account\'s leftover subscription is released, not adopted', async () => {
  const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
  const { context, page } = await ctx({ width: 1440, permission: 'granted', fakePush: true, backend });
  await context.addInitScript(`localStorage.setItem('__fakeSub', JSON.stringify({ endpoint: 'https://push.example/other-account' }));`);
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !localStorage.getItem('__fakeSub'), null, { timeout: 10000 });
  assert(!backend.calls.some(call => call.startsWith('PUT')), 'adopted silently');
  await context.close();
});

await check('same account signs in again (new session): its device subscription is kept without another tap', async () => {
  const backend: Backend = { enabled: true, endpoints: new Set(), calls: [] };
  const { context, page } = await ctx({ width: 1440, permission: 'granted', fakePush: true, backend });
  const owner = createHash('sha256').update(`qlead-push-owner:${seed.large.userId}`).digest('hex').slice(0, 24);
  await context.addInitScript(`localStorage.setItem('__fakeSub', JSON.stringify({ endpoint: 'https://push.example/same-account' })); localStorage.setItem('qlead.push.owner', '${owner}');`);
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await card(page).locator('.pwa-status.is-on').waitFor();
  assert(backend.endpoints.has('https://push.example/same-account'), 'not re-registered for the new session');
  await context.close();
});

// ── Layout regressions ──────────────────────────────────────────────────────────────────────────────────────────────
for (const width of [390, 768, 1440]) {
  await check(`${width}px: shell entry point, main navigation unchanged, no horizontal scroll`, async () => {
    const { context, page } = await ctx({ width });
    await page.goto('/app', { waitUntil: 'networkidle' });
    const entry = width < 1080 ? page.locator('.topbar-bell') : page.locator('.side-settings');
    await entry.click();
    await page.waitForURL(url => new URL(url).pathname === '/app/thong-bao');
    await page.locator('#app-content h1', { hasText: 'Ứng dụng và thông báo' }).waitFor();
    const navCount = await page.locator(width < 1080 ? '.bottom-nav a' : '.side-nav a').count();
    assert(navCount === 4, `nav items ${navCount}`);
    for (const path of ['/app', '/app/bai-viet', '/app/thong-bao']) { await page.goto(path, { waitUntil: 'networkidle' }); assert(await noHorizontalScroll(page), `scroll on ${path}`); }
    await page.goto('/app', { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(SHOTS, `today-${width}.png`) });
    await context.close();
  });
}

await check('landscape phone (844×390): settings page fits', async () => {
  const { context, page } = await ctx({ width: 844, height: 390, mobile: true, ua: UA.android });
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  assert(await noHorizontalScroll(page), 'horizontal scroll');
  await page.screenshot({ path: resolve(SHOTS, 'settings-landscape-844.png') });
  await context.close();
});

await browser.close();
const failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
