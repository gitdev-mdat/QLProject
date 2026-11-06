// Browser + API E2E for (A) "Xem N khách hàng" → Lead list scoped to that need, and (B) Admin login history.
// Runs ONLY against an isolated test database (name must contain "_test"); it seeds and removes its own users.
// 1. Start the web app against the test DB (from web/), with:
//    DATABASE_URL=<…/qlead_test> QLEAD_ENVIRONMENT=local ENABLE_DEV_QUICK_LOGIN=true
//    QLEAD_ADMIN_USER_IDS=00000000-0000-4000-8000-00000000ad01
//    DEV_QUICK_LOGIN_USERS='a:E2E Khách A:00000000-0000-4000-8000-00000000aa01,b:E2E Khách B:00000000-0000-4000-8000-00000000bb01,admin:E2E Admin:00000000-0000-4000-8000-00000000ad01'
//    npm run dev -- -p 3011
// 2. From the repo root: DATABASE_URL=<same> npx tsx web/e2e/profile-leads-login-history-e2e.mts http://127.0.0.1:3011
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3011';
const dbName = (await pool.query('SELECT current_database() AS name')).rows[0].name as string;
if (!/_test/.test(dbName)) { console.error(`Refusing to run: database "${dbName}" is not an isolated *_test database.`); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'e2e/screenshots/profile-leads-login-history');
mkdirSync(SHOTS, { recursive: true });

const U = { a: '00000000-0000-4000-8000-00000000aa01', b: '00000000-0000-4000-8000-00000000bb01', admin: '00000000-0000-4000-8000-00000000ad01', pw: '00000000-0000-4000-8000-00000000cc01' };
const NAME_FNB = 'Quán F&B sắp khai trương, đang tuyển người, mở chi nhánh';
const NAME_SPA = 'Spa và thẩm mỹ viện mới mở';
const NAME_EMPTY = 'Khách sạn mini cần phần mềm';
const PW_EMAIL = 'e2e-login-history@example.test';
const PW_PASSWORD = 'MatKhauThu#2026';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const results: Array<{ group: string; name: string; pass: boolean; detail: string }> = [];
async function check(group: string, name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ group, name, pass: true, detail: d ?? '' }); console.log(`PASS [${group}] ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ group, name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL [${group}] ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

// ---------- seed ----------
async function cleanup() {
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  await q("DELETE FROM users WHERE id IN (SELECT user_id FROM user_accounts WHERE email = $1)", [PW_EMAIL]);
}
async function profile(user: string, name: string) {
  const [{ id }] = await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [user, name]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at)
    VALUES ($1, 1, false, '["khai trương"]', '', '["social.search"]', 60, $2, now() - interval '30 days')`, [id, name]);
  return id;
}
/** `count` posts for one profile; post k is published `startHours + k` hours ago. URLs are group posts (source-linked). */
async function posts(profileId: string, prefix: string, count: number, startHours: number) {
  await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    SELECT $1, u.url, u.url, 'Bài đăng thử ' || $2 || ' số ' || k || ': cần tư vấn phần mềm bán hàng.', 'E2E Người đăng ' || k,
      now() - make_interval(hours => $3::int + k), now() - make_interval(hours => $3::int + k) + interval '5 minutes', 'qlead_shared_worker'
    FROM generate_series(1, $4::int) k CROSS JOIN LATERAL (SELECT 'https://facebook.com/groups/e2elead/posts/' || $2 || k AS url) u`, [profileId, prefix, startHours, count]);
  await q(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version)
    SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1 ON CONFLICT DO NOTHING`, [profileId]);
}
/** The same Facebook URL also stored under another profile of the same user (one lead, two sources). */
async function share(fromProfile: string, toProfile: string, n: number) {
  await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    SELECT $2, normalized_url, original_url, content, author, published_at, first_seen_at + interval '1 hour', collected_via
    FROM facebook_posts WHERE agent_connection_id = $1 ORDER BY published_at DESC LIMIT $3`, [fromProfile, toProfile, n]);
  await q(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version)
    SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1 ON CONFLICT DO NOTHING`, [toProfile]);
}

await cleanup();
await q("INSERT INTO users(id, display_name) VALUES ($1, 'E2E Khách A'), ($2, 'E2E Khách B'), ($3, 'E2E Admin')", [U.a, U.b, U.admin]);
await q('INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, $2, $3, now()), ($4, $5, $3, now()), ($6, $7, $3, now())',
  [U.a, 'e2e-a@example.test', 'scrypt$x', U.b, 'e2e-b@example.test', U.admin, 'e2e-admin@example.test']).catch(() => undefined);
const P = { fnb: await profile(U.a, NAME_FNB), spa: await profile(U.a, NAME_SPA), empty: await profile(U.a, NAME_EMPTY), foreign: await profile(U.b, 'Nhu cầu của khách B') };
// Spa: 230 newer posts. F&B: 46 own older posts + 3 posts shared with Spa = 49 leads, all older than the newest 200 overall.
await posts(P.spa, 'spa', 230, 1);
await posts(P.fnb, 'fnb', 46, 300);
await share(P.spa, P.fnb, 3);
await posts(P.foreign, 'foreign', 5, 1);
const count = async (profileId: string) => (await q<{ n: number }>(`SELECT count(DISTINCT normalized_url)::int AS n FROM facebook_posts WHERE agent_connection_id = $1`, [profileId]))[0].n;
const expected = { fnb: await count(P.fnb), spa: await count(P.spa) };
const totalLeads = (await q<{ n: number }>(`SELECT count(DISTINCT fp.normalized_url)::int AS n FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1`, [U.a]))[0].n;
console.log(`Seeded: F&B ${expected.fnb} leads, Spa ${expected.spa} leads, ${totalLeads} leads in total for customer A.`);

// ---------- browser helpers ----------
const browser: Browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const pageErrors: string[] = [];
async function newPage(width: number, height = 900, userAgent?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ...(userAgent ? { userAgent } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`${page.url()} :: ${error.message}`));
  return { context, page };
}
async function quickLogin(page: Page, label: string) {
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/dang-nhap'), { timeout: 60_000 });
}
const select = (page: Page) => page.getByRole('combobox', { name: 'Lọc theo nhu cầu' });
const selectedText = (page: Page) => select(page).evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent ?? '');
const headCount = async (page: Page) => Number((await page.locator('.page-head p', { hasText: 'chưa xem' }).innerText()).match(/^(\d+) lead/)?.[1] ?? NaN);
/** Lead rows the page holds for the current filter: "Đang hiển thị x/y" when paged, otherwise the visible table rows. */
async function filteredCount(page: Page) {
  const more = page.locator('.lead-load-more p');
  if (await more.count()) return Number((await more.innerText()).match(/\/(\d+)/)![1]);
  return page.locator('.lead-table tbody tr').count();
}
/** Waits until the dropdown shows `name` (navigation and Back/Forward render asynchronously), then for the rows. */
async function waitSelected(page: Page, name: string) {
  const deadline = Date.now() + 20_000;
  while (await selectedText(page) !== name) {
    if (Date.now() > deadline) throw new Error(`dropdown stayed on "${await selectedText(page)}", expected "${name}"`);
    await page.waitForTimeout(100);
  }
  await settle(page);
}
/** Same-origin fetch from inside the page, so the browser's own (Secure, HttpOnly) session cookie is used. */
async function api(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(async ({ path, init }) => {
    const r = await fetch(path, { method: init?.method ?? 'GET', headers: init?.body ? { 'content-type': 'application/json' } : {}, body: init?.body ? JSON.stringify(init.body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { path, init });
}
async function settle(page: Page) { await page.waitForLoadState('networkidle'); await page.locator('.lead-results-body:not(.is-switching)').waitFor(); }
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ---------- A: profile → lead list ----------
{
  const { context, page } = await newPage(1440);
  await quickLogin(page, 'E2E Khách A');

  await check('A', 'Direct /app/bai-viet → "Mọi nhu cầu", newest 200 of all leads, honest limit note', async () => {
    await page.goto(`${BASE}/app/bai-viet`); await settle(page);
    assert(await selectedText(page) === 'Mọi nhu cầu', `selected ${await selectedText(page)}`);
    assert(await headCount(page) === totalLeads, `header says ${await headCount(page)}, expected ${totalLeads}`);
    assert(await page.getByText('Đang hiển thị 200 lead mới nhất.').isVisible(), 'limit note missing');
    assert(!(await page.locator('.lead-scope').count()), 'scope line shown for all needs');
    return `${totalLeads} leads, 200 loaded`;
  });

  await check('A', `/app/bo-loc → "Xem ${expected.fnb} khách hàng" (F&B) opens exactly that need`, async () => {
    await page.goto(`${BASE}/app/bo-loc`);
    const link = page.getByRole('link', { name: `Xem ${expected.fnb} khách hàng` });
    assert(await link.getAttribute('href') === `/app/bai-viet?nhu-cau=${P.fnb}`, `href ${await link.getAttribute('href')}`);
    await link.click(); await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.fnb}`); await settle(page);
    assert(await selectedText(page) === NAME_FNB, `dropdown shows "${await selectedText(page)}"`);
    assert(await page.locator('.lead-scope').innerText().then(t => t.includes(NAME_FNB)), 'scope line missing');
    assert(await headCount(page) === expected.fnb, `header ${await headCount(page)}`);
    assert(await filteredCount(page) === expected.fnb, `rows ${await filteredCount(page)} (old code showed 0 here: all F&B posts are older than the newest 200)`);
    await page.screenshot({ path: `${SHOTS}/a-fnb-1440.png` });
    return `${expected.fnb}/${expected.fnb} leads shown`;
  });

  await check('A', 'Every row on the F&B list really belongs to F&B (incl. 3 posts shared with Spa, counted once)', async () => {
    const ids = await page.locator('.lead-table tbody tr').evaluateAll(rows => rows.map(r => r.getAttribute('data-id')));
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM facebook_posts fp WHERE fp.id = ANY($1::uuid[]) AND EXISTS (
      SELECT 1 FROM facebook_posts x WHERE x.agent_connection_id = $2 AND x.normalized_url = fp.normalized_url)`, [ids, P.fnb]);
    assert(n === ids.length, `${ids.length - n} rows not from F&B`);
    assert(new Set(ids).size === ids.length, 'duplicate rows');
    const shared = await page.locator('.lead-table tbody tr', { hasText: '+1 nhu cầu' }).count();
    assert(shared === 3, `shared leads ${shared}`);
    const lines = await page.locator('.lead-table tbody tr', { hasText: '+1 nhu cầu' }).locator('.lead-source').allInnerTexts();
    assert(lines.every(line => line.startsWith(NAME_FNB)), `shared rows name another need first: ${lines[0]}`);
  });

  await check('A', '/app/bo-loc → Back → Spa → Spa selected with all its leads (no stale F&B state)', async () => {
    await page.goBack(); await page.waitForURL('**/app/bo-loc');
    await page.getByRole('link', { name: `Xem ${expected.spa} khách hàng` }).waitFor();
    await page.getByRole('link', { name: `Xem ${expected.spa} khách hàng` }).click();
    await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.spa}`); await settle(page);
    assert(await selectedText(page) === NAME_SPA, `dropdown shows "${await selectedText(page)}"`);
    assert(await headCount(page) === expected.spa && await filteredCount(page) === expected.spa, `header ${await headCount(page)} rows ${await filteredCount(page)}`);
    assert(!(await page.locator('.lead-limit-note').count()), 'limit note shown for a fully loaded need');
  });

  await check('A', 'Changing the dropdown updates URL, selection and rows together', async () => {
    await select(page).selectOption(P.fnb); await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.fnb}`); await settle(page);
    assert(await selectedText(page) === NAME_FNB && await filteredCount(page) === expected.fnb, 'F&B not applied');
    await select(page).selectOption('all'); await page.waitForURL(url => url.pathname === '/app/bai-viet' && !url.search); await settle(page);
    assert(await selectedText(page) === 'Mọi nhu cầu' && await headCount(page) === totalLeads, 'all not applied');
  });

  await check('A', 'Back/Forward restore the need in URL, dropdown and rows', async () => {
    await page.goBack(); await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.fnb}`); await waitSelected(page, NAME_FNB);
    assert(await filteredCount(page) === expected.fnb && await headCount(page) === expected.fnb, `back: ${await filteredCount(page)}`);
    await page.goBack(); await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.spa}`); await waitSelected(page, NAME_SPA);
    assert(await filteredCount(page) === expected.spa, `back 2: ${await filteredCount(page)}`);
    await page.goForward(); await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.fnb}`); await waitSelected(page, NAME_FNB);
    assert(await filteredCount(page) === expected.fnb, `forward: ${await filteredCount(page)}`);
  });

  await check('A', 'Refresh keeps the selected need', async () => {
    await page.reload(); await settle(page);
    assert(await selectedText(page) === NAME_FNB && await filteredCount(page) === expected.fnb, 'lost after reload');
  });

  await check('A', 'Source link inside a lead (drawer) switches the list to that need', async () => {
    await page.locator('.lead-table tbody tr', { hasText: '+1 nhu cầu' }).first().click();
    await page.locator('.lead-drawer').getByRole('link', { name: NAME_SPA }).click();
    await page.waitForURL(`**/app/bai-viet?nhu-cau=${P.spa}`); await settle(page);
    assert(await selectedText(page) === NAME_SPA && await filteredCount(page) === expected.spa, 'drawer link did not apply');
    assert(!(await page.locator('.lead-drawer').count()), 'drawer stayed open on another need');
  });

  await check('A', '"Xem mọi nhu cầu" and "Xóa lọc" return to every need', async () => {
    await page.getByRole('link', { name: 'Xem mọi nhu cầu' }).first().click(); await page.waitForURL(url => !url.search); await settle(page);
    assert(await selectedText(page) === 'Mọi nhu cầu', 'scope link');
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${P.fnb}`); await settle(page);
    await page.getByRole('button', { name: /Xóa lọc/ }).click(); await page.waitForURL(url => !url.search); await settle(page);
    assert(await selectedText(page) === 'Mọi nhu cầu', 'reset');
  });

  await check('A', 'Empty need shows its own empty state', async () => {
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${P.empty}`); await settle(page);
    assert(await selectedText(page) === NAME_EMPTY, 'not selected');
    assert(await page.getByRole('heading', { name: 'Nhu cầu này chưa có lead' }).isVisible(), 'empty state missing');
    await page.screenshot({ path: `${SHOTS}/a-empty-1440.png` });
  });

  await check('A', 'Invalid, malformed, repeated and another customer\'s need ids fall back to every need with a clean URL', async () => {
    for (const bad of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', `${P.fnb}&nhu-cau=${P.spa}`, P.foreign, "x' OR 1=1 --"]) {
      const response = await page.goto(`${BASE}/app/bai-viet?nhu-cau=${bad.includes('&') ? bad : encodeURIComponent(bad)}`); await settle(page);
      assert(response?.ok(), `status ${response?.status()}`);
      assert(new URL(page.url()).search === '', `URL kept ${page.url()}`);
      assert(await selectedText(page) === 'Mọi nhu cầu', `selected ${await selectedText(page)}`);
    }
    assert(!(await page.content()).includes('Nhu cầu của khách B') && !(await page.content()).includes('foreign'), 'foreign data visible');
  });

  await check('A', 'Profile counts on /app/bo-loc equal the list totals', async () => {
    await page.goto(`${BASE}/app/bo-loc`);
    for (const [id, n] of [[P.fnb, expected.fnb], [P.spa, expected.spa]] as const) {
      await page.goto(`${BASE}/app/bai-viet?nhu-cau=${id}`); await settle(page);
      assert(await headCount(page) === n, `${id}: ${await headCount(page)} vs ${n}`);
    }
    await page.goto(`${BASE}/app/bo-loc`);
    assert(await page.getByRole('link', { name: `Xem ${expected.fnb} khách hàng` }).count() === 1 && await page.getByText('Chưa có khách hàng nào').count() === 1, 'card counts');
  });
  await context.close();

  for (const width of [390, 768]) {
    const { context: c, page: p } = await newPage(width, width === 390 ? 844 : 1024);
    await check('A', `${width}px: profile link → scoped list, cards, no horizontal scroll`, async () => {
      await quickLogin(p, 'E2E Khách A');
      await p.goto(`${BASE}/app/bo-loc`);
      await p.getByRole('link', { name: `Xem ${expected.fnb} khách hàng` }).click();
      await p.waitForURL(`**/app/bai-viet?nhu-cau=${P.fnb}`); await settle(p);
      assert(await selectedText(p) === NAME_FNB, 'not selected');
      assert(await p.locator('.lead-cards > li').count() === Math.min(50, expected.fnb), `cards ${await p.locator('.lead-cards > li').count()}`);
      assert(await noOverflow(p), 'horizontal overflow');
      await p.screenshot({ path: `${SHOTS}/a-fnb-${width}.png` });
      await p.goBack(); await p.waitForURL('**/app/bo-loc');
      await p.getByRole('link', { name: `Xem ${expected.spa} khách hàng` }).click(); await p.waitForURL(`**/app/bai-viet?nhu-cau=${P.spa}`); await settle(p);
      assert(await selectedText(p) === NAME_SPA, 'B after back');
    });
    await c.close();
  }
}

// ---------- B: login history ----------
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const events = async (userId: string) => q('SELECT * FROM web_login_events WHERE user_id = $1 ORDER BY created_at', [userId]);
let pwUserId = '';
{
  await check('B', 'Registration creates exactly one "register" sign-in with coarse device facts', async () => {
    const { context, page } = await newPage(1440, 900, WIN_CHROME);
    await page.goto(`${BASE}/dang-nhap`);
    const response = await page.request.post(`${BASE}/api/auth/register`, { data: { name: 'E2E Đăng nhập', email: PW_EMAIL, password: PW_PASSWORD }, headers: { origin: BASE, 'user-agent': WIN_CHROME } });
    assert(response.status() === 201, `status ${response.status()}`);
    pwUserId = (await q<{ user_id: string }>('SELECT user_id FROM user_accounts WHERE email = $1', [PW_EMAIL]))[0].user_id;
    const rows = await events(pwUserId);
    assert(rows.length === 1 && rows[0].method === 'register' && rows[0].device === 'desktop' && rows[0].os === 'Windows' && rows[0].browser === 'Chrome', JSON.stringify(rows));
    await context.close();
  });

  await check('B', 'Wrong password and unknown email record nothing', async () => {
    const { context, page } = await newPage(1440);
    await page.goto(`${BASE}/dang-nhap`);
    const before = (await q('SELECT 1 FROM web_login_events')).length;
    const sessionsBefore = (await q('SELECT 1 FROM web_sessions')).length;
    for (const data of [{ email: PW_EMAIL, password: 'sai-mat-khau' }, { email: 'khong-ton-tai@example.test', password: PW_PASSWORD }]) {
      const r = await page.request.post(`${BASE}/api/auth/login`, { data, headers: { origin: BASE } });
      assert(r.status() === 401, `status ${r.status()}`);
    }
    assert((await q('SELECT 1 FROM web_login_events')).length === before && (await q('SELECT 1 FROM web_sessions')).length === sessionsBefore, 'a failed attempt was recorded');
    await context.close();
  });

  await check('B', 'Password sign-in records one "password" event tied to its session; previous browser session revoked as before', async () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const { context, page } = await newPage(390, 844, ua);
    await page.goto(`${BASE}/dang-nhap`);
    const first = await api(page, '/api/auth/login', { method: 'POST', body: { email: PW_EMAIL, password: PW_PASSWORD } });
    assert(first.status === 200, `login ${first.status}`);
    const second = await api(page, '/api/auth/login', { method: 'POST', body: { email: PW_EMAIL, password: PW_PASSWORD } });
    assert(second.status === 200, `login 2 ${second.status}`);
    const rows = await q(`SELECT e.method, e.device, e.os, e.browser, ws.revoked_at FROM web_login_events e JOIN web_sessions ws ON ws.id = e.session_id
      WHERE e.user_id = $1 AND e.method = 'password' ORDER BY e.created_at`, [pwUserId]);
    assert(rows.length === 2, `${rows.length} password events`);
    assert(rows.every(r => r.device === 'mobile' && r.os === 'iOS' && r.browser === 'Safari'), JSON.stringify(rows));
    assert(rows[0].revoked_at && !rows[1].revoked_at, 'revocation behaviour changed');
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'web_login_events'`)).map(r => r.column_name).sort();
    assert(JSON.stringify(cols) === JSON.stringify(['browser', 'created_at', 'device', 'id', 'method', 'os', 'session_id', 'user_id']), `columns ${cols}`);
    await context.close();
  });

  await check('B', 'Expired and revoked sessions do not authenticate (unchanged)', async () => {
    const { context, page } = await newPage(1440);
    for (const [label, sql] of [['expired', "now() - interval '1 minute'"], ['revoked', "now() + interval '1 day'"]] as const) {
      const token = randomBytes(32).toString('base64url');
      await q(`INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at, revoked_at) VALUES ($1, $2, 'password', ${sql}, ${label === 'revoked' ? 'now()' : 'NULL'})`, [U.a, sha(token)]);
      await context.addCookies([{ name: 'qlead_session', value: token, url: BASE }]);
      await page.goto(`${BASE}/app`);
      assert(new URL(page.url()).pathname === '/dang-nhap', `${label} session reached ${page.url()}`);
      await context.clearCookies();
    }
    await context.close();
  });

  // Large history for pagination: 45 older sessions without device facts (as before migration 020).
  await q(`INSERT INTO web_sessions(user_id, token_hash, created_via, created_at, expires_at, revoked_at)
    SELECT $1, encode(sha256(('e2e-old-' || g)::bytea), 'hex'), CASE WHEN g % 9 = 0 THEN 'dev_quick_login' ELSE 'password' END,
      now() - make_interval(days => g), now() - make_interval(days => g) + interval '7 days', CASE WHEN g % 3 = 0 THEN now() - make_interval(days => g) + interval '2 hours' END
    FROM generate_series(1, 45) g`, [pwUserId]);

  await check('B', 'Customers cannot read login history (own or others); unauthenticated gets 401', async () => {
    const { context, page } = await newPage(1440);
    await page.goto(`${BASE}/dang-nhap`);
    const anon = await api(page, `/api/admin/users/${pwUserId}/logins`);
    assert(anon.status === 401, `anon ${anon.status}`);
    await quickLogin(page, 'E2E Khách A');
    for (const id of [U.a, pwUserId, U.b]) {
      const r = await api(page, `/api/admin/users/${id}/logins`);
      assert(r.status === 404 && !JSON.stringify(r.body).includes('signedInAt'), `customer got ${r.status} for ${id}`);
    }
    const adminPage = await page.goto(`${BASE}/admin/users`);
    assert(adminPage?.status() === 404, `admin page ${adminPage?.status()}`);
    await context.close();
  });

  const { context, page } = await newPage(1440);
  await quickLogin(page, 'E2E Admin');
  await check('B', 'Admin API: newest first, paginated, filter, never exposes token hashes/cookies', async () => {
    const r1 = await api(page, `/api/admin/users/${pwUserId}/logins`);
    assert(r1.status === 200, `status ${r1.status}`);
    const body = r1.body;
    const text = JSON.stringify(body);
    assert(body.total === 48 && body.entries.length === 20 && body.page === 1, `total ${body.total} entries ${body.entries.length}`);
    const times = body.entries.map((e: any) => Date.parse(e.signedInAt));
    assert(times.every((t: number, i: number) => i === 0 || times[i - 1] >= t), 'not newest first');
    assert(body.entries[0].method === 'password' && body.entries[0].session === 'active' && body.entries[0].browser === 'Safari', JSON.stringify(body.entries[0]));
    assert(body.entries.some((e: any) => e.method === 'register'), 'register missing');
    const old = body.entries.find((e: any) => !e.recorded);
    assert(old && old.device === null && old.os === null && old.browser === null, 'old session got invented device facts');
    const hashes = (await q<{ token_hash: string }>('SELECT token_hash FROM web_sessions WHERE user_id = $1', [pwUserId])).map(r => r.token_hash);
    assert(!/token|hash|cookie|password|ip/i.test(Object.keys(body.entries[0]).join(',')), `fields ${Object.keys(body.entries[0])}`);
    assert(hashes.every(h => !text.includes(h)), 'token hash leaked');
    const r3 = (await api(page, `/api/admin/users/${pwUserId}/logins?page=3`)).body;
    assert(r3.page === 3 && r3.entries.length === 8, `page 3 ${r3.entries.length}`);
    const active = (await api(page, `/api/admin/users/${pwUserId}/logins?filter=active`)).body;
    assert(active.entries.every((e: any) => e.session === 'active') && active.entries.length === active.activeCount, 'filter');
    const states = new Set(body.entries.concat(r3.entries).map((e: any) => e.session));
    assert(states.has('expired') && states.has('revoked'), `states ${[...states]}`);
    assert((await api(page, `/api/admin/users/not-a-uuid/logins`)).status === 404, 'bad id');
    assert((await api(page, `/api/admin/users/00000000-0000-4000-8000-000000000000/logins`)).status === 404, 'unknown id');
    assert((await api(page, `/api/admin/users/${pwUserId}/logins?filter=x`)).status === 400, 'bad filter');
    const devRow = (await api(page, `/api/admin/users/${U.admin}/logins`)).body.entries[0];
    assert(devRow.method === 'dev_quick_login', `dev ${devRow.method}`);
    return `${body.total} sign-ins, 3 pages`;
  });

  for (const width of [1440, 768, 390]) {
    await check('B', `Admin UI ${width}px: customer detail → "Lịch sử đăng nhập"`, async () => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(`${BASE}/admin/users?q=${encodeURIComponent(PW_EMAIL)}`);
      await page.getByRole('button', { name: /Xem chi tiết E2E Đăng nhập/ }).click();
      const section = page.locator('section.login-history');
      await section.locator('.login-list li').first().waitFor();
      assert(await section.locator('.login-list li').count() === 20, 'page size');
      const first = await section.locator('.login-list li').first().innerText();
      assert(/Email\/mật khẩu/.test(first) && /Điện thoại · iOS · Safari/.test(first) && /Đang hoạt động/.test(first), first);
      assert(await section.getByText('Thiết bị không rõ').count() > 0, 'unknown device label missing');
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/b-login-history-${width}.png` });
      if (width === 1440) {
        await section.getByRole('button', { name: /Cũ hơn/ }).click();
        await section.getByText('Trang 2 / 3').waitFor();
        await section.getByRole('button', { name: /Đang hoạt động/ }).click();
        await section.getByText('Trang 2 / 3').waitFor({ state: 'detached' });
        assert(await section.locator('.login-list li .login-pill.is-active').count() === await section.locator('.login-list li').count(), 'filter UI');
      }
      assert(await noOverflow(page), 'horizontal overflow');
      await page.keyboard.press('Escape');
    });
  }
  await check('B', 'Admin customer list does not load any login history', async () => {
    const requests: string[] = [];
    page.on('request', r => requests.push(r.url()));
    await page.goto(`${BASE}/admin/users`); await page.waitForLoadState('networkidle');
    assert(!requests.some(u => u.includes('/logins')), 'list fetched login history');
  });
  await context.close();
}

await check('Z', 'No uncaught page errors', async () => { assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ')); });

await browser.close();
const passed = results.filter(r => r.pass).length;
writeFileSync(resolve(SHOTS, 'results.txt'), results.map(r => `${r.pass ? 'PASS' : 'FAIL'} [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n') + `\n\n${passed}/${results.length} passed\n`);
console.log(`\n${passed}/${results.length} passed`);
if (process.env.KEEP_SEED !== '1') await cleanup();
await pool.end();
process.exit(passed === results.length ? 0 : 1);
