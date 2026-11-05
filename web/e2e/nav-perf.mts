// Navigation timing across the authenticated app, in a real production build (`next build` + `next start`).
// For every click it records, relative to the pointer-down in the page:
//   feedback  first visible change: the clicked nav item becomes current, or the main content changes (skeleton/new page)
//   url       location.pathname is the destination
//   content   the destination's heading is on screen and no route skeleton is left
// plus whether the document reloaded and whether the sidebar/bottom nav DOM node survived (shell remount).
// Setup: web/e2e/nav-perf-seed.mts (sessions), optional web/e2e/latency-proxy.mjs between server and Postgres.
// Usage: npx tsx web/e2e/nav-perf.mts <baseUrl> <seed.json> <label> [browserLatencyMs=0] [rounds=3]
import { chromium, type Page } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [BASE = 'http://127.0.0.1:3051', SEED = 'nav-perf-seed.json', LABEL = 'run', LAT = '0', ROUNDS = '3'] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Record<'large' | 'empty' | 'admin', { userId: string; token: string }>;
const OUT = resolve(process.env.OUT_DIR ?? 'docs/nav-perf-20261105');
mkdirSync(OUT, { recursive: true });

const HEADINGS: Array<[RegExp, RegExp]> = [
  [/^\/app$/, /^Hôm nay/], [/^\/app\/bai-viet$/, /^Danh sách lead/], [/^\/app\/bai-viet\/.+/, /./], [/^\/app\/bo-loc$/, /^Nhu cầu theo dõi/],
  [/^\/app\/de-xuat-nhom$/, /^Đề xuất nhóm/], [/^\/app\/lich-su-quet$/, /^Lịch sử quét/], [/^\/admin\/users$/, /^Khách hàng/],
  [/^\/admin\/workers$/, /^Kết nối Muse/], [/^\/admin\/group-requests$/, /./],
];

type Step = { from: string; to: string; how: 'nav' | 'push' | 'back' | 'forward'; round: number; feedback: number | null; url: number | null; content: number | null; reload: boolean; shellKept: boolean };
const steps: Step[] = [];

async function arm(page: Page, to: string) {
  const expected = HEADINGS.find(([path]) => path.test(to))?.[1].source ?? '.';
  await page.evaluate(({ to, expected }) => {
    const w = window as any;
    w.__navMark ??= Math.random();
    const shell = document.querySelector('.sidebar, .admin-topbar');
    if (shell) (shell as any).__shellMark = w.__navMark;
    const main = document.querySelector('#app-content, #admin-content');
    const before = main?.firstElementChild ?? null;
    const r = { t0: 0, feedback: null as number | null, url: null as number | null, content: null as number | null };
    w.__nav = r;
    const start = () => { if (!r.t0) r.t0 = performance.now(); };
    w.__navStart = start;
    document.addEventListener('pointerdown', start, { capture: true, once: true });
    const re = new RegExp(expected);
    const tick = () => {
      if (!r.t0) { requestAnimationFrame(tick); return; }
      const now = performance.now() - r.t0;
      const link = document.querySelector(`.side-nav a[href="${to}"], .bottom-nav a[href="${to}"], .admin-nav a[href="${to}"]`);
      const visibleLink = [...document.querySelectorAll(`.side-nav a[href="${to}"], .bottom-nav a[href="${to}"], .admin-nav a[href="${to}"]`)].some(a => (a as HTMLElement).offsetParent && a.getAttribute('aria-current') === 'page');
      const m = document.querySelector('#app-content, #admin-content');
      const changed = !m || m.firstElementChild !== before;
      if (r.feedback === null && (visibleLink || changed)) r.feedback = now;
      if (r.url === null && location.pathname === to) r.url = now;
      const h1 = document.querySelector('#app-content h1, #admin-content h1');
      const loading = document.querySelector('[data-route-loading]');
      if (r.content === null && location.pathname === to && h1 && re.test(h1.textContent?.trim() ?? '') && !loading && (changed || !before)) r.content = now;
      void link;
      if (r.content === null && now < 15000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { to, expected });
}

async function settle(page: Page) {
  await page.waitForFunction(() => { const r = (window as any).__nav; return r && (r.content !== null || (r.t0 && performance.now() - r.t0 > 15000)); }, null, { timeout: 20000 }).catch(() => {});
}

async function record(page: Page, from: string, to: string, how: Step['how'], round: number, act: () => Promise<void>) {
  await arm(page, to);
  await act();
  await settle(page);
  const r = await page.evaluate(() => {
    const w = window as any;
    const shell = document.querySelector('.sidebar, .admin-topbar') as any;
    return { ...(w.__nav ?? {}), reload: !w.__nav, shellKept: Boolean(shell && shell.__shellMark === w.__navMark) };
  });
  const round1 = (v: number | null) => v === null || v === undefined ? null : Math.round(v);
  const step: Step = { from, to, how, round, feedback: round1(r.feedback), url: round1(r.url), content: round1(r.content), reload: r.reload, shellKept: r.shellKept };
  steps.push(step);
  console.log(`${LABEL} r${round} ${how.padEnd(7)} ${from} → ${to}: feedback ${step.feedback}ms · url ${step.url}ms · content ${step.content}ms${step.reload ? ' · RELOAD' : ''}${step.shellKept ? '' : ' · shell remounted'}`);
  await page.waitForTimeout(1200); // let viewport prefetches run, as a person reading the page would
}

async function clickNav(page: Page, to: string) {
  const selector = `.side-nav a[href="${to}"], .bottom-nav a[href="${to}"], .admin-nav a[href="${to}"]`;
  const link = page.locator(selector).filter({ visible: true }).first();
  await link.click();
}
async function push(page: Page, to: string) {
  await page.evaluate(to => { (window as any).__navStart(); (window as any).next.router.push(to); }, to);
}

async function session(token: string, width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: BASE });
  // tsx keeps function names with a __name() helper that does not exist inside page.evaluate.
  await context.addInitScript('window.__name = (f) => f');
  await context.addCookies([{ name: 'qlead_session', value: token, url: BASE }]);
  const page = await context.newPage();
  if (Number(LAT) > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: Number(LAT), downloadThroughput: -1, uploadThroughput: -1 });
  }
  return { context, page };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const WIDTH = Number(process.env.WIDTH ?? 1440);
const { page } = await session(seed.large.token, WIDTH, 900);
await page.goto('/app', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const detailId = await page.evaluate(async () => {
  const html = await (await fetch('/app/bai-viet')).text();
  return html.match(/data-id=\\?"([0-9a-f-]{36})/)?.[1] ?? null;
});
for (let round = 1; round <= Number(ROUNDS); round += 1) {
  await record(page, '/app', '/app/bai-viet', 'nav', round, () => clickNav(page, '/app/bai-viet'));
  await record(page, '/app/bai-viet', '/app', 'nav', round, () => clickNav(page, '/app'));
  await record(page, '/app', '/app/bo-loc', 'nav', round, () => clickNav(page, '/app/bo-loc'));
  await record(page, '/app/bo-loc', '/app/de-xuat-nhom', 'nav', round, () => clickNav(page, '/app/de-xuat-nhom'));
  await record(page, '/app/de-xuat-nhom', '/app/bai-viet', 'nav', round, () => clickNav(page, '/app/bai-viet'));
  if (detailId) {
    await record(page, '/app/bai-viet', `/app/bai-viet/${detailId}`, 'push', round, () => push(page, `/app/bai-viet/${detailId}`));
    await record(page, `/app/bai-viet/${detailId}`, '/app/bai-viet', 'back', round, async () => { await page.evaluate(() => (window as any).__navStart()); await page.goBack({ waitUntil: 'commit' }).catch(() => {}); });
  }
  await record(page, '/app/bai-viet', '/app/lich-su-quet', 'push', round, () => push(page, '/app/lich-su-quet'));
  await record(page, '/app/lich-su-quet', '/app', 'nav', round, () => clickNav(page, '/app'));
  await record(page, '/app', '/app/lich-su-quet', 'back', round, async () => { await page.evaluate(() => (window as any).__navStart()); await page.goBack({ waitUntil: 'commit' }).catch(() => {}); });
  await record(page, '/app/lich-su-quet', '/app', 'forward', round, async () => { await page.evaluate(() => (window as any).__navStart()); await page.goForward({ waitUntil: 'commit' }).catch(() => {}); });
}
await page.context().close();

if (process.env.SKIP_ADMIN !== '1') {
  const admin = await session(seed.admin.token, WIDTH, 900);
  await admin.page.goto('/admin/users', { waitUntil: 'networkidle' });
  await admin.page.waitForTimeout(1500);
  for (let round = 1; round <= Number(ROUNDS); round += 1) {
    await record(admin.page, '/admin/users', '/admin/workers', 'nav', round, () => clickNav(admin.page, '/admin/workers'));
    await record(admin.page, '/admin/workers', '/admin/group-requests', 'nav', round, () => clickNav(admin.page, '/admin/group-requests'));
    await record(admin.page, '/admin/group-requests', '/admin/users', 'nav', round, () => clickNav(admin.page, '/admin/users'));
  }
  await admin.context.close();
}
await browser.close();

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null; };
const pick = (k: 'feedback' | 'url' | 'content', rows: Step[]) => rows.map(r => r[k]).filter((v): v is number => v !== null);
const cold = steps.filter(s => s.round === 1), warm = steps.filter(s => s.round > 1);
const summary = {
  label: LABEL, base: BASE, width: WIDTH, browserLatencyMs: Number(LAT), steps: steps.length,
  reloads: steps.filter(s => s.reload).length, shellRemounts: steps.filter(s => !s.shellKept).length, timeouts: steps.filter(s => s.content === null).length,
  cold: { feedback: median(pick('feedback', cold)), content: median(pick('content', cold)), contentP95: p95(pick('content', cold)) },
  warm: { feedback: median(pick('feedback', warm)), content: median(pick('content', warm)), contentP95: p95(pick('content', warm)) },
  all: { feedbackP95: p95(pick('feedback', steps)), contentMedian: median(pick('content', steps)), contentP95: p95(pick('content', steps)) },
};
console.log(JSON.stringify(summary));
writeFileSync(resolve(OUT, `${LABEL}.json`), JSON.stringify({ summary, steps }, null, 2));
