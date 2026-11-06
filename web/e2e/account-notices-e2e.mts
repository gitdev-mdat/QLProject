// Browser + API E2E for the account suspension experience (Admin pause/resume → customer notification center) on an
// ISOLATED test database (muse_bridge_test*), never the live one. It deletes and recreates only its own E2E users.
//
// 1. Start the web app against the test DB (migrations through 018), from web/:
//    DATABASE_URL=postgres://muse@127.0.0.1:55432/muse_bridge_test_notices QLEAD_ENVIRONMENT=local QLEAD_DIST_DIR=.next-notices
//    ENABLE_DEV_QUICK_LOGIN=true QLEAD_ADMIN_USER_IDS=00000000-0000-4000-8000-0000000000ad
//    DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,cust:E2E Khách Ngưng:00000000-0000-4000-8000-00000000c001,other:E2E Khách Khác:00000000-0000-4000-8000-00000000c009'
//    npx next dev --webpack -H 127.0.0.1 -p 3012
// 2. From the repo root with the same DATABASE_URL: npx tsx web/e2e/account-notices-e2e.mts http://127.0.0.1:3012
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3012';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at a muse_bridge_test* database.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/account-notices/screenshots');
mkdirSync(SHOTS, { recursive: true });

const ID = { admin: '00000000-0000-4000-8000-0000000000ad', cust: '00000000-0000-4000-8000-00000000c001', other: '00000000-0000-4000-8000-00000000c009' };
const PUBLIC_REASON = 'Gói dùng thử của bạn đã hết hạn.\nLiên hệ QLead qua Zalo để gia hạn.';
const INTERNAL = 'NỘI-BỘ-SECRET-7731 khách nợ phí';
const LEGACY_INTERNAL = 'GHI-CHU-CU-CHI-ADMIN-4410';
const P: string[] = [];

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0]! }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function resetFixtures() {
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(ID)]);
  // The customer was suspended once before this feature, with an Admin-only note; it must never become public.
  await pool.query(`INSERT INTO users(id, display_name, created_at, lead_monitoring_reason) VALUES ($1, 'E2E Admin', now() - interval '30 days', NULL), ($2, 'E2E Khách Ngưng', now() - interval '20 days', $4), ($3, 'E2E Khách Khác', now() - interval '20 days', NULL)`, [ID.admin, ID.cust, ID.other, LEGACY_INTERNAL]);
  await pool.query(`INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, 'khach.ngung@e2e.qlead.test', 'scrypt$e2e-not-a-real-hash', now()), ($2, 'khach.khac@e2e.qlead.test', 'scrypt$e2e-not-a-real-hash', now())`, [ID.cust, ID.other]);
  for (const [name, enabled] of [['Quán cafe sắp khai trương', true], ['Shop thời trang mở chi nhánh', true], ['Nhà thuốc cần phần mềm', false]] as const) {
    const { rows: [p] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind, created_at) VALUES ($1, $2, 'search_profile', now() - interval '10 days') RETURNING id", [ID.cust, name]);
    await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at) VALUES ($1, 1, $2, '["e2e"]', '', '["social.search"]', 30, $3, now() - interval '10 days')`, [p.id, enabled, `Tìm ${name.toLowerCase()}`]);
    P.push(p.id);
  }
  for (let i = 1; i <= 4; i++) await pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, platform) VALUES ($1, $2, $2, $3, 'E2E Page', now() - interval '2 hours', 'facebook')`, [P[0], `https://facebook.com/groups/e2e-notices/posts/${i}`, `Bài viết E2E số ${i}: quán cafe sắp khai trương cần máy POS`]);
  await pool.query(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1`, [P[0]]);
  await pool.query(`INSERT INTO lead_notes(user_id, post_id, body) SELECT $1, id, 'Ghi chú của khách E2E' FROM facebook_posts WHERE agent_connection_id = $2 LIMIT 1`, [ID.cust, P[0]]);
  // The last scan is days old: before this change, a suspended account showed "Đang chậm / Lượt quét đang chậm hơn lịch".
  await pool.query(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, 'e2e-notices-1', 1, now() - interval '3 days', 9, 4, 4, 0)`, [P[0]]);
}
const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM facebook_posts WHERE agent_connection_id = ANY($1::uuid[]))::int AS leads,
  (SELECT count(*) FROM lead_notes WHERE user_id = $2)::int AS notes, (SELECT count(*) FROM scan_runs WHERE agent_connection_id = ANY($1::uuid[]))::int AS scans,
  (SELECT count(*) FROM scan_configs WHERE agent_connection_id = ANY($1::uuid[]))::int AS configs, (SELECT count(*) FROM agent_connections WHERE user_id = $2)::int AS profiles`, [P, ID.cust])).rows[0];
const notifs = async (id = ID.cust) => (await pool.query('SELECT id, kind, public_reason, read_at FROM account_notifications WHERE user_id = $1 ORDER BY created_at DESC', [id])).rows;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium', headless: true });
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
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string, fullPage = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial' });
const SLOW = /Đang chậm|chậm hơn lịch|chậm hơn thường lệ|chậm hơn dự kiến/;
async function patch(p: Page, body: unknown) {
  return p.evaluate(async ([id, b]) => { const r = await fetch(`/api/admin/users/${id}/monitoring`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, [ID.cust, body] as const);
}
async function adminChange(p: Page, target: 'suspend' | 'resume', fill?: { publicReason?: string; internal?: string }, screenshot?: string) {
  await p.goto(`${BASE}/admin/users`);
  await p.getByRole('button', { name: 'Xem chi tiết E2E Khách Ngưng' }).click();
  const d = p.getByRole('dialog');
  await d.locator('.mon-card').waitFor();
  await d.getByRole('button', { name: target === 'suspend' ? 'Ngưng tìm lead' : 'Kích hoạt lại' }).click();
  const c = p.getByRole('alertdialog');
  if (fill?.publicReason) await c.getByLabel(/Lý do gửi cho khách/).fill(fill.publicReason);
  if (fill?.internal) await c.getByLabel(/Ghi chú nội bộ/).fill(fill.internal);
  if (screenshot) await p.screenshot({ path: `${SHOTS}/${screenshot}.png`, caret: 'initial' });
  await c.getByRole('button', { name: target === 'suspend' ? 'Ngưng tìm lead' : 'Kích hoạt lại' }).click();
  await c.waitFor({ state: 'detached' });
  await d.getByText(target === 'suspend' ? 'Đã ngưng tìm lead' : 'Đã kích hoạt lại tìm lead').first().waitFor();
  return d;
}

try {
  await resetFixtures();
  const before = await counts();
  const cust = await login('E2E Khách Ngưng', 390, 844);
  const c = cust.page;
  const admin = await login('E2E Admin');
  const a = admin.page;
  // Warm up routes (dev server compiles on first request).
  for (const path of ['/admin/users', '/app/bo-loc', '/app/thong-bao', '/app/lich-su-quet', '/app/bai-viet']) await (path.startsWith('/admin') ? a : c).goto(`${BASE}${path}`, { timeout: 120_000 });

  await check('active account: Today shows the normal subtitle, no hold note, no unread badge', async () => {
    await c.goto(`${BASE}/app`);
    await c.getByRole('heading', { name: 'Hôm nay', level: 1 }).waitFor();
    assert(!(await c.locator('.hold-note').count()), 'hold note while active');
    assert(!(await c.locator('.topbar-bell .unread-dot').count()), 'unread dot while nothing is unread');
  });

  // ---------- Case A: suspension with a public reason ----------
  await check('Admin modal separates the customer-facing reason from the internal note', async () => {
    await a.goto(`${BASE}/admin/users`);
    await a.getByRole('button', { name: 'Xem chi tiết E2E Khách Ngưng' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Ngưng tìm lead' }).click();
    const m = a.getByRole('alertdialog');
    await m.getByText('Để trống: khách chỉ nhận thông báo tạm dừng, không nhắc tới lý do.').waitFor();
    await m.getByLabel(/Lý do gửi cho khách/).fill('x');
    await m.getByText('Khách thấy đúng nội dung này khi bấm “Xem lý do”.').waitFor();
    assert((await m.innerText()).includes('chỉ quản trị viên thấy'), 'internal note label');
    await m.getByRole('button', { name: 'Hủy' }).click();
    await a.keyboard.press('Escape');
  });
  await check('A1: Admin suspends with a public reason and an internal note', async () => {
    const d = await adminChange(a, 'suspend', { publicReason: PUBLIC_REASON, internal: INTERNAL }, 'admin-confirm-suspend-1440');
    await d.getByText(INTERNAL).waitFor();
    const text = await d.innerText();
    assert(text.includes('Khách đã được thông báo, kèm lý do bạn gửi.'), 'admin confirmation of the notice');
    assert(text.includes('Lý do gửi khách') && text.includes('Gói dùng thử của bạn đã hết hạn.') && text.includes(INTERNAL), 'admin sees both fields');
    await a.screenshot({ path: `${SHOTS}/admin-detail-suspended-1440.png`, caret: 'initial' });
    const rows = await notifs();
    assert(rows.length === 1 && rows[0].kind === 'lead_monitoring_suspended' && rows[0].public_reason === PUBLIC_REASON, JSON.stringify(rows));
    await a.keyboard.press('Escape');
  });
  await check('A2: the customer gets the notice without reloading (badge within one shell poll)', async () => {
    const started = Date.now();
    await c.locator('.topbar-bell .unread-dot').waitFor({ timeout: 40_000 });
    assert(await c.locator('.topbar-bell').getAttribute('aria-label') === 'Thông báo, 1 chưa đọc', 'bell label');
    await c.locator('.hold-note').waitFor({ timeout: 5_000 });
    return `${Math.round((Date.now() - started) / 1000)}s`;
  });
  await check('A3: Today has one quiet status line, no amber banner and no "slow scan" warning', async () => {
    await c.reload(); await c.locator('.hold-note').waitFor();
    const body = await c.locator('body').innerText();
    assert(!SLOW.test(body), `slow-scan wording: ${body.match(SLOW)?.[0]}`);
    assert(!(await c.locator('.monitoring-suspended, .scan-late-note, .scan-countdown').count()), 'banner, late note or countdown present');
    assert((body.match(/tạm dừng/gi) ?? []).length <= 3, `"tạm dừng" repeated ${(body.match(/tạm dừng/gi) ?? []).length}×`);
    assert(await noOverflow(c), 'overflow 390');
    await shot(c, 'today-suspended-390');
  });
  await check('A4: Nhu cầu theo dõi states the hold once; cards carry no repeated warning; the customer pause is kept', async () => {
    await c.goto(`${BASE}/app/bo-loc`);
    await c.getByRole('heading', { name: 'Nhu cầu theo dõi', level: 1 }).waitFor();
    const head = await c.locator('.pf-page-head p').innerText();
    assert(head.includes('Tìm lead mới đang tạm dừng') && head.includes('2 nhu cầu đang bật sẽ tự tiếp tục'), head);
    const on = c.getByRole('article', { name: 'Quán cafe sắp khai trương' });
    assert(await on.locator('.pf-monitor').innerText() === 'Đang bật', 'enabled pill');
    assert(!(await on.locator('.pf-status, .pf-stage').count()), 'per-card hold panel repeated');
    assert(!(await on.getByRole('button', { name: 'Tìm lại ngay' }).count()), 'rescan offered while suspended');
    const paused = c.getByRole('article', { name: 'Nhà thuốc cần phần mềm' });
    const pausedPill = await paused.locator('.pf-monitor').innerText();
    assert(pausedPill === 'Bản nháp' || pausedPill === 'Tạm dừng', `customer pause pill ${pausedPill}`);
    assert(!SLOW.test(await c.locator('body').innerText()), 'slow wording on bo-loc');
    assert(await noOverflow(c), 'overflow 390');
    await shot(c, 'profiles-suspended-390');
  });
  await check('A5: Lịch sử quét and Danh sách lead show no false slow-scan state; saved leads remain', async () => {
    await c.goto(`${BASE}/app/lich-su-quet`);
    await c.locator('#app-content h1').waitFor();
    assert(!SLOW.test(await c.locator('body').innerText()), 'slow wording on history');
    await c.goto(`${BASE}/app/bai-viet`);
    await c.getByText('Bài viết E2E số 1').filter({ visible: true }).first().waitFor({ timeout: 15_000 });
    assert(!(await c.locator('.monitoring-suspended').count()), 'banner on lead list');
  });
  await check('A6: notification center shows the event; "Xem lý do" reveals exactly the published reason', async () => {
    await c.locator('.topbar-bell').click();
    await c.waitForURL(`${BASE}/app/thong-bao`);
    const item = c.locator('.notif').first();
    await item.getByText('Quản trị viên đã tạm dừng tìm lead mới cho tài khoản của bạn.').waitFor();
    assert((await item.innerText()).includes('Lead, ghi chú và lịch sử đã lưu vẫn được giữ nguyên'), 'data kept line');
    assert(!(await c.locator('.notif-reason').count()), 'reason shown before asked');
    await item.getByRole('button', { name: 'Xem lý do' }).click();
    const shown = await item.locator('.notif-reason').innerText();
    assert(shown === PUBLIC_REASON, `reason text differs: ${JSON.stringify(shown)}`);
    assert(await item.getByRole('button', { name: 'Ẩn lý do' }).getAttribute('aria-expanded') === 'true', 'aria-expanded');
    await shot(c, 'notifications-reason-390');
  });
  await check('A7: internal notes (current and legacy) never reach the customer page or API', async () => {
    const html = await c.content();
    const api = await c.evaluate(async () => JSON.stringify([await (await fetch('/api/notifications')).json(), await (await fetch('/api/account/monitoring')).json()]));
    for (const secret of [INTERNAL, 'NỘI-BỘ', LEGACY_INTERNAL]) assert(!html.includes(secret) && !api.includes(secret), `leaked ${secret}`);
  });
  await check('A8: read state follows real viewing; the badge clears; reload adds no duplicate', async () => {
    await c.waitForFunction(() => !document.querySelector('.topbar-bell .unread-dot'), undefined, { timeout: 10_000 });
    const rows = await notifs();
    assert(rows.length === 1 && rows[0].read_at !== null, JSON.stringify(rows));
    await c.reload(); await c.locator('.notif').first().waitFor();
    assert(await c.locator('.notif').count() === 1, 'duplicate after reload');
    assert(!(await c.locator('.notif.is-new').count()), 'still marked new after reload');
  });
  await check('A9: a retried Admin request changes nothing and creates no second notification', async () => {
    const r = await patch(a, { status: 'suspended', reason: 'retry', publicReason: 'retry' });
    assert(r.status === 200 && r.body.changed === false && r.body.notified === false, JSON.stringify(r));
    const [x, y] = await Promise.all([patch(a, { status: 'suspended' }), patch(a, { status: 'suspended' })]);
    assert(!x.body.changed && !y.body.changed, 'concurrent retry changed state');
    assert((await notifs()).length === 1, 'duplicate notification');
  });
  await check('A10: another account sees none of these notifications and cannot mark them read', async () => {
    const other = await login('E2E Khách Khác', 768, 1024);
    const ids = (await notifs()).map(r => r.id);
    await pool.query('UPDATE account_notifications SET read_at = NULL WHERE user_id = $1', [ID.cust]);
    const out = await other.page.evaluate(async ids => {
      const list = await (await fetch('/api/notifications')).json();
      const mark = await fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      return { list, mark: mark.status, body: await mark.json() };
    }, ids);
    assert(out.list.items.length === 0 && out.list.unread === 0, JSON.stringify(out.list));
    assert(out.mark === 200 && out.body.unread === 0, JSON.stringify(out));
    assert((await notifs()).every(r => r.read_at === null), 'foreign account marked them read');
    await pool.query('UPDATE account_notifications SET read_at = now() WHERE user_id = $1', [ID.cust]);
    const anon = await (await browser.newContext()).request.get(`${BASE}/api/notifications`);
    assert(anon.status() === 401, `anon ${anon.status()}`);
    const cross = await (await browser.newContext()).request.post(`${BASE}/api/notifications/read`, { headers: { Origin: 'https://evil.example', Cookie: (await other.context.cookies()).map(k => `${k.name}=${k.value}`).join('; ') }, data: { ids } });
    assert(cross.status() === 403, `cross-origin mark-read ${cross.status()}`);
    await other.context.close();
  });

  // ---------- Case C: reactivation ----------
  await check('C1: Admin reactivates; the customer is told QLead resumed, with no reason control', async () => {
    await adminChange(a, 'resume', undefined, 'admin-confirm-resume-1440');
    await a.keyboard.press('Escape');
    await c.goto(`${BASE}/app/thong-bao`);
    const item = c.locator('.notif').first();
    await item.getByText('QLead đã tiếp tục tìm lead mới cho tài khoản của bạn.').waitFor();
    assert(!(await item.getByRole('button', { name: /lý do/i }).count()), 'reason control on reactivation');
    assert((await item.innerText()).includes('Nhu cầu bạn tự tạm dừng vẫn giữ tạm dừng'), 'does not claim every need resumed');
    const rows = await notifs();
    assert(rows.length === 2 && rows[0].kind === 'lead_monitoring_resumed' && rows[0].public_reason === null, JSON.stringify(rows));
  });
  await check('C2: after reactivation the hold disappears, no false "late" right away, the customer pause is kept', async () => {
    await c.goto(`${BASE}/app`);
    await c.getByRole('heading', { name: 'Hôm nay', level: 1 }).waitFor();
    assert(!(await c.locator('.hold-note').count()), 'hold note after reactivation');
    assert(!SLOW.test(await c.locator('body').innerText()), 'reported late right after reactivation');
    await c.goto(`${BASE}/app/bo-loc`);
    assert(await c.getByRole('article', { name: 'Quán cafe sắp khai trương' }).locator('.pf-monitor').innerText() === 'Đang theo dõi', 'enabled need active');
    assert(['Bản nháp', 'Tạm dừng'].includes(await c.getByRole('article', { name: 'Nhà thuốc cần phần mềm' }).locator('.pf-monitor').innerText()), 'customer pause lost');
  });

  // ---------- Case B: suspension without a public reason ----------
  await check('B1: suspension without a public reason: notice shown, no mention of any reason', async () => {
    const d = await adminChange(a, 'suspend', { internal: 'Lần 2 chỉ nội bộ' });
    await d.getByText('Lần 2 chỉ nội bộ').waitFor();
    assert((await d.innerText()).includes('Không gửi lý do'), 'admin view');
    await a.keyboard.press('Escape');
    await c.goto(`${BASE}/app/thong-bao`);
    const item = c.locator('.notif').first();
    await item.getByText('Quản trị viên đã tạm dừng tìm lead mới cho tài khoản của bạn.').waitFor();
    const text = await item.innerText();
    assert(!/lý do/i.test(text), `reason wording: ${text}`);
    assert(!(await item.locator('button').count()), 'any button on a reason-less notice');
    assert(!(await c.content()).includes('Lần 2 chỉ nội bộ'), 'internal note leaked');
    const rows = await notifs();
    assert(rows.length === 3 && rows[0].public_reason === null, JSON.stringify(rows));
  });

  // ---------- Integrity, PWA, responsive ----------
  await check('integrity: leads, notes, scans, needs and configurations unchanged by suspend/resume/suspend', async () => {
    const after = await counts();
    assert(JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });
  await check('PWA settings still live on /app/thong-bao below the list (push card present)', async () => {
    await c.goto(`${BASE}/app/thong-bao`);
    await c.locator('#thong-bao').waitFor();
    await c.getByRole('heading', { name: 'Ứng dụng và thông báo trên thiết bị này' }).waitFor();
  });
  for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]] as const) {
    await check(`responsive ${w}px: Today, Nhu cầu, Thông báo fit without overflow; one status line at most`, async () => {
      await c.setViewportSize({ width: w, height: h });
      for (const [path, name] of [['/app', 'today'], ['/app/bo-loc', 'profiles'], ['/app/thong-bao', 'notifications']] as const) {
        await c.goto(`${BASE}${path}`);
        await c.locator('#app-content h1').waitFor();
        if (path === '/app/thong-bao') {
          await c.locator('.notif').nth(2).getByRole('button', { name: 'Xem lý do' }).click();
        }
        await c.waitForTimeout(300);
        assert(await noOverflow(c), `${path} overflows`);
        assert(!(await c.locator('.monitoring-suspended').count()), 'banner');
        assert(!SLOW.test(await c.locator('body').innerText()), `slow wording on ${path}`);
        await shot(c, `${name}-suspended-${w}`);
      }
      const bell = w < 1080 ? c.locator('.topbar-bell') : c.locator('.side-settings');
      assert(await bell.isVisible(), 'notification entry visible');
    });
  }
  await check('admin confirmation fits at 390px with both fields reachable', async () => {
    await a.setViewportSize({ width: 390, height: 844 });
    await a.goto(`${BASE}/admin/users`);
    await a.getByRole('button', { name: 'Xem chi tiết E2E Khách Ngưng' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Kích hoạt lại' }).waitFor();
    await patch(a, { status: 'active' });
    await a.reload();
    await a.getByRole('button', { name: 'Xem chi tiết E2E Khách Ngưng' }).click();
    await a.getByRole('dialog').getByRole('button', { name: 'Ngưng tìm lead' }).click();
    const m = a.getByRole('alertdialog');
    await m.getByLabel(/Ghi chú nội bộ/).scrollIntoViewIfNeeded();
    assert(await m.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'modal overflows');
    await a.screenshot({ path: `${SHOTS}/admin-confirm-suspend-390.png`, caret: 'initial' });
    await m.getByRole('button', { name: 'Hủy' }).click();
  });
  await check('no page errors in either browser', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')); });
} finally {
  writeFileSync(`${SHOTS}/../e2e-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await browser.close();
  await pool.end();
  process.exitCode = failed ? 1 : 0;
}
