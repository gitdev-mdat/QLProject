// Browser + API E2E for permanent account deletion in /admin/users. ISOLATED test database only: it refuses any
// other database and only creates/deletes synthetic users whose ids start with 00000000-0000-4000-8000-.
//
// 1. Start the web app against the test DB (from web/; the DB needs migrations 013 and 014):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test_adminusers'; $env:QLEAD_DIST_DIR='.next-admin-users'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'; $env:QLEAD_ADMIN_USER_IDS='00000000-0000-4000-8000-0000000000ad'
//    $env:DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,mail:Khách Có Email:00000000-0000-4000-8000-0000000de003'
//    npx next dev --webpack -H 127.0.0.1 -p 3012
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/admin-user-deletion-e2e.mts http://127.0.0.1:3012
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3012';
if (!/\/muse_bridge_test_adminusers$/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must be the isolated muse_bridge_test_adminusers database.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/admin-user-deletion-20261103/screenshots');
mkdirSync(SHOTS, { recursive: true });

const ID = {
  admin: '00000000-0000-4000-8000-0000000000ad',
  dupHeavy: '00000000-0000-4000-8000-0000000de001', // "Test User A", no email, lots of history
  dupEmpty: '00000000-0000-4000-8000-0000000de002', // "Test User A", no email, no data at all
  mail: '00000000-0000-4000-8000-0000000de003',     // has email; signed in as a customer during the test
  busy: '00000000-0000-4000-8000-0000000de004',     // has a running search (valid lease)
  long: '00000000-0000-4000-8000-0000000de005',     // very long name, no email, a little data
};
const LONG_NAME = 'Công ty TNHH Thương mại Dịch vụ Thiết bị Bán lẻ Nguyễn Hoàng Phương Nam Chi nhánh Thành phố Hồ Chí Minh';
const BULK = 20; // admin + 5 + 20 = 26 users
const bulkId = (i: number) => `00000000-0000-4000-8000-0000000df${String(i).padStart(3, '0')}`;
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const PROFILE: Record<string, string> = {};

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const removeSynthetic = () => pool.query("DELETE FROM users WHERE id::text LIKE '00000000-0000-4000-8000-%'");
const insertPost = (profile: string, key: string) => pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, platform)
  VALUES ($1, $2, $2, $3, 'E2E Page', now() - interval '3 hours', 'facebook') RETURNING id`, [profile, `https://facebook.com/e2e-delete/${key}`, `Bài viết xóa E2E ${key}`]);

async function profile(userId: string, name: string, enabled = true) {
  const { rows: [p] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
  await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description) VALUES ($1, 1, $2, '["e2e"]', '', '["social.search"]', 30, $3)`, [p.id, enabled, name]);
  return p.id as string;
}
async function resetFixtures() {
  await removeSynthetic();
  await pool.query("DELETE FROM admin_user_deletion_audit WHERE target_user_id::text LIKE '00000000-0000-4000-8000-%'"); // isolated test DB only
  await pool.query(`INSERT INTO users(id, display_name, created_at) VALUES ($1, 'E2E Admin', now() - interval '30 days'),
    ($2, 'Test User A', now() - interval '2 hours'), ($3, 'Test User A', now() - interval '20 days'), ($4, 'Khách Có Email', now() - interval '1 hour'),
    ($5, 'Khách Đang Quét', now()), ($6, $7, now() - interval '3 hours')`, [ID.admin, ID.dupHeavy, ID.dupEmpty, ID.mail, ID.busy, ID.long, LONG_NAME]);
  await pool.query(`INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, 'co.email@e2e.qlead.test', 'scrypt$e2e-not-a-real-hash', now())`, [ID.mail]);
  for (let i = 1; i <= BULK; i++) await pool.query('INSERT INTO users(id, display_name, created_at) VALUES ($1, $2, now() - make_interval(days => $3, mins => $4))', [bulkId(i), `Khách mẫu ${String(i).padStart(2, '0')}`, i === BULK ? 90 : 1, i]);
  // Substantial history for the first "Test User A": 3 profiles, 40 leads, 12 scans, 10 lead states, 5 notes, 1 group request.
  const heavy = [await profile(ID.dupHeavy, 'Quán cafe'), await profile(ID.dupHeavy, 'Nhà thuốc'), await profile(ID.dupHeavy, 'Shop thời trang', false)];
  for (let i = 1; i <= 40; i++) {
    const { rows: [post] } = await insertPost(heavy[i % 3], `heavy-${i}`);
    if (i <= 10) await pool.query("INSERT INTO lead_states(user_id, post_id, status) VALUES ($1, $2, 'contacted')", [ID.dupHeavy, post.id]);
    if (i <= 5) await pool.query('INSERT INTO lead_notes(user_id, post_id, body) VALUES ($1, $2, $3)', [ID.dupHeavy, post.id, `Ghi chú ${i}`]);
  }
  for (let i = 1; i <= 12; i++) await pool.query(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, $2, 1, now() - make_interval(hours => $3), 5, 3, 3, 0)`, [heavy[i % 3], `e2e-delete-${i}`, i]);
  await pool.query(`INSERT INTO facebook_group_requests(user_id, group_key, group_url, submitted_url) VALUES ($1, 'e2e-delete', 'https://www.facebook.com/groups/e2e-delete', 'https://www.facebook.com/groups/e2e-delete')`, [ID.dupHeavy]);
  PROFILE.mail = await profile(ID.mail, 'Phần mềm bán hàng');
  await insertPost(PROFILE.mail, 'mail');
  PROFILE.long = await profile(ID.long, 'Thiết bị bán lẻ');
  await insertPost(PROFILE.long, 'long-1'); await insertPost(PROFILE.long, 'long-2');
  PROFILE.busy = await profile(ID.busy, 'Đại lý điện máy');
  await pool.query(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, status, required_sources, lease_expires_at, attempts)
    VALUES ($1, 1, 'e2e-delete-busy', now(), 'claimed', '["social.search"]', now() + interval '20 minutes', 1)`, [PROFILE.busy]);
  // A suspended bystander proves deletion does not touch other accounts' statuses.
  await pool.query("UPDATE users SET lead_monitoring_status = 'suspended', lead_monitoring_suspended_at = now() WHERE id = $1", [bulkId(3)]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pageErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', e => pageErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  return { context, page };
}
const shot = (p: Page, name: string, fullPage = false) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial' });
const exists = async (id: string) => (await pool.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount === 1;
const statuses = async () => Object.fromEntries((await pool.query("SELECT id, lead_monitoring_status FROM users WHERE id::text LIKE '00000000-0000-4000-8000-%'")).rows.map(r => [r.id, r.lead_monitoring_status]));
const countText = (p: Page) => p.locator('.users-count').innerText();
async function search(p: Page, q: string, rows: number) {
  await p.getByRole('searchbox').fill(q);
  await p.waitForFunction(n => !document.querySelector('.users-table.is-loading') && document.querySelectorAll('.users-row').length === n, rows);
}
async function openDetail(p: Page, id: string) {
  await p.locator('.users-row').filter({ hasText: short(id) }).locator('.users-open').click();
  const d = p.getByRole('dialog');
  await d.locator('.mon-card').waitFor();
  return d;
}
async function openDelete(p: Page) {
  await p.getByRole('dialog').getByRole('button', { name: 'Xóa tài khoản…' }).click();
  const c = p.getByRole('alertdialog');
  await c.waitFor();
  await c.locator('.del-counts, .del-empty, .del-note').first().waitFor();
  return c;
}
const toastInView = (p: Page) => p.locator('.users-toast').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0; });
const noInnerScroll = (p: Page) => p.locator('.del-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1);

try {
  await resetFixtures();
  const before = await statuses();

  const mail = await login('Khách Có Email', 390, 844);
  await check('non-admin cannot preview or delete accounts (404), nothing changes', async () => {
    const [preview, del] = await mail.page.evaluate(async id => [
      (await fetch(`/api/admin/users/${id}/deletion`)).status,
      (await fetch(`/api/admin/users/${id}/deletion`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ confirmUserId: id }) })).status,
    ], ID.dupEmpty);
    assert(preview === 404 && del === 404, `${preview}/${del}`);
    assert(await exists(ID.dupEmpty), 'account deleted by a customer');
  });

  const admin = await login('E2E Admin');
  const p = admin.page;
  const posts: string[] = [];
  p.on('request', r => { if (r.method() === 'POST' && r.url().includes('/deletion')) posts.push(r.url()); });

  await check('duplicate names are told apart by ID and email state, never labelled as test', async () => {
    await p.goto(`${BASE}/admin/users`);
    await search(p, 'Test User A', 2);
    const rows = await p.locator('.users-row').allInnerTexts();
    assert(rows[0].includes(short(ID.dupHeavy)) && rows[1].includes(short(ID.dupEmpty)), 'short ids missing');
    assert(rows.every(r => r.includes('Không có email đăng nhập')), 'email state');
    assert(!/tài khoản test|thử nghiệm|trùng lặp/i.test(await p.locator('main').innerText()), 'account labelled as test/duplicate');
    await shot(p, 'list-duplicates-1440');
  });
  await check('detail: full copyable ID; deletion is a quiet section after monitoring, not next to it', async () => {
    const d = await openDetail(p, ID.dupHeavy);
    assert(await d.getByLabel(`Mã tài khoản ${ID.dupHeavy}`).isVisible() && await d.getByRole('button', { name: 'Sao chép mã tài khoản' }).isVisible(), 'id');
    const order = await d.evaluate(el => [...el.querySelectorAll('.mon-card, .danger-zone')].map(x => x.className));
    assert(order[0].includes('mon-card') && order.at(-1)!.includes('danger-zone'), `order ${order}`);
    assert(!(await d.locator('.mon-card').getByRole('button', { name: /Xóa/ }).count()), 'delete inside monitoring card');
    await d.locator('.danger-zone').scrollIntoViewIfNeeded();
    await shot(p, 'detail-danger-zone-1440');
  });
  await check('loading state: identity shown at once, confirmation locked until the preview arrives', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    await p.route('**/deletion', async r => { if (r.request().method() === 'GET') await gate; await r.continue(); });
    await p.getByRole('dialog').getByRole('button', { name: 'Xóa tài khoản…' }).click();
    const c = p.getByRole('alertdialog');
    await c.getByText('Đang kiểm tra dữ liệu của tài khoản…').waitFor();
    assert((await c.locator('.del-who').innerText()).includes(ID.dupHeavy), 'identity missing while loading');
    assert(await c.locator('#del-word').isDisabled() && await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).isDisabled(), 'not locked');
    await shot(p, 'dialog-loading-1440');
    release(); await c.locator('.del-counts').waitFor();
    await p.unroute('**/deletion');
  });
  await check('substantial data: compact summary of real counts, details collapsed, no inner scrolling', async () => {
    const c = p.getByRole('alertdialog');
    const api = await p.evaluate(async id => (await fetch(`/api/admin/users/${id}/deletion`)).json(), ID.dupHeavy);
    const pills = await c.locator('.del-counts li').allInnerTexts();
    const want = [`${api.customerLeadCount} lead`, `${api.profileCount} nhu cầu theo dõi`, `${api.scanCount} lượt quét`, `${api.noteCount} ghi chú`, `${api.leadStatusCount} trạng thái lead`, `${api.groupRequestCount} đề xuất nhóm`];
    assert(JSON.stringify(pills) === JSON.stringify(want), `pills ${JSON.stringify(pills)} vs ${JSON.stringify(want)}`);
    assert(api.customerLeadCount === 40 && api.scanCount === 12 && api.noteCount === 5, 'fixture');
    assert(!(await c.locator('.del-details').evaluate(el => (el as HTMLDetailsElement).open)), 'details open by default');
    assert(await noInnerScroll(p), 'dialog body scrolls on desktop');
    const box = await c.boundingBox(); assert(box && box.height < 700, `dialog height ${box?.height}`);
    assert((await c.innerText()).match(/Không thể hoàn tác/g)?.length === 1, 'irreversibility repeated');
    await shot(p, 'dialog-heavy-1440');
    await c.getByText(/Xem chi tiết \d+ loại dữ liệu/).click();
    const values = await c.locator('.del-details dd').allInnerTexts();
    assert(values.length >= 6 && !values.includes('0'), `detail rows ${values.length}`);
    await shot(p, 'dialog-heavy-details-1440');
    return `pills: ${pills.join(', ')}; height ${Math.round(box!.height)}px`;
  });
  await check('confirmation word: XOA rejected, xóa/XÓA accepted', async () => {
    const c = p.getByRole('alertdialog'); const del = c.getByRole('button', { name: 'Xóa vĩnh viễn' });
    assert(await del.isDisabled(), 'enabled before typing');
    await c.locator('#del-word').fill('XOA'); assert(await del.isDisabled(), 'accepts XOA');
    await c.locator('#del-word').fill('xóa'); assert(await del.isEnabled(), 'rejects xóa');
    await c.locator('#del-word').fill('XÓA'); assert(await del.isEnabled(), 'rejects XÓA');
  });
  await check('Hủy and Escape close without deleting', async () => {
    const c = p.getByRole('alertdialog');
    await c.getByRole('button', { name: 'Hủy' }).click(); await c.waitFor({ state: 'detached' });
    assert(await p.getByRole('dialog').isVisible(), 'detail closed too');
    await openDelete(p); await p.keyboard.press('Escape'); await p.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert(posts.length === 0 && await exists(ID.dupHeavy), 'deleted on cancel');
  });
  await check('server errors are shown as clear messages; nothing changes', async () => {
    await p.route('**/deletion', r => r.request().method() === 'POST' ? r.fulfill({ status: 500, json: { error: 'internal_error', message: 'Không thể xóa tài khoản. Không có thay đổi nào được lưu.' } }) : r.continue());
    const c = await openDelete(p);
    await c.locator('#del-word').fill('XÓA');
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await c.locator('.del-note.is-error').filter({ hasText: 'Không có thay đổi nào được lưu' }).waitFor();
    assert(await exists(ID.dupHeavy) && !(await p.getByText('Đã xóa vĩnh viễn tài khoản').count()), 'state changed');
    await shot(p, 'dialog-server-error-1440');
    await p.unroute('**/deletion');
    await p.route('**/deletion', r => r.request().method() === 'POST' ? r.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }) : r.continue());
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await c.locator('.del-note.is-error').filter({ hasText: 'Chưa có thay đổi nào' }).waitFor();
    await p.unroute('**/deletion');
    await c.getByRole('button', { name: 'Hủy' }).click();
  });
  await check('successful deletion: busy lock, server-confirmed result, search kept, only that account removed', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    await p.route('**/deletion', async r => { if (r.request().method() === 'POST') await gate; await r.continue(); });
    const c = await openDelete(p);
    await c.locator('#del-word').fill('XÓA');
    const sent = posts.length;
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    const busy = c.getByRole('button', { name: 'Đang xóa…' }); await busy.waitFor();
    assert(await busy.isDisabled() && await c.getByRole('button', { name: 'Hủy' }).isDisabled(), 'not locked');
    assert(!(await p.getByText('Đã xóa vĩnh viễn tài khoản').count()), 'success before server answered');
    await shot(p, 'dialog-deleting-1440');
    release();
    await p.getByText(`Đã xóa vĩnh viễn tài khoản Test User A (ID ${short(ID.dupHeavy)}).`).waitFor();
    assert(await toastInView(p), 'success toast not in the viewport');
    await p.unroute('**/deletion');
    assert(posts.length === sent + 1, `POST sent ${posts.length - sent} times`);
    assert(!(await p.getByRole('dialog').count()) && !(await p.getByRole('alertdialog').count()), 'stale detail left open');
    assert(await p.getByRole('searchbox').inputValue() === 'Test User A', 'search reset');
    await p.waitForFunction(() => document.querySelectorAll('.users-row').length === 1);
    assert((await p.locator('.users-row').innerText()).includes(short(ID.dupEmpty)), 'wrong account removed');
    assert(!(await exists(ID.dupHeavy)) && await exists(ID.dupEmpty), 'db');
    const left = (await pool.query("SELECT count(*)::int AS n FROM facebook_posts WHERE normalized_url LIKE 'https://facebook.com/e2e-delete/heavy-%'")).rows[0].n;
    assert(left === 0, `${left} posts left`);
    const audit = (await pool.query('SELECT result, actor_user_id FROM admin_user_deletion_audit WHERE target_user_id = $1 ORDER BY occurred_at DESC LIMIT 1', [ID.dupHeavy])).rows[0];
    assert(audit?.result === 'deleted' && audit.actor_user_id === ID.admin, JSON.stringify(audit));
    await shot(p, 'list-after-delete-1440');
  });
  await check('empty account: one reassuring line instead of a table of zeros', async () => {
    await openDetail(p, ID.dupEmpty);
    const c = await openDelete(p);
    await c.getByText('Tài khoản chưa có dữ liệu').waitFor();
    assert(!(await c.locator('.del-counts').count()), 'zero pills shown');
    assert(await noInnerScroll(p), 'inner scroll');
    await shot(p, 'dialog-empty-1440');
    await c.getByRole('button', { name: 'Hủy' }).click(); await p.keyboard.press('Escape');
  });
  await check('a running search blocks deletion with a plain explanation (preview)', async () => {
    await search(p, 'Khách Đang Quét', 1);
    await openDetail(p, ID.busy);
    const c = await openDelete(p);
    const box = c.locator('.del-note.is-warn'); await box.waitFor();
    const text = await box.innerText();
    assert(text.includes('Chưa thể xóa lúc này') && text.includes('Đại lý điện máy') && text.includes('Chưa có gì bị xóa'), text);
    assert(!/lease|worker|job/i.test(await c.innerText()), 'technical wording');
    assert(await c.locator('#del-word').isDisabled() && await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).isDisabled(), 'still deletable');
    await shot(p, 'dialog-active-search-1440');
    await c.getByRole('button', { name: 'Hủy' }).click(); await p.keyboard.press('Escape');
  });
  await check('409 after the preview: explained in place, Kiểm tra lại, then delete succeeds', async () => {
    await search(p, 'co.email@e2e', 1);
    await openDetail(p, ID.mail);
    const c = await openDelete(p);
    assert((await c.locator('.del-who').innerText()).includes('co.email@e2e.qlead.test'), 'email');
    await pool.query(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, status, required_sources, lease_expires_at, attempts)
      VALUES ($1, 1, 'e2e-delete-race', now(), 'claimed', '["social.search"]', now() + interval '15 minutes', 1)`, [PROFILE.mail]);
    await c.locator('#del-word').fill('XÓA');
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await c.locator('.del-note.is-warn').filter({ hasText: 'Phần mềm bán hàng' }).waitFor();
    assert(!(await c.locator('.del-note.is-error').count()) && await exists(ID.mail), 'generic error or deleted');
    await shot(p, 'dialog-409-1440');
    await pool.query("UPDATE search_jobs SET status = 'completed', lease_expires_at = now() - interval '1 minute', completed_at = now() WHERE scan_id = 'e2e-delete-race'");
    await c.getByRole('button', { name: 'Kiểm tra lại' }).click();
    await c.locator('.del-note.is-warn').waitFor({ state: 'detached' });
    await c.locator('#del-word').fill('XÓA');
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await p.getByText('Đã xóa vĩnh viễn tài khoản Khách Có Email').waitFor();
    assert(!(await exists(ID.mail)), 'not deleted');
  });
  await check('the deleted customer is signed out', async () => {
    await mail.page.goto(`${BASE}/app`);
    await mail.page.waitForURL(/dang-nhap/);
  });
  await check('deleting the only account on page 2 returns to page 1 and updates counts', async () => {
    // 24 synthetic accounts are left; two more make page 2 hold exactly the oldest one.
    await pool.query("INSERT INTO users(id, display_name, created_at) VALUES ('00000000-0000-4000-8000-0000000dfa01', 'Khách thêm 1', now() - interval '2 days'), ('00000000-0000-4000-8000-0000000dfa02', 'Khách thêm 2', now() - interval '2 days')");
    await p.goto(`${BASE}/admin/users?page=2`);
    await p.locator('.users-row').first().waitFor();
    assert((await countText(p)).includes('26–26 trong 26'), await countText(p));
    await openDetail(p, bulkId(BULK));
    const c = await openDelete(p);
    await c.locator('#del-word').fill('XÓA');
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await p.getByText(`Đã xóa vĩnh viễn tài khoản Khách mẫu ${BULK}`).waitFor();
    await p.waitForFunction(() => document.querySelector('.users-count')?.textContent?.includes('1–25 trong 25'));
    assert(!(await p.getByRole('navigation', { name: 'Phân trang' }).count()) && !p.url().includes('page='), 'pager/url');
    await shot(p, 'pagination-after-delete-1440');
  });
  await check('success notice stays visible after deleting from far down a long list', async () => {
    await p.setViewportSize({ width: 1280, height: 720 });
    await search(p, '', 25);
    // The lowest synthetic sample customer on page 1 (never the signed-in admin).
    const ids = await p.locator('.users-id').evaluateAll(els => els.map(el => el.getAttribute('title') ?? ''));
    const id = [...ids].reverse().find(x => x.startsWith('00000000-0000-4000-8000-0000000df'))!;
    assert(id && ids.indexOf(id) >= 15, `no sample customer near the bottom (${ids.indexOf(id)})`);
    await p.locator('.users-row').filter({ hasText: short(id) }).scrollIntoViewIfNeeded();
    assert(await p.evaluate(() => window.scrollY > 300), 'list not scrolled');
    await openDetail(p, id);
    const c = await openDelete(p);
    await c.locator('#del-word').fill('XÓA');
    await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
    await p.locator('.users-toast').waitFor();
    assert(await toastInView(p), 'toast off-screen');
    await shot(p, 'toast-after-scrolled-delete-1280');
    await p.waitForTimeout(8500);
    assert(!(await p.locator('.users-toast').count()), 'toast did not auto-hide');
    await p.setViewportSize({ width: 1440, height: 900 });
  });
  await check('admin cannot delete the signed-in admin account', async () => {
    await search(p, ID.admin, 1);
    const d = await openDetail(p, ID.admin);
    assert(!(await d.getByRole('button', { name: 'Xóa tài khoản…' }).count()) && await d.getByText('không thể tự xóa').isVisible(), 'self delete offered');
    await p.keyboard.press('Escape');
  });

  for (const [width, height] of [[360, 740], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900]] as const) {
    await check(`responsive ${width}×${height}: long name, ID and actions fit`, async () => {
      await p.setViewportSize({ width, height });
      await p.goto(`${BASE}/admin/users?q=${encodeURIComponent('Nguyễn Hoàng')}`);
      await p.locator('.users-row').first().waitFor();
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'page overflows');
      const d = await openDetail(p, ID.long);
      await d.locator('.danger-zone').scrollIntoViewIfNeeded();
      assert(await d.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'drawer overflows');
      if (width === 390 || width === 768) await shot(p, `detail-danger-zone-${width}`);
      const c = await openDelete(p);
      assert(await c.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'dialog overflows');
      await c.locator('#del-word').fill('XÓA');
      const box = await c.getByRole('button', { name: 'Xóa vĩnh viễn' }).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 0.5 && box.y + box.height <= height + 0.5, 'delete button off-screen (footer must stay visible)');
      if (width >= 1024) assert(await noInnerScroll(p), 'inner scroll on desktop');
      await shot(p, `dialog-long-name-${width}`);
      await c.getByRole('button', { name: 'Hủy' }).click(); await p.keyboard.press('Escape');
    });
  }
  await check('only the three confirmed deletions happened; other accounts untouched', async () => {
    for (const id of [ID.dupEmpty, ID.busy, ID.admin, ID.long]) assert(await exists(id), `${id} missing`);
    const n = (await pool.query("SELECT count(*)::int AS n FROM admin_user_deletion_audit WHERE result = 'deleted' AND target_user_id::text LIKE '00000000-0000-4000-8000-%' AND occurred_at > now() - interval '30 minutes'")).rows[0].n;
    assert(n === 4, `deleted audits ${n}`);
    const after = await statuses();
    assert(Object.entries(before).every(([id, s]) => [ID.dupHeavy, ID.mail, bulkId(BULK)].includes(id) || !(id in after) || after[id] === s) && after[bulkId(3)] === 'suspended', 'statuses changed');
  });
  await check('no uncaught page errors', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')); });
} finally {
  await browser.close();
  await removeSynthetic();
  const passed = results.filter(r => r.pass).length;
  writeFileSync(resolve(SHOTS, '..', 'e2e-results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  console.log(`\n${passed}/${results.length} passed`);
  await pool.end();
  process.exitCode = passed === results.length ? 0 : 1;
}
