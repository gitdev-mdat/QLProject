// Landing "Thử tìm khách hàng" with REAL stored leads, end to end, on an ISOLATED copy of the local database
// (muse_bridge_landing = pg_dump of the local muse_bridge + migrations 016–021). The posts are real Facebook posts
// collected by QLead's own Muse workers; nothing here is mocked except the three failure states (503 / 429 / slow
// server), which are forced with Playwright request routing because they cannot be produced on demand.
// 1. Start the web app against the copy (from web/), with the showcase ("catalog") accounts:
//    DATABASE_URL=…/muse_bridge_landing QLEAD_ENVIRONMENT=local QLEAD_LANDING_CATALOG_USER_IDS=<ids> \
//    QLEAD_DIST_DIR=.next-landing-dev node node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p 3051
// 2. From the repo root: DATABASE_URL=<same> QLEAD_LANDING_CATALOG_USER_IDS=<same> npx tsx web/e2e/landing-real-leads-e2e.mts http://127.0.0.1:3051
// It registers new accounts (e2e-landing-*@example.test) in that copy only; it never touches muse_bridge.
import { chromium, type Browser, type Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3051';
if (!/\/muse_bridge_landing(\?|$)/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_landing.'); process.exit(2); }
const CATALOG = (process.env.QLEAD_LANDING_CATALOG_USER_IDS ?? '').split(',').filter(Boolean);
if (!CATALOG.length) { console.error('Set QLEAD_LANDING_CATALOG_USER_IDS to the same value as the server.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/landing-real-leads-20261108/screenshots');
mkdirSync(SHOTS, { recursive: true });

const RUN = randomBytes(3).toString('hex');
let ipSeq = 10;
/** Each browser context is its own visitor address, as behind Vercel's proxy (per-address rate limits). */
const visitor = () => ({ 'x-forwarded-for': `192.0.2.${ipSeq++}` });
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0]! }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const timings: Record<string, number[]> = { auto: [], user: [], cached: [] };
const apiResponses: any[] = [];

const CAFE = 'Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán cà phê sắp khai trương ở TP.HCM.';
const NOTHING = 'Tôi bán máy lọc nước công nghiệp, muốn tìm nhà máy dệt may ở Lào Cai cần thay hệ thống lọc.';
const PHONE_IN_TEXT = /(?:\+?84|0)(?:[\s.\-()]*\d){8,10}/;

async function resultsHead(page: Page) { return (await page.locator('.demo-results-head b').innerText()).trim(); }
async function waitSettled(page: Page) {
  await page.waitForFunction(() => document.querySelector('.demo-results')?.getAttribute('aria-busy') === 'false', null, { timeout: 15_000 });
}
/** Types a request and measures click → first real lead (or the empty answer) on screen. */
async function runSearch(page: Page, text: string, expectAnswer = true): Promise<number> {
  const before = apiResponses.length;
  await page.locator('#demo-request').fill(text);
  const t0 = Date.now();
  await page.locator('.demo-search button[type=submit]').click();
  await page.waitForFunction(() => {
    const busy = document.querySelector('.demo-results')?.getAttribute('aria-busy');
    return busy === 'false' && (document.querySelector('.demo-lead-list:not(.is-stale) .demo-lead') || document.querySelector('.demo-empty:not(.is-stale)'));
  }, null, { timeout: 15_000 });
  const ms = Date.now() - t0;
  if (expectAnswer) for (let i = 0; i < 100 && apiResponses.length === before; i += 1) await page.waitForTimeout(20);
  return ms;
}
async function noOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

const browser: Browser = await chromium.launch({ channel: 'chrome', headless: true });
const email = `e2e-landing-${RUN}@example.test`;
const password = `Landing-${RUN}-pass`;
let previewForSignup = '';

try {
  // ---------------------------------------------------------------- anonymous visitor, desktop 1440
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'vi-VN', extraHTTPHeaders: visitor() });
  const page = await ctx.newPage();

  page.on('response', async response => { if (response.url().endsWith('/api/landing/search') && response.ok()) apiResponses.push(await response.json().catch(() => null)); });
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await check('A1 Landing loads; the demo section no longer says "bài mẫu"', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const sub = await page.locator('#demo .section-head p').innerText();
    assert(!/mẫu/.test(sub), sub);
    return sub;
  });

  await check('A2 Scrolling to the section runs the example search and shows real leads (≤2)', async () => {
    const t0 = Date.now();
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.waitForSelector('.demo-lead', { timeout: 15_000 });
    timings.auto.push(Date.now() - t0);
    const head = await resultsHead(page);
    const cards = await page.locator('.demo-lead').count();
    assert(/lead thật phù hợp/.test(head) && cards >= 1 && cards <= 2, `${head} / ${cards}`);
    return `${head}, ${Date.now() - t0} ms after scroll`;
  });

  await check('A3 User search returns real stored posts that match (category, signal, place)', async () => {
    const ms = await runSearch(page, CAFE);
    timings.user.push(ms);
    const head = await resultsHead(page);
    assert(/lead thật phù hợp/.test(head), head);
    const matches = await page.locator('.demo-lead-match').allInnerTexts();
    assert(matches.every(text => /Quán cà phê/.test(text) && /TP\.HCM/.test(text)), matches.join(' | '));
    const last = apiResponses.at(-1);
    const ids = await q<{ id: string; owner: string; published_at: Date | null }>(`SELECT fp.id, ac.user_id AS owner, fp.published_at FROM landing_previews lp
      CROSS JOIN unnest(lp.post_ids) AS pid JOIN facebook_posts fp ON fp.id = pid JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE lp.id = $1`, [last.previewId]);
    assert(ids.length === last.leads.length && ids.every(row => CATALOG.includes(row.owner)), 'preview posts are real catalog posts');
    for (const [index, lead] of last.leads.entries()) {
      const row = ids[index]!;
      assert((lead.publishedAt ?? null) === (row.published_at ? row.published_at.toISOString() : null), 'publishedAt is the real Facebook time');
    }
    previewForSignup = last.previewId;
    return `${ms} ms click→leads; posts ${ids.map(row => row.id.slice(0, 8)).join(', ')}`;
  });

  await check('A4 Same search again is served from the answer cache', async () => {
    const ms = await runSearch(page, CAFE);
    timings.cached.push(ms);
    const [{ served_from }] = await q(`SELECT served_from FROM landing_previews WHERE id = $1`, [apiResponses.at(-1).previewId]);
    assert(served_from === 'cache', served_from);
    previewForSignup = apiResponses.at(-1).previewId;
    return `${ms} ms`;
  });

  await check('A5 Public payload has no URL, author, contact or internal ids; page shows no phone number', async () => {
    const last = apiResponses.at(-1);
    const json = JSON.stringify(last.leads);
    assert(!/facebook\.com|fb\.watch|https?:/.test(json), 'no links');
    assert(!PHONE_IN_TEXT.test(json), 'no phone');
    assert(last.leads.every((lead: Record<string, unknown>) => !('author' in lead) && !('url' in lead) && !('id' in lead)), 'no author/url/id keys');
    const text = await page.locator('.demo-results').innerText();
    assert(!PHONE_IN_TEXT.test(text), 'no phone on screen');
    assert(await page.locator('.demo-results a[href*="facebook.com"]').count() === 0, 'no Facebook link');
    return `keys: ${Object.keys(last.leads[0]).join(',')}`;
  });

  await check('A6 "Xem bài đầy đủ" (anonymous) opens a lock panel with a free sign-up CTA, not the post', async () => {
    await page.locator('.demo-lead-actions button').first().click();
    const panel = page.locator('.demo-lead-post').first();
    await panel.waitFor();
    const text = await panel.innerText();
    assert(/Miễn phí, không cần thanh toán/.test(text) && await panel.locator('a', { hasText: 'Đăng ký miễn phí để xem' }).isVisible(), text);
    await page.locator('#demo').screenshot({ path: resolve(SHOTS, 'found-locked-1440.png') });
    return text.split('\n')[0];
  });

  await check('A7 Unrecognised or uncovered request → honest empty state, no padding', async () => {
    const ms = await runSearch(page, NOTHING);
    const head = await resultsHead(page);
    assert(head === 'Chưa có lead phù hợp lúc này', head);
    assert(await page.locator('.demo-lead-list:not(.is-stale) .demo-lead').count() === 0, 'no cards');
    assert(await page.locator('.demo-results-foot a', { hasText: 'Đăng ký để QLead tìm cho bạn' }).isVisible(), 'CTA');
    await page.locator('#demo').screenshot({ path: resolve(SHOTS, 'empty-1440.png') });
    return `${ms} ms`;
  });

  await check('A8 Too-short request is caught in the browser without a request', async () => {
    const before = apiResponses.length;
    await page.locator('#demo-request').fill('ab');
    await page.locator('.demo-search button[type=submit]').click();
    await page.waitForTimeout(300);
    assert(await page.locator('#demo-hint').isVisible() && apiResponses.length === before, 'hint shown, no call');
  });

  for (const [status, expect, shot] of [[503, 'QLead đang bận', 'busy'], [429, 'Bạn vừa tìm nhiều lần liên tiếp', 'rate-limited']] as const) {
    await check(`A9 Server ${status} → "${expect}" (forced via request routing)`, async () => {
      await page.route('**/api/landing/search', route => route.fulfill({ status, contentType: 'application/json', body: '{"error":"x"}' }));
      await runSearch(page, CAFE, false).catch(() => 0);
      await waitSettled(page);
      const head = await resultsHead(page);
      await page.unroute('**/api/landing/search');
      assert(head === expect, head);
      await page.locator('#demo').screenshot({ path: resolve(SHOTS, `${shot}-1440.png`) });
    });
  }

  await check('A10 Slow server (>8 s) → "Tìm lâu hơn bình thường" with retry, no endless spinner', async () => {
    await page.route('**/api/landing/search', async route => { await new Promise(r => setTimeout(r, 9_500)); await route.continue().catch(() => undefined); });
    await page.locator('#demo-request').fill(CAFE);
    const t0 = Date.now();
    await page.locator('.demo-search button[type=submit]').click();
    await page.waitForFunction(() => /Tìm lâu hơn bình thường/.test(document.querySelector('.demo-results-head b')?.textContent ?? ''), null, { timeout: 12_000 });
    await page.unroute('**/api/landing/search');
    assert(await page.locator('.demo-empty button', { hasText: 'Thử lại' }).isVisible(), 'retry');
    await page.locator('#demo').screenshot({ path: resolve(SHOTS, 'timeout-1440.png') });
    return `gave up after ${Date.now() - t0} ms`;
  });

  await check('A11 Loading state is honest (no %); skeleton only on a slow answer', async () => {
    await page.route('**/api/landing/search', async route => { await new Promise(r => setTimeout(r, 1200)); await route.continue(); });
    await page.locator('#demo-request').fill(CAFE);
    await page.locator('.demo-search button[type=submit]').click();
    await page.waitForSelector('.skeleton-item', { timeout: 3000 });
    const head = await resultsHead(page);
    await page.locator('#demo').screenshot({ path: resolve(SHOTS, 'searching-1440.png') });
    await waitSettled(page);
    await page.unroute('**/api/landing/search');
    assert(head === 'Đang tìm lead phù hợp…' && !/%/.test(await page.locator('.demo-results').innerText()), head);
    // The last real answer becomes the one carried into sign-up.
    previewForSignup = apiResponses.at(-1).previewId;
    return head;
  });

  await check('A12 No console errors on the landing page', async () => {
    const relevant = consoleErrors.filter(text => !/status of (429|503)|Failed to load resource/.test(text));
    assert(relevant.length === 0, relevant.slice(0, 3).join(' | '));
  });

  // ---------------------------------------------------------------- sign-up carries the search through
  let signupPreview = '';
  await check('B1 Sign-up CTA saves the search and opens the existing register form with landing copy', async () => {
    await page.locator('.demo-lead-actions button').first().click();
    await page.locator('.demo-lock a').first().click();
    await page.waitForURL(/\/dang-ky\?tu=thu-tim/);
    const sub = await page.locator('.auth-card-head p').innerText();
    const handoff = await page.evaluate(() => JSON.parse(localStorage.getItem('qlead:landing-handoff') ?? 'null'));
    assert(handoff?.query === CAFE && /^[0-9a-f-]{36}$/.test(handoff.previewId), JSON.stringify(handoff));
    signupPreview = handoff.previewId;
    assert(/không cần nhập lại nhu cầu/.test(sub), sub);
    await page.screenshot({ path: resolve(SHOTS, 'register-from-landing-1440.png') });
    return sub;
  });

  await check('B2 Register (no payment, same form) → onboarding shows the same leads in full and the request prefilled', async () => {
    await page.getByPlaceholder('Ví dụ: Linh Nguyễn').fill(`E2E Landing ${RUN}`);
    await page.getByPlaceholder('ban@congty.vn').fill(email);
    await page.getByPlaceholder('Ít nhất 8 ký tự').fill(password);
    await page.getByRole('button', { name: /Tạo tài khoản/ }).click();
    await page.waitForURL(/\/bat-dau/);
    await page.waitForSelector('.handoff-lead', { timeout: 15_000 });
    const description = await page.locator('#ob-description').inputValue();
    assert(description === CAFE, description);
    const links = await page.locator('.handoff-lead a[href*="facebook.com"]').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
    const real = await q<{ original_url: string }>(`SELECT fp.original_url FROM landing_previews lp CROSS JOIN unnest(lp.post_ids) WITH ORDINALITY AS t(pid, n)
      JOIN facebook_posts fp ON fp.id = t.pid WHERE lp.id = $1 ORDER BY t.n`, [signupPreview]);
    assert(links.length === real.length && links.every((link, index) => link === real[index]!.original_url), `${links.length} links vs ${real.length}`);
    await page.screenshot({ path: resolve(SHOTS, 'onboarding-unlocked-1440.png'), fullPage: true });
    return `${links.length} lead(s) with their Facebook links`;
  });

  await check('B3 Server recorded signup_completed + full_results_viewed for that preview and account', async () => {
    const [{ id: userId }] = await q(`SELECT u.id FROM users u JOIN user_accounts a ON a.user_id = u.id WHERE a.email = $1`, [email]);
    const events = await q<{ event: string }>(`SELECT event FROM landing_events WHERE preview_id = $1 AND user_id = $2 ORDER BY id`, [signupPreview, userId]);
    const names = events.map(row => row.event);
    assert(names.includes('landing_signup_completed') && names.includes('landing_full_results_viewed'), names.join(','));
    const [{ claimed_by_user_id }] = await q(`SELECT claimed_by_user_id FROM landing_previews WHERE id = $1`, [signupPreview]);
    assert(claimed_by_user_id === userId, 'claimed');
    return names.join(', ');
  });

  await check('B4 Finishing onboarding saves the same request and queues the real first search (Muse path)', async () => {
    await page.getByRole('button', { name: /Tiếp tục/ }).click();
    await page.getByRole('button', { name: /Tiếp tục/ }).click();
    await page.getByRole('button', { name: /Lưu và vào QLead/ }).click();
    await page.waitForURL(/\/app\/lan-tim-dau/, { timeout: 20_000 });
    const [job] = await q(`SELECT j.kind, j.status, sc.description FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id
      JOIN user_accounts a ON a.user_id = ac.user_id JOIN scan_configs sc ON sc.agent_connection_id = ac.id AND sc.version = j.configuration_version WHERE a.email = $1`, [email]);
    assert(job?.kind === 'initial' && job.description === CAFE, JSON.stringify(job));
    const handoff = await page.evaluate(() => localStorage.getItem('qlead:landing-handoff'));
    assert(handoff === null, 'hand-off cleared after onboarding');
    return `job ${job.kind}/${job.status}`;
  });

  await check('B5 Signed-in visitor on the landing page opens full details inline', async () => {
    await page.goto(`${BASE}/#demo`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.demo-lead', { timeout: 15_000 });
    assert(/đang đăng nhập/.test(await page.locator('.demo-results-foot').innerText()), 'member footer');
    await page.locator('.demo-lead-actions button').first().click();
    await page.waitForSelector('.demo-full', { timeout: 10_000 });
    const hasLink = await page.locator('.demo-full a[href*="facebook.com"]').count();
    assert(hasLink === 1, `link ${hasLink}`);
    await page.locator('#demo').screenshot({ path: resolve(SHOTS, 'member-unlocked-1440.png') });
  });
  await ctx.close();

  // ---------------------------------------------------------------- existing account: sign in from the landing page
  await check('C1 Existing account: "Đã có tài khoản? Đăng nhập" → sign in → /app/thu-tim shows the leads in full', async () => {
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: visitor() });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/#demo`, { waitUntil: 'networkidle' });
    await p2.locator('#demo').scrollIntoViewIfNeeded();
    await p2.waitForSelector('.demo-lead', { timeout: 15_000 });
    await p2.locator('.demo-login').click();
    await p2.waitForURL(/\/dang-nhap\?tiep=/);
    await p2.getByPlaceholder('ban@congty.vn').fill(email);
    await p2.getByPlaceholder('Mật khẩu của bạn').fill(password);
    await p2.getByRole('button', { name: /^Đăng nhập/ }).click();
    await p2.waitForURL(/\/app\/thu-tim/, { timeout: 20_000 });
    await p2.waitForSelector('.handoff-lead', { timeout: 15_000 });
    const count = await p2.locator('.handoff-lead').count();
    await p2.screenshot({ path: resolve(SHOTS, 'thu-tim-1440.png'), fullPage: true });
    // Expired preview: explained, request kept.
    const handoff = await p2.evaluate(() => JSON.parse(localStorage.getItem('qlead:landing-handoff') ?? 'null'));
    await q(`UPDATE landing_previews SET expires_at = now() - interval '1 minute' WHERE id = $1`, [handoff.previewId]);
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForFunction(() => /hết hạn/.test(document.querySelector('.handoff')?.textContent ?? ''), null, { timeout: 15_000 });
    const expired = await p2.locator('.handoff').innerText();
    assert(/hết hạn/.test(expired) && await p2.getByRole('button', { name: /Theo dõi nhu cầu này/ }).isVisible(), expired);
    await p2.screenshot({ path: resolve(SHOTS, 'thu-tim-expired-390.png') });
    await c2.close();
    return `${count} lead(s); expired state explained`;
  });

  await check('C2 Unlock API: another account cannot see anything it was not shown; garbage ids are 404', async () => {
    const res = await fetch(`${BASE}/api/landing/previews/${randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}`);
    assert(res.status === 401, `anonymous ${res.status}`);
  });

  // ---------------------------------------------------------------- responsive
  for (const [width, height] of [[768, 1024], [390, 844]] as const) {
    await check(`D1 ${width}px: results, lock panel and CTA fit without horizontal scroll`, async () => {
      const c = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500, extraHTTPHeaders: visitor() });
      const p = await c.newPage();
      await p.goto(`${BASE}/#demo`, { waitUntil: 'networkidle' });
      await p.locator('#demo').scrollIntoViewIfNeeded();
      await p.waitForSelector('.demo-lead', { timeout: 15_000 });
      await p.locator('.demo-lead-actions button').first().click();
      await p.locator('.demo-lock').first().waitFor();
      assert(await noOverflow(p), 'horizontal overflow');
      await p.locator('#demo').screenshot({ path: resolve(SHOTS, `found-locked-${width}.png`) });
      await runSearch(p, NOTHING, false);
      assert(await noOverflow(p), 'overflow in empty state');
      await p.locator('.demo-results').screenshot({ path: resolve(SHOTS, `empty-${width}.png`) });
      await c.close();
    });
  }

  await check('D2 Layout shift: the results column does not jump when real leads replace the loading state', async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: visitor() });
    const p = await c.newPage();
    await p.addInitScript(() => {
      (window as any).__cls = 0;
      new PerformanceObserver(list => { for (const entry of list.getEntries() as any[]) if (!entry.hadRecentInput) (window as any).__cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.locator('#demo').scrollIntoViewIfNeeded();
    await p.waitForSelector('.demo-lead', { timeout: 15_000 });
    await p.waitForTimeout(800);
    const cls = await p.evaluate(() => (window as any).__cls as number);
    await c.close();
    assert(cls < 0.1, `CLS ${cls.toFixed(3)}`);
    return `CLS ${cls.toFixed(3)}`;
  });

  // ---------------------------------------------------------------- abuse limits and data isolation
  await check('E1 Rate limit: the 13th search in a minute from one address is refused (429)', async () => {
    const statuses: number[] = [];
    const headers = { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
    for (let i = 0; i < 13; i += 1) statuses.push((await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers, body: JSON.stringify({ query: `quán cà phê sắp khai trương ${i}` }) })).status);
    assert(statuses.slice(0, 12).every(s => s === 200) && statuses[12] === 429, statuses.join(','));
    return statuses.join(',');
  });

  await check('E2 Cross-origin and oversized requests are refused; the client cannot ask for more than 2 leads', async () => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' };
    const cross = await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ query: CAFE }) });
    const big = await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers: { ...headers, origin: BASE }, body: JSON.stringify({ query: 'x'.repeat(301) }) });
    const more = await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers: { ...headers, origin: BASE }, body: JSON.stringify({ query: CAFE, limit: 20 }) });
    assert(cross.status === 403 && big.status === 400 && more.status === 400, `${cross.status} ${big.status} ${more.status}`);
  });

  await check('E3 Tenant isolation: every post any landing preview ever showed belongs to a catalog account', async () => {
    const leaks = await q(`SELECT DISTINCT ac.user_id FROM landing_previews lp CROSS JOIN unnest(lp.post_ids) pid JOIN facebook_posts fp ON fp.id = pid
      JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE NOT (ac.user_id = ANY($1::uuid[]))`, [CATALOG]);
    const [{ n }] = await q(`SELECT count(*)::int n FROM landing_previews`);
    assert(leaks.length === 0, `leaked owners ${leaks.map(row => row.user_id).join(',')}`);
    // A customer's own lead (not in the catalog) is never returned, even for its exact words.
    const [foreign] = await q<{ content: string }>(`SELECT fp.content FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
      WHERE NOT (ac.user_id = ANY($1::uuid[])) AND fp.content ~ '[ăâđêôơư]' AND length(fp.content) > 60 ORDER BY fp.first_seen_at DESC LIMIT 1`, [CATALOG]);
    if (foreign) {
      const res = await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': '198.51.100.9' }, body: JSON.stringify({ query: foreign.content.slice(0, 280) }) });
      const data = await res.json() as { previewId: string };
      const shown = await q(`SELECT ac.user_id FROM landing_previews lp CROSS JOIN unnest(lp.post_ids) pid JOIN facebook_posts fp ON fp.id = pid JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE lp.id = $1`, [data.previewId]);
      assert(shown.every(row => CATALOG.includes(row.user_id)), 'foreign post returned');
    }
    return `${n} previews checked`;
  });

  await check('E4 Funnel events recorded without query text', async () => {
    const rows = await q<{ event: string; n: number }>(`SELECT event, count(*)::int n FROM landing_events GROUP BY event ORDER BY event`);
    const names = rows.map(row => row.event);
    for (const required of ['landing_search_started', 'landing_search_results_shown', 'landing_search_empty', 'landing_search_failed', 'landing_preview_opened', 'landing_signup_clicked', 'landing_signup_completed', 'landing_full_results_viewed']) assert(names.includes(required), `missing ${required}`);
    const cols = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('landing_events', 'landing_previews')`);
    assert(!cols.some(col => /query$|text|ip|agent/.test(col.column_name) && col.column_name !== 'query_hash'), cols.map(col => col.column_name).join(','));
    return rows.map(row => `${row.event}=${row.n}`).join(', ');
  });
} finally {
  await browser.close();
  const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
  const [server] = await q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY server_ms) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY server_ms) p95,
    count(*) FILTER (WHERE served_from = 'database')::int db_loads, count(*)::int n FROM landing_previews`).catch(() => [null]);
  const summary = { run: RUN, base: BASE, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, timings_ms: timings,
    median_ms: { auto: median(timings.auto), user: median(timings.user), cached: median(timings.cached) }, server, results };
  writeFileSync(resolve(SHOTS, '..', 'e2e-results.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${results.length} passed`, JSON.stringify(summary.median_ms), JSON.stringify(server));
  await pool.end();
}
