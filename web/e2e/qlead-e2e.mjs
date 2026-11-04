// End-to-end checks for QLead against a running local dev server and the local Postgres.
// Usage: node e2e/qlead-e2e.mjs [baseUrl]   (default http://127.0.0.1:3001)
// Optional: PROD_URL=http://127.0.0.1:3101 to also verify a production server rejects DEV quick login.
// Read-only against business data: it creates and revokes web_sessions rows only.
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pg = require('pg');
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001';
const PROD = process.env.PROD_URL;
const SHOTS = resolve(process.env.SHOT_DIR ?? 'e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });

const USER_A = '502e453f-5ce3-4196-810a-debeb751697f';
const USER_B = 'e9ef48ca-c063-4c38-b405-f47025a6aa64';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL for the local QLead end-to-end check.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const postsOf = async userId => (await db.query(
  "SELECT fp.id, fp.original_url, fp.published_at, fp.first_seen_at, fp.content FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1 AND fp.author IS NOT NULL AND btrim(fp.author) <> '' AND btrim(coalesce(fp.content, fp.title, '')) <> '' AND coalesce(fp.collected_via, '') <> 'integration_test' ORDER BY fp.published_at DESC NULLS LAST, fp.id ASC", [userId])).rows;
const postsA = await postsOf(USER_A);
const postsB = await postsOf(USER_B);
const foreign = (await db.query('SELECT fp.id FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id NOT IN ($1, $2) LIMIT 1', [USER_A, USER_B])).rows[0]?.id;

const results = [];
function record(group, name, pass, detail = '') { results.push({ group, name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${group}] ${name}${detail ? ` — ${detail}` : ''}`); }
async function check(group, name, fn) { try { const detail = await fn(); record(group, name, true, detail ?? ''); } catch (error) { record(group, name, false, error.message.split('\n')[0]); } }
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors = [];
async function newPage(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${page.url()} :: ${message.text()}`); });
  page.on('pageerror', error => consoleErrors.push(`${page.url()} :: pageerror ${error.message}`));
  return { context, page };
}
async function quickLogin(page, label) {
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// ---------- A: authentication ----------
{
  const { context, page } = await newPage();
  await check('A auth', 'Login page shows DEV quick login on localhost dev', async () => {
    await page.goto(`${BASE}/dang-nhap`);
    await page.getByRole('heading', { name: /Đăng nhập nhanh/ }).waitFor();
    await page.waitForLoadState('networkidle');
    // caret: 'initial' stops Playwright injecting caret-color styles, which would trip React's hydration check.
    await page.screenshot({ path: `${SHOTS}/login-1440.png`, caret: 'initial' });
  });
  await check('A auth', 'Unauthenticated /app redirects to login', async () => {
    await page.goto(`${BASE}/app`); assert(page.url().endsWith('/dang-nhap'), `landed on ${page.url()}`);
  });
  await check('A auth', 'Test User A quick login creates a real HttpOnly session and opens dashboard', async () => {
    await quickLogin(page, 'Test User A');
    const cookie = (await context.cookies()).find(item => item.name === 'qlead_session');
    assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Lax', 'cookie flags');
    const row = await db.query("SELECT user_id FROM web_sessions WHERE revoked_at IS NULL AND created_via = 'dev_quick_login' ORDER BY created_at DESC LIMIT 1");
    assert(row.rows[0]?.user_id === USER_A, 'session row for user A');
    await page.getByRole('heading', { name: 'Hôm nay' }).waitFor();
    return 'cookie HttpOnly+Secure+Lax, session row stored';
  });
  await check('A auth', 'Session survives refresh', async () => {
    await page.reload(); await page.getByRole('heading', { name: 'Hôm nay' }).waitFor(); assert(page.url() === `${BASE}/app`, page.url());
  });
  await check('A auth', 'Protected routes open directly while logged in', async () => {
    for (const path of ['/app/bai-viet', '/app/bo-loc', '/app/de-xuat-nhom']) { await page.goto(`${BASE}${path}`); assert(page.url() === `${BASE}${path}`, `${path} -> ${page.url()}`); }
  });
  const oldCookie = (await context.cookies()).find(item => item.name === 'qlead_session');
  await check('A auth', 'Logout revokes the session and returns to login', async () => {
    await page.goto(`${BASE}/app`);
    await page.locator('.sidebar').getByRole('button', { name: 'Đăng xuất' }).click();
    await page.waitForURL(`${BASE}/dang-nhap`);
    await page.goto(`${BASE}/app/bai-viet`); assert(page.url().endsWith('/dang-nhap'), 'still reachable after logout');
  });
  await check('A auth', 'Replaying the old cookie after logout is rejected server-side', async () => {
    await context.addCookies([oldCookie]);
    await page.goto(`${BASE}/app`); assert(page.url().endsWith('/dang-nhap'), 'revoked cookie accepted');
  });
  await context.close();
}

// ---------- B, C, E: navigation, real data, UI as user A ----------
{
  const { page } = await newPage();
  await quickLogin(page, 'Test User A');
  await check('B navigation', 'Sidebar navigation reaches every app page', async () => {
    for (const [label, path, heading] of [['Danh sách lead', '/app/bai-viet', 'Danh sách lead'], ['Nhu cầu theo dõi', '/app/bo-loc', 'Nhu cầu theo dõi'], ['Đề xuất nhóm', '/app/de-xuat-nhom', 'Đề xuất nhóm Facebook'], ['Hôm nay', '/app', 'Hôm nay']]) {
      await page.locator('.side-nav').getByRole('link', { name: label }).click();
      await page.waitForURL(`${BASE}${path}`);
      await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
    }
  });
  await check('C data', 'Lead table shows exactly the leads owned by user A', async () => {
    await page.goto(`${BASE}/app/bai-viet`);
    const count = await page.locator('.lead-table tbody tr').count();
    assert(count === postsA.length, `UI ${count} vs DB ${postsA.length}`);
    return `${count} leads`;
  });
  await check('C data', 'Posts without an author or text and test fixtures remain hidden', async () => {
    const hidden = (await db.query(`SELECT count(*)::int AS n FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
      WHERE ac.user_id = $1 AND NOT (fp.author IS NOT NULL AND btrim(fp.author) <> '' AND btrim(coalesce(fp.content, fp.title, '')) <> '' AND coalesce(fp.collected_via, '') <> 'integration_test')`, [USER_A])).rows[0].n;
    assert(await page.getByText('Chưa rõ người đăng').count() === 0, 'placeholder author shown');
    return `${hidden} incomplete rows hidden`;
  });
  await check('C data', 'Original Facebook URL is preserved on the detail page', async () => {
    const post = postsA.find(item => item.original_url);
    await page.goto(`${BASE}/app/bai-viet/${post.id}`);
    const href = await page.getByRole('link', { name: /Mở bài Facebook/ }).first().getAttribute('href');
    assert(href === post.original_url, `${href} vs ${post.original_url}`);
  });
  await check('B navigation', 'Browser back returns from detail to list', async () => {
    await page.goto(`${BASE}/app/bai-viet`);
    await page.goto(`${BASE}/app/bai-viet/${postsA[0].id}`);
    await page.goBack(); await page.waitForURL(`${BASE}/app/bai-viet`);
  });
  await check('C data', 'Clicking a table row opens the detail drawer; Escape closes it', async () => {
    await page.goto(`${BASE}/app/bai-viet`);
    const row = page.locator('.lead-table tbody tr').nth(1);
    const author = (await row.locator('.lead-cell b').innerText()).trim();
    await row.click();
    const heading = (await page.locator('.lead-drawer .lead-detail-author').innerText()).trim();
    assert(heading === author, `${heading} vs ${author}`);
    await page.keyboard.press('Escape');
    assert(await page.locator('.lead-drawer').count() === 0, 'drawer still open');
  });
  await check('C workflow', 'Status and notes are saved server-side and survive a reload', async () => {
    const target = postsA[postsA.length - 1];
    const before = (await db.query('SELECT status FROM lead_states WHERE user_id = $1 AND post_id = $2', [USER_A, target.id])).rows[0]?.status ?? null;
    try {
      await page.goto(`${BASE}/app/bai-viet`);
      await page.locator(`.lead-table tbody tr[data-id="${target.id}"]`).click();
      await page.locator('.lead-drawer').getByRole('radio', { name: 'Đã liên hệ' }).click();
      await page.locator('.lead-drawer textarea').fill('E2E: đã gọi, hẹn gọi lại thứ Hai');
      await page.locator('.lead-drawer').getByRole('button', { name: 'Thêm ghi chú' }).click();
      await page.locator('.lead-drawer .note-list li', { hasText: 'E2E: đã gọi' }).waitFor();
      await page.waitForTimeout(400);
      await page.reload();
      const row = page.locator(`.lead-table tbody tr[data-id="${target.id}"]`);
      assert((await row.locator('.status-pill').innerText()).trim() === 'Đã liên hệ', 'status not persisted');
      assert((await row.locator('.note-count').innerText()).trim() === '1', 'note not persisted');
      await page.locator('.status-tabs').getByRole('tab', { name: /Đã liên hệ/ }).click();
      assert(await page.locator('.lead-table tbody tr').count() >= 1, 'status tab filter empty');
      await page.locator('.status-tabs').getByRole('tab', { name: /Tất cả/ }).click();
      await row.click();
      await page.locator('.lead-drawer .note-list').getByRole('button', { name: 'Xóa ghi chú' }).click();
      await page.locator('.lead-drawer .note-list li').waitFor({ state: 'detached', timeout: 15000 });
      assert(Number((await db.query('SELECT count(*) FROM lead_notes WHERE user_id = $1 AND post_id = $2', [USER_A, target.id])).rows[0].count) === 0, 'note not deleted');
      return 'status + note persisted, then cleaned up';
    } finally {
      await db.query("DELETE FROM lead_notes WHERE user_id = $1 AND post_id = $2 AND body LIKE 'E2E:%'", [USER_A, target.id]);
      if (before) await db.query('UPDATE lead_states SET status = $3 WHERE user_id = $1 AND post_id = $2', [USER_A, target.id, before]);
      else await db.query('DELETE FROM lead_states WHERE user_id = $1 AND post_id = $2', [USER_A, target.id]);
    }
  });
  await check('C data', 'Search filter narrows results and "Xóa lọc" restores them', async () => {
    await page.goto(`${BASE}/app/bai-viet`);
    await page.fill('input[aria-label="Tìm lead"]', 'zzzz-không-có');
    await page.getByRole('heading', { name: 'Không có lead khớp bộ lọc' }).waitFor();
    await page.getByRole('button', { name: /Xóa lọc/ }).click();
    assert(await page.locator('.lead-table tbody tr').count() === postsA.length, 'not restored');
  });
  await check('C data', 'Default and reverse ordering use original post time; missing dates stay last', async () => {
    const sort = page.getByRole('combobox', { name: 'Sắp xếp lead' });
    assert((await sort.locator('option').allTextContents()).includes('Mới nhất'), 'newest option missing');
    assert((await sort.locator('option').allTextContents()).includes('Cũ nhất'), 'oldest option missing');
    const ids = await page.locator('.lead-table tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-id')));
    const posted = new Map(postsA.map(post => [post.id, post.published_at ? new Date(post.published_at).getTime() : null]));
    const times = ids.map(id => posted.get(id) ?? null);
    assert(times.every((time, index) => time === null ? index === times.length - 1 || times.slice(index + 1).every(value => value === null) : index === 0 || times[index - 1] === null || time <= times[index - 1]), 'not ordered by posted_at DESC NULLS LAST');
    await sort.selectOption('oldest');
    const oldestIds = await page.locator('.lead-table tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-id')));
    const oldestTimes = oldestIds.map(id => posted.get(id) ?? null);
    assert(oldestTimes.every((time, index) => time === null ? oldestTimes.slice(index + 1).every(value => value === null) : index === 0 || oldestTimes[index - 1] === null || time >= oldestTimes[index - 1]), 'not ordered by posted_at ASC NULLS LAST');
    return `${ids.length} rows; posted_at order verified both directions`;
  });
  await check('E UI', 'Search requests page lists the saved profiles from PostgreSQL (read-only)', async () => {
    const saved = (await db.query("SELECT name FROM agent_connections WHERE user_id = $1 AND kind = 'search_profile' AND status = 'active' ORDER BY created_at", [USER_A])).rows.map(row => row.name);
    await page.goto(`${BASE}/app/bo-loc`);
    const shown = await page.locator('.profile-card h2').allInnerTexts();
    assert(JSON.stringify(shown) === JSON.stringify(saved), `${shown.join('|')} vs ${saved.join('|')}`);
    return `${shown.length} profile(s)`;
  });
  await check('B navigation', 'Onboarding never reopens for an account that already has search requests', async () => {
    await page.goto(`${BASE}/bat-dau`);
    await page.waitForURL(`${BASE}/app`);
  });
  for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
    await check('E UI', `No horizontal overflow at ${width}px on app pages`, async () => {
      await page.setViewportSize({ width, height });
      for (const [path, name] of [['/app', 'today'], ['/app/bai-viet', 'leads'], [`/app/bai-viet/${postsA[0].id}`, 'detail'], ['/app/de-xuat-nhom', 'group-requests']]) {
        await page.goto(`${BASE}${path}`);
        await page.waitForLoadState('networkidle');
        assert(await noOverflow(page), `${path} overflows`);
        await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: width !== 1440, caret: 'initial' });
      }
    });
  }
  await page.context().close();
}

// ---------- D: multi-user isolation ----------
{
  const { page, context } = await newPage();
  await quickLogin(page, 'Test User B');
  await check('D isolation', 'User B sees only B-owned leads', async () => {
    await page.goto(`${BASE}/app/bai-viet`);
    const count = await page.locator('.lead-table tbody tr').count();
    assert(count === postsB.length, `UI ${count} vs DB ${postsB.length}`);
    return `${count} leads (B owns ${postsB.length})`;
  });
  await check('D isolation', "Direct URL to A's lead returns not-found for B, with no A content in the response", async () => {
    const response = await page.goto(`${BASE}/app/bai-viet/${postsA[0].id}`);
    assert(response.status() === 404, `status ${response.status()}`);
    const html = await response.text();
    const snippet = (postsA[0].content ?? '').slice(0, 40);
    assert(!snippet || !html.includes(snippet), 'A content leaked');
    await page.getByRole('heading', { name: 'Không tìm thấy lead' }).waitFor();
  });
  await check('D isolation', 'Session cookie cannot be used to fetch another user\'s record via RSC request', async () => {
    const response = await context.request.get(`${BASE}/app/bai-viet/${postsA[0].id}`, { headers: { RSC: '1' } });
    const body = await response.text();
    const snippet = (postsA[0].content ?? '').slice(0, 40);
    assert(!snippet || !body.includes(snippet), 'A content in RSC payload');
    return `status ${response.status()}`;
  });
  await check('D isolation', "User B cannot change status or add notes on A's lead through the API", async () => {
    // Requests are sent from B's own page, so they carry B's real session cookie and a same-origin Origin.
    const codes = await page.evaluate(async id => {
      const json = { 'content-type': 'application/json' };
      const status = await fetch('/api/leads/' + id, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'contacted' }) });
      const note = await fetch('/api/leads/' + id + '/notes', { method: 'POST', headers: json, body: JSON.stringify({ body: 'x' }) });
      return [status.status, note.status];
    }, postsA[0].id);
    assert(codes[0] === 404 && codes[1] === 404, `status ${codes[0]} note ${codes[1]}`);
    const cookie = (await context.cookies()).find(item => item.name === 'qlead_session');
    const crossOrigin = await fetch(`${BASE}/api/leads/${postsA[0].id}`, { method: 'PATCH', headers: { cookie: `qlead_session=${cookie.value}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'contacted' }) });
    assert(crossOrigin.status === 403, `cross-origin ${crossOrigin.status}`);
    return 'API 404 for foreign lead, 403 cross-origin';
  });
  await context.close();
  if (foreign) {
    const second = await newPage();
    await quickLogin(second.page, 'Test User A');
    await check('D isolation', 'User A cannot open a lead owned by a third user', async () => {
      const response = await second.page.goto(`${BASE}/app/bai-viet/${foreign}`);
      assert(response.status() === 404, `status ${response.status()}`);
    });
    await second.context.close();
  }
}

// ---------- F: DEV gate rejections and production ----------
{
  const post = (url, headers) => fetch(`${url}/api/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ user: 'a' }) });
  await check('F safety', 'DEV login rejects requests without the CSRF header', async () => { const r = await post(BASE, { origin: BASE }); assert(r.status === 404, r.status); });
  await check('F safety', 'DEV login rejects cross-origin requests', async () => { const r = await post(BASE, { origin: 'https://evil.example', 'x-qlead-dev-login': '1' }); assert(r.status === 404, r.status); });
  await check('F safety', 'DEV login rejects a tunnel Host header', async () => { const r = await post(BASE, { host: 'thrill-snowdrop-primer.ngrok-free.dev', origin: 'https://thrill-snowdrop-primer.ngrok-free.dev', 'x-qlead-dev-login': '1' }); assert(r.status === 404, r.status); });
  await check('F safety', 'DEV login rejects a forwarded public client address', async () => { const r = await post(BASE, { origin: BASE, 'x-qlead-dev-login': '1', 'x-forwarded-for': '203.0.113.7' }); assert(r.status === 404, r.status); });
  if (PROD) {
    const { page } = await newPage();
    await check('F safety', 'Production login page has no DEV section', async () => {
      await page.goto(`${PROD}/dang-nhap`);
      assert(await page.getByText('Đăng nhập nhanh (DEV)').count() === 0, 'DEV section visible in production');
    });
    await check('F safety', 'Production rejects a fully valid-looking DEV login request', async () => { const r = await post(PROD, { origin: PROD, 'x-qlead-dev-login': '1' }); assert(r.status === 404, `status ${r.status}`); });
    await check('F safety', 'Production /app still requires a session', async () => { await page.goto(`${PROD}/app`); assert(page.url().endsWith('/dang-nhap'), page.url()); });
    await page.context().close();
  }
}

await check('E UI', 'No browser console errors or hydration warnings', async () => {
  const relevant = consoleErrors.filter(text => !/favicon|Failed to load resource: the server responded with a status of 404/.test(text));
  assert(relevant.length === 0, relevant.slice(0, 3).join(' | '));
});

await browser.close();
await db.end();
const passed = results.filter(item => item.pass).length;
console.log(`\n${passed}/${results.length} passed, ${results.length - passed} failed`);
process.exitCode = passed === results.length ? 0 : 1;
