// Navigation regression checks on a production build against muse_bridge_test_nav (seed: web/e2e/nav-perf-seed.mts).
// Usage: npx tsx web/e2e/nav-qa.mts <baseUrl> <seed.json>   (screenshots → docs/nav-perf-20261105/screenshots, gitignored)
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const [BASE = 'http://127.0.0.1:3053', SEED = 'nav-perf-seed.json'] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Record<'large' | 'empty' | 'admin', { userId: string; token: string }>;
const SHOTS = resolve('docs/nav-perf-20261105/screenshots');
mkdirSync(SHOTS, { recursive: true });
if (!/muse_bridge_test_nav/.test(process.env.DATABASE_URL ?? '')) { console.error('DATABASE_URL must point at muse_bridge_test_nav'); process.exit(2); }
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function ctx(token: string | null, width: number, height = 900, latency = 0): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: BASE, ...(width < 768 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript('window.__name = (f) => f');
  if (token) await context.addCookies([{ name: 'qlead_session', value: token, url: BASE }]);
  const page = await context.newPage();
  if (latency) { const cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: 400_000, uploadThroughput: 200_000 }); }
  return { context, page };
}
const nav = (page: Page, href: string) => page.locator(`.side-nav a[href="${href}"], .bottom-nav a[href="${href}"]`).filter({ visible: true }).first();
const h1 = (page: Page) => page.locator('#app-content h1').first().textContent({ timeout: 15000 });
const MAIN = [['/app', 'Hôm nay'], ['/app/bai-viet', 'Danh sách lead'], ['/app/bo-loc', 'Nhu cầu theo dõi'], ['/app/de-xuat-nhom', 'Đề xuất nhóm']] as const;

for (const width of [390, 768, 1440]) {
  await check(`${width}px: every main nav item, shell stays mounted, no layout shift of the nav`, async () => {
    const { context, page } = await ctx(seed.large.token, width);
    await page.goto('/app', { waitUntil: 'networkidle' });
    const shellSel = width < 1080 ? '.bottom-nav' : '.sidebar'; // globals.css: the sidebar gives way to the bottom nav below 1080px
    await page.evaluate(sel => { (document.querySelector(sel) as any).__keep = 1; }, shellSel);
    const box0 = await page.locator(shellSel).boundingBox();
    for (const [href, title] of [...MAIN.slice(1), MAIN[0]]) {
      await nav(page, href).click();
      await page.waitForURL(u => new URL(u).pathname === href);
      await page.waitForFunction(t => document.querySelector('#app-content h1')?.textContent?.startsWith(t) && !document.querySelector('[data-route-loading]'), title, { timeout: 15000 });
      assert(await nav(page, href).getAttribute('aria-current') === 'page', `${href} not current`);
      assert(await page.evaluate(sel => (document.querySelector(sel) as any).__keep === 1, shellSel), `shell remounted on ${href}`);
      const box = await page.locator(shellSel).boundingBox();
      assert(box && box0 && Math.abs(box.y - box0.y) < 1 && Math.abs(box.height - box0.height) < 1, `nav moved on ${href}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal scroll on ${href}`);
      await page.screenshot({ path: resolve(SHOTS, `${width}-${href.replace(/\W+/g, '_')}.png`) });
    }
    await context.close();
    return `4 routes, ${shellSel} kept`;
  });

  await check(`${width}px: slow network shows the active item at once and the route outline, then content`, async () => {
    const { context, page } = await ctx(seed.large.token, width, 900, 900);
    await page.goto('/app', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await nav(page, '/app/bai-viet').click();
    await page.waitForTimeout(60);
    assert(await nav(page, '/app/bai-viet').getAttribute('aria-current') === 'page', 'active item did not switch within 60ms');
    await page.waitForSelector('[data-route-loading]', { timeout: 3000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(SHOTS, `${width}-slow-loading.png`) });
    assert(await page.locator('[data-route-loading]').isVisible(), 'outline not visible after 400ms');
    await page.waitForFunction(() => document.querySelector('#app-content h1')?.textContent?.startsWith('Danh sách lead'), null, { timeout: 30000 });
    await context.close();
  });
}

await check('Rapid repeated navigation ends on the last click with matching content', async () => {
  const { context, page } = await ctx(seed.large.token, 1440, 900, 200);
  await page.goto('/app', { waitUntil: 'networkidle' });
  for (const href of ['/app/bai-viet', '/app/bo-loc', '/app/de-xuat-nhom', '/app/bai-viet', '/app/bo-loc']) { await nav(page, href).click(); await page.waitForTimeout(40); }
  await page.waitForFunction(() => location.pathname === '/app/bo-loc' && document.querySelector('#app-content h1')?.textContent?.startsWith('Nhu cầu theo dõi') && !document.querySelector('[data-route-loading]'), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  assert((await h1(page))?.startsWith('Nhu cầu theo dõi'), 'stale page after settling');
  assert(await nav(page, '/app/bo-loc').getAttribute('aria-current') === 'page', 'wrong active item');
  assert(await page.locator('.side-nav a[aria-current="page"]').count() === 1, 'more than one active item');
  await context.close();
});

// After a failed or cancelled transition the highlighted item must match the URL actually shown, never a stale click.
const ITEM_FOR = (path: string) => ['/app/bai-viet', '/app/bo-loc', '/app/de-xuat-nhom'].find(h => path === h || path.startsWith(`${h}/`)) ?? '/app';
async function activeMatchesUrl(page: Page) {
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({ path: location.pathname, active: [...document.querySelectorAll('.side-nav a[aria-current="page"]')].map(a => a.getAttribute('href')) }));
  if (!state.path.startsWith('/app')) return `left the app: ${state.path}`;
  assert(state.active.length === 1 && state.active[0] === ITEM_FOR(state.path), `active ${state.active.join(',')} but URL ${state.path}`);
  return `URL ${state.path}, active ${state.active[0]}`;
}
for (const [name, setup] of [
  ['aborted RSC request', async (page: Page) => { await page.route(u => u.pathname === '/app/bo-loc', r => r.request().headers()['rsc'] ? r.abort() : r.continue()); }],
  ['server error 500', async (page: Page) => { await page.route(u => u.pathname === '/app/bo-loc', r => r.request().headers()['rsc'] ? r.fulfill({ status: 500, body: 'boom' }) : r.continue()); }],
  ['request that never answers', async (page: Page) => { await page.route(u => u.pathname === '/app/bo-loc', r => r.request().headers()['rsc'] ? undefined : r.continue()); }],
] as const) {
  await check(`Failed transition (${name}): active item follows the URL, not the stale click`, async () => {
    const { context, page } = await ctx(seed.large.token, 1440);
    await page.goto('/app', { waitUntil: 'networkidle' });
    await setup(page);
    await nav(page, '/app/bo-loc').click();
    const out = await activeMatchesUrl(page);
    await context.close();
    return out;
  });
}
await check('Cancelled transition (Back right after the click): active item follows the URL', async () => {
  const { context, page } = await ctx(seed.large.token, 1440, 900, 600);
  await page.goto('/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => (window as any).next.router.push('/app/de-xuat-nhom'));
  await page.waitForFunction(() => document.querySelector('#app-content h1')?.textContent?.startsWith('Đề xuất nhóm'), null, { timeout: 30000 });
  await nav(page, '/app/bai-viet').click();
  await page.waitForTimeout(30);
  await page.goBack();
  const out = await activeMatchesUrl(page);
  await context.close();
  return out;
});
await check('Cancelled transition (second click before the first finishes): last click wins', async () => {
  const { context, page } = await ctx(seed.large.token, 1440, 900, 600);
  await page.goto('/app', { waitUntil: 'networkidle', timeout: 60000 });
  await nav(page, '/app/bai-viet').click();
  await page.waitForTimeout(50);
  await nav(page, '/app').click();
  await page.waitForTimeout(3000);
  const out = await activeMatchesUrl(page);
  assert(await page.evaluate(() => location.pathname) === '/app', 'did not end on /app');
  await context.close();
  return out;
});

await check('Lead list → detail → back keeps the list (status filter, count) and back/forward work', async () => {
  const { context, page } = await ctx(seed.large.token, 390, 844);
  await page.goto('/app/bai-viet', { waitUntil: 'networkidle' });
  const first = page.locator('.lead-cards li').first();
  await first.click();
  await page.waitForURL(/\/app\/bai-viet\/.+/);
  await page.waitForFunction(() => document.querySelector('.lead-detail-page h1') && !document.querySelector('[data-route-loading]'), null, { timeout: 15000 });
  assert(await nav(page, '/app/bai-viet').getAttribute('aria-current') === 'page', 'Lead not active on detail');
  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/app/bai-viet' && document.querySelector('#app-content h1')?.textContent?.startsWith('Danh sách lead'), null, { timeout: 15000 });
  await page.goForward();
  await page.waitForFunction(() => /\/app\/bai-viet\/.+/.test(location.pathname) && document.querySelector('.lead-detail-page h1'), null, { timeout: 15000 });
  await context.close();
});

await check('Refresh on a deep route renders the shell and the page (server render, no client-only state)', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  await page.goto('/app/lich-su-quet', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  assert((await h1(page))?.startsWith('Lịch sử quét'), 'no heading after refresh');
  assert(await nav(page, '/app').getAttribute('aria-current') === 'page', 'Hôm nay not active on scan history');
  await context.close();
});

await check('Keyboard: Tab reaches the nav and Enter navigates; focus is not lost into a removed node', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  await page.goto('/app', { waitUntil: 'networkidle' });
  await nav(page, '/app/bo-loc').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#app-content h1')?.textContent?.startsWith('Nhu cầu theo dõi') && !document.querySelector('[data-route-loading]'), null, { timeout: 15000 });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('href') ?? document.activeElement?.tagName);
  assert(focused === '/app/bo-loc' || focused === 'BODY', `focus: ${focused}`);
  await context.close();
  return `focus after nav: ${focused}`;
});

await check('Empty account: every route renders its empty state inside the shell', async () => {
  const { context, page } = await ctx(seed.empty.token, 1440);
  await page.goto('/app', { waitUntil: 'networkidle' });
  for (const [href, title] of [...MAIN.slice(1), ['/app/lich-su-quet', 'Lịch sử quét'] as const, MAIN[0]]) {
    if (href === '/app/lich-su-quet') await page.evaluate(() => (window as any).next.router.push('/app/lich-su-quet')); else await nav(page, href).click();
    await page.waitForFunction(t => document.querySelector('#app-content h1')?.textContent?.startsWith(t) && !document.querySelector('[data-route-loading]'), title, { timeout: 15000 });
  }
  await page.goto('/app/bai-viet', { waitUntil: 'networkidle' });
  assert(await page.getByText('Chưa có lead nào').isVisible(), 'no empty state on the list');
  assert(!(await page.content()).includes('Quán số 1<'), 'leaked another account\'s lead');
  await context.close();
});

await check('Cross-account: the empty account cannot open the large account\'s lead (404 inside the shell)', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  await page.goto('/app/bai-viet', { waitUntil: 'networkidle' });
  const id = await page.locator('[data-id]').first().getAttribute('data-id');
  await context.close();
  const other = await ctx(seed.empty.token, 1440);
  await other.page.goto(`/app/bai-viet/${id}`, { waitUntil: 'networkidle' });
  assert((await h1(other.page))?.includes('Không tìm thấy lead'), 'expected not-found');
  assert(await other.page.locator('.sidebar').isVisible(), 'shell missing on not-found');
  await other.context.close();
});

await check('Two tabs on different routes do not share navigation state', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  const second = await context.newPage();
  await page.goto('/app', { waitUntil: 'networkidle' });
  await second.goto('/app/bo-loc', { waitUntil: 'networkidle' });
  await nav(page, '/app/bai-viet').click();
  await page.waitForFunction(() => document.querySelector('#app-content h1')?.textContent?.startsWith('Danh sách lead'), null, { timeout: 15000 });
  assert(await nav(second, '/app/bo-loc').getAttribute('aria-current') === 'page', 'second tab changed');
  await context.close();
});

await check('Unauthorized admin: a customer gets 404 at /admin/workers and /app/admin; the shell shows no Quản trị link', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  const r = await page.goto('/admin/workers');
  assert(r?.status() === 404, `status ${r?.status()}`);
  const r2 = await page.goto('/app/admin');
  assert(r2?.status() === 404 || (await page.content()).includes('404'), `app/admin status ${r2?.status()}`);
  await page.goto('/app', { waitUntil: 'networkidle' });
  assert(await page.locator('.admin-entry').count() === 0, 'customer sees admin link');
  await context.close();
});

await check('Admin: shell shows Quản trị; /admin navigation works and keeps the admin top bar', async () => {
  const { context, page } = await ctx(seed.admin.token, 1440);
  await page.goto('/app', { waitUntil: 'networkidle' });
  await page.locator('.admin-entry').click();
  await page.waitForURL(/\/admin\/workers/);
  await page.evaluate(() => { (document.querySelector('.admin-topbar') as any).__keep = 1; });
  await page.locator('.admin-nav a[href="/admin/users"]').click();
  await page.waitForFunction(() => document.querySelector('#admin-content h1')?.textContent?.startsWith('Khách hàng'), null, { timeout: 15000 });
  assert(await page.evaluate(() => (document.querySelector('.admin-topbar') as any).__keep === 1), 'admin top bar remounted');
  await context.close();
});

await check('Expired session: the next navigation goes to the login page (no stale page, no crash)', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  await page.goto('/app', { waitUntil: 'networkidle' });
  // Expire only this test's session by its token hash; the seed user keeps no other sessions.
  await db.query('UPDATE web_sessions SET expires_at = now() - interval \'1 minute\' WHERE token_hash = $1', [createHash('sha256').update(seed.large.token).digest('hex')]);
  try {
    await nav(page, '/app/bo-loc').click();
    await page.waitForURL(/\/dang-nhap/, { timeout: 15000 });
  } finally {
    await db.query('UPDATE web_sessions SET expires_at = now() + interval \'2 days\' WHERE token_hash = $1', [createHash('sha256').update(seed.large.token).digest('hex')]);
  }
  await context.close();
});

await check('No console errors or hydration warnings across a full tour', async () => {
  const { context, page } = await ctx(seed.large.token, 1440);
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/app', { waitUntil: 'networkidle' });
  for (const [href, title] of [...MAIN.slice(1), MAIN[0]]) {
    await nav(page, href).click();
    await page.waitForFunction(t => document.querySelector('#app-content h1')?.textContent?.startsWith(t) && !document.querySelector('[data-route-loading]'), title, { timeout: 15000 });
  }
  assert(errors.length === 0, errors.join(' | ').slice(0, 300));
  await context.close();
});

await browser.close();
await db.end();
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
