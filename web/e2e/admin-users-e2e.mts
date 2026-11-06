// Browser + API E2E for /admin/users (account-level lead monitoring) on an ISOLATED test database, never the live one.
// It deletes and recreates its own E2E users; no Muse, worker or Facebook is involved.
//
// 1. Start the web app against the test DB (from web/; the DB must have migration 013):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test_adminusers'; $env:QLEAD_DIST_DIR='.next-admin-users'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'; $env:QLEAD_ADMIN_USER_IDS='00000000-0000-4000-8000-0000000000ad'
//    $env:DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,cust:E2E Khách Ngưng:00000000-0000-4000-8000-00000000c001'
//    npx next dev --webpack -H 127.0.0.1 -p 3012
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/admin-users-e2e.mts http://127.0.0.1:3012
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3012';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at a muse_bridge_test* database.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/admin-users-20261102/screenshots');
mkdirSync(SHOTS, { recursive: true });

const ID = { admin: '00000000-0000-4000-8000-0000000000ad', cust: '00000000-0000-4000-8000-00000000c001', long: '00000000-0000-4000-8000-00000000c002' };
const LONG_NAME = 'Công ty TNHH Thương mại Dịch vụ Thiết bị Bán lẻ Nguyễn Hoàng Phương Nam Chi nhánh Thành phố Hồ Chí Minh';
const LONG_EMAIL = 'phong.kinh.doanh.thiet.bi.ban.le.nguyen.hoang.phuong.nam.chi.nhanh.hcm@congtythuongmaidichvu-example.com.vn';
const BULK = 31; // with cust + long + admin: 34 users, two pages of 25
const bulkId = (i: number) => `00000000-0000-4000-8000-0000000d${String(i).padStart(4, '0')}`;
const P: string[] = [];

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function resetFixtures() {
  const ids = [ID.admin, ID.cust, ID.long, ...Array.from({ length: BULK }, (_, i) => bulkId(i + 1))];
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
  await pool.query(`INSERT INTO users(id, display_name, created_at) VALUES ($1, 'E2E Admin', now() - interval '30 days'), ($2, 'E2E Khách Ngưng', now()), ($3, $4, now() - interval '1 minute')`, [ID.admin, ID.cust, ID.long, LONG_NAME]);
  await pool.query(`INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, 'khach.ngung@e2e.qlead.test', 'scrypt$e2e-not-a-real-hash', now()), ($2, $3, 'scrypt$e2e-not-a-real-hash', now())`, [ID.cust, ID.long, LONG_EMAIL]);
  for (let i = 1; i <= BULK; i++) await pool.query(`INSERT INTO users(id, display_name, created_at) VALUES ($1, $2, now() - make_interval(days => 1, mins => $3))`, [bulkId(i), `E2E Khách số ${String(i).padStart(2, '0')}`, i]);
  for (const [name, enabled] of [['Quán cafe sắp khai trương', true], ['Shop thời trang mở chi nhánh', true], ['Nhà thuốc cần phần mềm', false]] as const) {
    const { rows: [p] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [ID.cust, name]);
    await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description) VALUES ($1, 1, $2, '["e2e"]', '', '["social.search"]', 30, $3)`, [p.id, enabled, `Tìm ${name.toLowerCase()}`]);
    P.push(p.id);
  }
  for (let i = 1; i <= 4; i++) await pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, platform) VALUES ($1, $2, $2, $3, 'E2E Page', now() - interval '2 hours', 'facebook')`, [P[0], `https://facebook.com/groups/e2e-admin-users/posts/${i}`, `Bài viết E2E số ${i}: quán cafe sắp khai trương cần máy POS`]);
  // Leads are customer-visible only when source-linked to a search configuration (lead-eligibility.ts).
  await pool.query(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1`, [P[0]]);
  await pool.query(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, 'e2e-admin-users-1', 1, now() - interval '20 minutes', 9, 4, 4, 0)`, [P[0]]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  return { context, page };
}
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
const dbStatus = async (id: string) => (await pool.query('SELECT lead_monitoring_status AS s, lead_monitoring_reason AS r, lead_monitoring_suspended_at AS at, lead_monitoring_suspended_by_user_id AS by FROM users WHERE id = $1', [id])).rows[0];
const row = (p: Page, name: string) => p.locator('.users-row').filter({ hasText: name });
async function openDetail(p: Page, name: string) {
  await p.getByRole('button', { name: `Xem chi tiết ${name}` }).click();
  const d = p.getByRole('dialog');
  await d.locator('.mon-card').waitFor();
  return d;
}

try {
  await resetFixtures();

  // ---------- access ----------
  const cust = await login('E2E Khách Ngưng', 390, 844);
  await check('non-admin gets 404 on /admin/users and from the user APIs', async () => {
    const r = await cust.page.goto(`${BASE}/admin/users`); assert(r?.status() === 404, `page ${r?.status()}`);
    const [list, one, change] = await cust.page.evaluate(async id => [
      (await fetch('/api/admin/users')).status, (await fetch(`/api/admin/users/${id}`)).status,
      (await fetch(`/api/admin/users/${id}/monitoring`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ status: 'suspended' }) })).status,
    ], ID.cust);
    assert(list === 404 && one === 404 && change === 404, `${list}/${one}/${change}`);
    assert((await dbStatus(ID.cust)).s === 'active', 'customer changed own status');
  });
  await check('anonymous gets 401 from the user list API', async () => {
    const anon = await (await browser.newContext()).request.get(`${BASE}/api/admin/users`);
    assert(anon.status() === 401, `anon ${anon.status()}`);
  });

  const admin = await login('E2E Admin');
  const p = admin.page;
  const patches: string[] = [];
  p.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/monitoring')) patches.push(r.url()); });

  // ---------- list, pagination, search ----------
  await check('list shows page 1 of 34 users, newest first, with counts', async () => {
    await p.goto(`${BASE}/admin/users`);
    await p.getByRole('heading', { name: 'Khách hàng', level: 1 }).waitFor();
    assert(await p.getByRole('link', { name: 'Khách hàng' }).getAttribute('aria-current') === 'page', 'nav item');
    assert((await p.locator('.users-row').count()) === 25, `rows ${await p.locator('.users-row').count()}`);
    const count = await p.locator('.users-count').innerText();
    assert(count.includes('1–25 trong 34'), count);
    const first = row(p, 'E2E Khách Ngưng');
    const text = await first.innerText();
    assert(text.includes('khach.ngung@e2e.qlead.test') && text.includes('3 nhu cầu · 2 đang bật') && text.includes('Đang tìm lead'), text);
    assert(/\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}/.test(text), 'last scan time');
    assert((await p.locator('.users-row').first().innerText()).includes('E2E Khách Ngưng'), 'newest first');
    await shot(p, 'list-1440');
  });
  await check('pagination: page 2 holds the remaining 9 and is kept in the URL', async () => {
    await p.getByRole('button', { name: 'Trang sau' }).click();
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('26–34'));
    assert((await p.locator('.users-row').count()) === 9, 'page 2 rows');
    assert(p.url().includes('page=2'), p.url());
    assert(await p.getByRole('button', { name: 'Trang sau' }).isDisabled(), 'next disabled on last page');
    await p.reload(); await p.locator('.users-row').first().waitFor();
    assert((await p.locator('.users-count').innerText()).includes('26–34'), 'reload keeps page');
    await p.getByRole('button', { name: 'Trang trước' }).click();
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('1–25'));
  });
  await check('search by name (accented, case-insensitive), by email and by exact id', async () => {
    const box = p.getByRole('searchbox');
    await box.fill('nguyễn hoàng phương');
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('trong 1 khách hàng'));
    assert((await p.locator('.users-row').innerText()).includes(LONG_NAME), 'long name row');
    assert(p.url().includes('q='), 'q in url');
    await box.fill('khach.ngung@e2e');
    await p.waitForFunction(() => document.querySelector('.users-row')?.textContent?.includes('E2E Khách Ngưng') && document.querySelectorAll('.users-row').length === 1);
    await box.fill(ID.cust);
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('1–1 trong 1'));
    await shot(p, 'one-customer-1440');
  });
  await check('search with no match shows an empty state with a reset', async () => {
    await p.getByRole('searchbox').fill('không-có-khách-nào-như-vậy');
    await p.getByRole('heading', { name: 'Không tìm thấy khách hàng' }).waitFor();
    await p.getByRole('button', { name: 'Xóa tìm kiếm' }).click();
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('trong 34'));
  });
  await check('an empty customer list (API returns none) shows "Chưa có khách hàng"', async () => {
    await p.route('**/api/admin/users?*', r => r.fulfill({ json: { users: [], total: 0, limit: 25, offset: 0 } }));
    await p.getByRole('searchbox').fill('x'); await p.getByRole('heading', { name: 'Không tìm thấy khách hàng' }).waitFor();
    await p.getByRole('searchbox').fill('');
    await p.getByRole('heading', { name: 'Chưa có khách hàng' }).waitFor();
    await shot(p, 'empty-1440');
    await p.unroute('**/api/admin/users?*');
  });
  await check('list API failure shows an error and recovers with Thử lại', async () => {
    await p.route('**/api/admin/users?*', r => r.abort('connectionrefused'));
    await p.getByRole('searchbox').fill('E2E');
    await p.locator('.admin-alert-error').filter({ hasText: 'Không kết nối được máy chủ' }).waitFor();
    await p.unroute('**/api/admin/users?*');
    await p.locator('.admin-alert-error').getByRole('button', { name: 'Thử lại' }).click();
    await p.locator('.admin-alert-error').waitFor({ state: 'detached' });
    await p.getByRole('searchbox').fill(''); await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('trong 34'));
  });

  // ---------- detail ----------
  await check('detail separates account monitoring, login and each profile setting', async () => {
    const d = await openDetail(p, 'E2E Khách Ngưng');
    const text = await d.innerText();
    for (const s of ['Tìm lead của tài khoản', 'Đang tìm lead', 'Vẫn đăng nhập được', 'QLead đang quét theo lịch cho 2 nhu cầu đang bật', 'Quán cafe sắp khai trương', 'Nhà thuốc cần phần mềm', 'Khách tạm dừng', 'Lead đã lưu'])
      assert(text.includes(s), `missing ${s}`);
    assert((await d.locator('.prof-pill.is-ok').count()) === 2 && (await d.locator('.prof-pill.is-paused').count()) === 1, 'profile pills');
    assert(!/muse|worker|credential|hook/i.test(text), 'internal wording leaked');
    await p.screenshot({ path: `${SHOTS}/detail-active-1440.png`, caret: 'initial' });
  });

  // ---------- suspend ----------
  await check('suspension confirmation explains every consequence; Hủy changes nothing', async () => {
    await p.getByRole('dialog').getByRole('button', { name: 'Ngưng tìm lead' }).click();
    const c = p.getByRole('alertdialog');
    await c.waitFor();
    const text = await c.innerText();
    for (const s of ['lượt tìm Facebook mới', 'cả 3 nhu cầu', 'Lead, ghi chú, lịch sử quét và cài đặt bật/tạm dừng', 'Khách nhận một thông báo', 'có thể vẫn chạy xong', 'Lý do gửi cho khách', 'chỉ quản trị viên thấy'])
      assert(text.includes(s), `missing ${s}`);
    await p.screenshot({ path: `${SHOTS}/confirm-suspend-1440.png`, caret: 'initial' });
    await c.getByRole('button', { name: 'Hủy' }).click();
    await c.waitFor({ state: 'detached' });
    assert(patches.length === 0 && (await dbStatus(ID.cust)).s === 'active', 'changed on cancel');
  });
  await check('suspend: busy state blocks a second submit; success only after the server confirms', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    await p.route('**/monitoring', async r => { await gate; await r.continue(); });
    await p.getByRole('dialog').getByRole('button', { name: 'Ngưng tìm lead' }).click();
    const c = p.getByRole('alertdialog');
    await c.getByLabel(/Ghi chú nội bộ/).fill('Khách yêu cầu tạm ngưng (E2E)');
    const submit = c.getByRole('button', { name: 'Ngưng tìm lead' });
    await submit.click();
    const busy = c.getByRole('button', { name: 'Đang ngưng…' });
    await busy.waitFor();
    assert(await busy.isDisabled() && await c.getByRole('button', { name: 'Hủy' }).isDisabled(), 'not disabled while saving');
    await busy.click({ force: true }).catch(() => undefined);
    assert(!(await p.getByRole('dialog').getByText('Đã ngưng tìm lead cho').count()), 'success shown before server answered');
    release(); await c.waitFor({ state: 'detached' });
    await p.unroute('**/monitoring');
    await p.getByRole('dialog').getByText('Đã ngưng tìm lead cho E2E Khách Ngưng').waitFor();
    assert(patches.length === 1, `PATCH sent ${patches.length} times`);
    const s = await dbStatus(ID.cust);
    assert(s.s === 'suspended' && s.r === 'Khách yêu cầu tạm ngưng (E2E)' && s.by === ID.admin, JSON.stringify(s));
  });
  await check('suspended detail: all 3 profiles excluded, profile pause preserved, reason and audit shown', async () => {
    const d = p.getByRole('dialog');
    await d.locator('.mon-card.is-suspended').waitFor();
    const text = await d.innerText();
    for (const s of ['Đã ngưng tìm lead', 'Cả 3 nhu cầu dưới đây đang bị loại khỏi lượt quét mới', 'Khách yêu cầu tạm ngưng (E2E)', 'bởi E2E Admin', 'Vẫn đăng nhập được', 'Kích hoạt lại'])
      assert(text.includes(s), `missing ${s}`);
    assert((await d.locator('.prof-pill.is-blocked').count()) === 2 && (await d.locator('.prof-pill.is-paused').count()) === 1, 'profile pills while suspended');
    const versions = (await pool.query('SELECT count(*)::int AS n, bool_or(enabled) FILTER (WHERE agent_connection_id = $1) AS paused_enabled FROM scan_configs WHERE agent_connection_id = ANY($2::uuid[])', [P[2], P])).rows[0];
    assert(versions.n === 3 && versions.paused_enabled === false, `scan_configs changed ${JSON.stringify(versions)}`);
    await p.screenshot({ path: `${SHOTS}/detail-suspended-1440.png`, caret: 'initial' });
  });
  await check('list row reflects the server state after the change', async () => {
    await p.keyboard.press('Escape'); await p.getByRole('dialog').waitFor({ state: 'detached' });
    const text = await row(p, 'E2E Khách Ngưng').innerText();
    assert(text.includes('Đã ngưng tìm lead') && text.includes('3 nhu cầu · không quét mới'), text);
    await shot(p, 'list-suspended-1440');
  });

  // ---------- customer while suspended ----------
  await check('customer is notified, keeps historical leads, and sees the hold once (no rescan offered)', async () => {
    const c = cust.page;
    await c.goto(`${BASE}/app/bai-viet`);
    await shot(c, 'customer-suspended-leads-390');
    await c.locator('.topbar-bell .unread-dot').waitFor();
    await c.getByText('Bài viết E2E số 1').filter({ visible: true }).first().waitFor({ timeout: 10_000 }).catch(() => { throw new Error('historical lead hidden'); });
    await c.goto(`${BASE}/app/bo-loc`);
    const card = c.getByRole('article', { name: 'Quán cafe sắp khai trương' });
    await card.waitFor();
    assert(!(await card.getByRole('button', { name: 'Tìm lại ngay' }).count()), 'rescan offered while suspended');
    assert(await card.locator('.pf-monitor').innerText() === 'Đang bật', 'state label');
    assert(await c.getByText('Tìm lead mới đang tạm dừng cho tài khoản của bạn. 2 nhu cầu đang bật sẽ tự tiếp tục khi được kích hoạt lại.').isVisible(), 'page summary');
    const paused = c.getByRole('article', { name: 'Nhà thuốc cần phần mềm' });
    assert(await paused.getByRole('button', { name: /^Bật/ }).isEnabled(), 'profile pause toggle must stay usable');
    const body = await c.locator('body').innerText();
    assert(!/muse|worker|credential|hook/i.test(body), 'internal wording leaked to customer');
    assert(await noOverflow(c), 'customer overflow at 390');
    await shot(c, 'customer-suspended-profiles-390');
    const outcome = await c.evaluate(async id => (await (await fetch(`/api/profiles/${id}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' } })).json()).scan?.outcome, P[0]);
    assert(outcome === 'suspended', `manual scan outcome ${outcome}`);
    const jobs = (await pool.query("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]) AND kind = 'manual'", [P])).rows[0].n;
    assert(jobs === 0, `manual jobs created ${jobs}`);
  });

  // ---------- reactivate (with a failure first) ----------
  await check('reactivation failure keeps the suspended state and shows the server error', async () => {
    await openDetail(p, 'E2E Khách Ngưng');
    await p.route('**/monitoring', r => r.fulfill({ status: 500, json: { error: 'internal_error', message: 'Không thực hiện được. Thử lại sau.' } }));
    await p.getByRole('dialog').getByRole('button', { name: 'Kích hoạt lại' }).click();
    const c = p.getByRole('alertdialog');
    const text = await c.innerText();
    assert(text.includes('lượt theo lịch tiếp theo') && text.includes('không được chạy bù') && text.includes('vẫn giữ tạm dừng'), text);
    await p.screenshot({ path: `${SHOTS}/confirm-reactivate-1440.png`, caret: 'initial' });
    await c.getByRole('button', { name: 'Kích hoạt lại' }).click();
    await c.getByRole('alert').filter({ hasText: 'Không thực hiện được. Thử lại sau.' }).waitFor();
    await p.screenshot({ path: `${SHOTS}/api-failure-1440.png`, caret: 'initial' });
    assert(await c.getByRole('button', { name: 'Kích hoạt lại' }).isEnabled(), 'retry blocked');
    assert(await p.getByRole('dialog').locator('.mon-card.is-suspended').count() === 1, 'UI claimed success');
    assert((await dbStatus(ID.cust)).s === 'suspended', 'db changed');
    await p.unroute('**/monitoring');
    await c.getByRole('button', { name: 'Hủy' }).click();
  });
  await check('reactivation succeeds; the last suspension audit is retained', async () => {
    await p.getByRole('dialog').getByRole('button', { name: 'Kích hoạt lại' }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: 'Kích hoạt lại' }).click();
    await p.getByRole('dialog').getByText('Đã kích hoạt lại tìm lead cho E2E Khách Ngưng').waitFor();
    const d = p.getByRole('dialog');
    await d.locator('.mon-card.is-active').waitFor();
    assert((await d.innerText()).includes('Lần ngưng gần nhất'), 'audit not shown');
    const s = await dbStatus(ID.cust);
    assert(s.s === 'active' && s.at !== null, JSON.stringify(s));
    assert((await d.locator('.prof-pill.is-paused').count()) === 1, 'profile pause lost after reactivation');
    await p.screenshot({ path: `${SHOTS}/detail-reactivated-1440.png`, caret: 'initial' });
    await p.keyboard.press('Escape');
  });
  await check('customer notice disappears and rescan is available after reactivation', async () => {
    const c = cust.page;
    await c.goto(`${BASE}/app/bo-loc`);
    const card = c.getByRole('article', { name: 'Quán cafe sắp khai trương' });
    await card.getByRole('button', { name: 'Tìm lại ngay' }).waitFor();
    assert(!(await c.getByText('Tìm lead mới đang tạm dừng', { exact: false }).count()), 'hold still shown');
    assert(await card.getByRole('button', { name: 'Tìm lại ngay' }).isEnabled(), 'rescan still disabled');
  });

  // ---------- responsive ----------
  for (const width of [360, 390, 440, 768, 1024, 1280, 1440]) {
    await check(`responsive ${width}px: list, detail and confirmation fit with reachable actions`, async () => {
      await p.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await p.goto(`${BASE}/admin/users`);
      await p.locator('.users-row').first().waitFor();
      assert(await noOverflow(p), 'list overflows');
      assert(await p.locator('.admin-nav').evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'admin nav needs scrolling');
      const offscreen = await p.locator('.users-open').evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); return r.left < 0 || r.right > window.innerWidth + 0.5 || r.width < 36; }).length);
      assert(offscreen === 0, `${offscreen} actions off-screen`);
      const longRow = row(p, 'Nguyễn Hoàng');
      assert(await longRow.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long row overflows');
      await shot(p, `list-${width}`);
      const d = await openDetail(p, LONG_NAME);
      assert(await d.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'drawer overflows');
      const action = d.getByRole('button', { name: 'Ngưng tìm lead' });
      const box = await action.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 0.5, 'drawer action off-screen');
      await p.screenshot({ path: `${SHOTS}/detail-${width}.png`, caret: 'initial' });
      await action.click();
      const c = p.getByRole('alertdialog');
      await c.waitFor();
      const confirmBox = await c.getByRole('button', { name: 'Ngưng tìm lead' }).boundingBox();
      assert(confirmBox && confirmBox.x + confirmBox.width <= width + 0.5 && confirmBox.y + confirmBox.height <= (width < 768 ? 800 : 900) + 0.5, 'confirm button not reachable without page scroll');
      await p.screenshot({ path: `${SHOTS}/confirm-${width}.png`, caret: 'initial' });
      await c.getByRole('button', { name: 'Hủy' }).click();
      await p.keyboard.press('Escape');
      assert(patches.length === 3, `unexpected PATCH (${patches.length})`);
    });
  }
  await check('no uncaught page errors', async () => { assert(consoleErrors.length === 0, consoleErrors.join(' | ')); });
} finally {
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  writeFileSync(resolve(SHOTS, '..', 'e2e-results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`\n${passed}/${results.length} passed`);
  await pool.end();
  process.exitCode = passed === results.length ? 0 : 1;
}
