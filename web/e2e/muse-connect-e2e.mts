// Browser E2E for "Kết nối Muse" (/admin/workers): admin access + navigation, multiple Muse accounts, the one-prompt
// onboarding, safe handoff entry and the honest first-scan wait. ISOLATED database only; Muse is simulated through the
// real worker API (app.inject). No real Muse, Hook, Facebook or Production worker is touched.
//
// 1. Clone an empty schema:  docker exec muse-local-bridge-postgres-1 psql -U muse -d postgres -c "CREATE DATABASE muse_bridge_test_museconnect TEMPLATE muse_bridge_envtest"
// 2. Start web (from web/) with DATABASE_URL=…/muse_bridge_test_museconnect, QLEAD_DIST_DIR=.next-museconnect,
//    ENABLE_DEV_QUICK_LOGIN=true, QLEAD_WORKER_PUBLIC_URL=https://qlead-e2e.example, QLEAD_ADMIN_USER_IDS=00000000-0000-4000-8000-0000000000ad,
//    DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,k:E2E Khach:00000000-0000-4000-8000-0000000000a2'
//    then: npx next dev --webpack -H 127.0.0.1 -p 3032
// 3. From the repo root, same DATABASE_URL: npx tsx web/e2e/muse-connect-e2e.mts http://127.0.0.1:3032
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { museConnectPrompt } from '../lib/admin-prompts.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3032';
if (!/muse_bridge_test_museconnect/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_museconnect.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/muse-connect-20261105/screens');
mkdirSync(SHOTS, { recursive: true });

const ID = { admin: '00000000-0000-4000-8000-0000000000ad', k: '00000000-0000-4000-8000-0000000000a2' };
// Test-only password for the isolated admin account, generated per run and never printed.
const ADMIN_EMAIL = 'e2e-admin@qlead.test';
const ADMIN_PASSWORD = randomBytes(18).toString('base64url');
const scryptHash = (password: string) => { const salt = randomBytes(16); const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`; };
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const initialToken = randomBytes(32).toString('base64url');
let profileId = '';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const muse = (token: string) => ({
  status: () => app.inject({ method: 'GET', url: '/api/worker/status', headers: { authorization: `Bearer ${token}` } }),
  claim: async () => (await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${token}` }, payload: { max_jobs: 1 } })).json().jobs as any[],
  submit: (j: any) => app.inject({ method: 'POST', url: `/api/worker/jobs/${j.job_id}/results`, headers: { authorization: `Bearer ${token}` }, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: j.configuration_version, scan_id: j.scan_id, attempt_no: j.attempt_no, scanned_at: new Date().toISOString(),
    keywords_used: [], posts: [], stats: { total_found: 0 }, errors: [] } }),
});

async function reset() {
  await pool.query('DELETE FROM worker_handoffs');
  await pool.query('DELETE FROM search_job_attempts');
  await pool.query('DELETE FROM search_jobs');
  await pool.query('DELETE FROM scan_runs');
  await pool.query('DELETE FROM muse_workers');
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ID.admin, ID.k]]);
  await pool.query("INSERT INTO users(id, display_name) VALUES ($1, 'E2E Admin'), ($2, 'E2E Khach')", [ID.admin, ID.k]);
  // A fresh admin account exactly like Production's: password login, no search profile, onboarding never completed.
  await pool.query('INSERT INTO user_accounts(user_id, email, password_hash) VALUES ($1, $2, $3)', [ID.admin, ADMIN_EMAIL, scryptHash(ADMIN_PASSWORD)]);
  profileId = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Quán cà phê sắp mở', 'search_profile') RETURNING id", [ID.k])).rows[0].id;
  await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes, description) VALUES ($1, 1, '["quán cà phê sắp khai trương"]', 'TP.HCM', '["social.search"]', 30, 'Quán cà phê sắp khai trương ở TP.HCM')`, [profileId]);
  await pool.query(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind) VALUES ($1, 1, 'job-' || gen_random_uuid(), now(), '["social.search"]', 'initial')`, [profileId]);
  // Production today: one account, Muse Worker 02, paused and never verified.
  await pool.query("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes, max_jobs_per_claim) VALUES ('Muse Worker 02', $1, 'paused', 45, 1)", [hash(initialToken)]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
async function context(width = 1440, height = 900): Promise<{ context: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${page.url()} :: ${e.message}`));
  return { context: ctx, page };
}
async function devLogin(label: string, width = 1440, height = 900) {
  const c = await context(width, height);
  await c.page.goto(`${BASE}/dang-nhap`);
  await c.page.getByRole('button', { name: label, exact: true }).click();
  await c.page.waitForURL(/\/app/);
  return c;
}
const card = (p: Page) => p.locator('.mc-card');
const waitBadge = (p: Page, text: string, timeout = 15_000) => p.locator('.mc-card .mc-badge', { hasText: text }).waitFor({ timeout });
const row = (p: Page, name: string) => p.locator('.mc-worker', { hasText: name });
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const workerRow = async (name: string) => (await pool.query('SELECT status, credential_hash, connection_verified_at FROM muse_workers WHERE name = $1', [name])).rows[0];

/** Reads the one-time credential from the reveal dialog and closes it. */
async function takeCredential(p: Page): Promise<string> {
  const reveal = p.getByRole('dialog', { name: 'Mã bảo mật mới (chỉ hiện một lần)' });
  await reveal.waitFor();
  const credential = (await reveal.locator('pre').innerText()).trim();
  assert(/^[A-Za-z0-9_-]{40,}$/.test(credential), 'credential format');
  await reveal.getByRole('button', { name: 'Tôi đã lưu vào Muse' }).click();
  await reveal.waitFor({ state: 'detached' });
  return credential;
}

try {
  await reset();

  // ---------- 1–3, 13: access and navigation ----------
  await check('13a. Signed-out /app/admin goes to login (no 404, no Admin hint)', async () => {
    const { context: c, page } = await context();
    await page.goto(`${BASE}/app/admin`); await page.waitForURL(/\/dang-nhap/);
    await c.close();
  });

  const customer = await devLogin('E2E Khach');
  await check('13b. A customer gets the plain 404 on /app/admin and /admin/workers, and no Admin link', async () => {
    const r1 = await customer.page.goto(`${BASE}/app/admin`); assert(r1?.status() === 404, `/app/admin ${r1?.status()}`);
    const r2 = await customer.page.goto(`${BASE}/admin/workers`); assert(r2?.status() === 404, `/admin/workers ${r2?.status()}`);
    const api = await customer.page.evaluate(async () => (await fetch('/api/admin/workers', { cache: 'no-store' })).status); assert(api === 404, `api ${api}`);
    await customer.page.goto(`${BASE}/app`);
    assert(await customer.page.getByRole('link', { name: /Quản trị/ }).count() === 0, 'admin link shown to customer');
  });

  await check('First scan: honest wait while no verified worker is active (removed queue line)', async () => {
    await customer.page.goto(`${BASE}/app/lan-tim-dau`);
    await customer.page.getByRole('heading', { name: 'Lượt tìm đầu tiên chưa thể bắt đầu' }).waitFor();
    const body = await customer.page.locator('main').innerText();
    assert(!body.includes('Thời gian chờ trong hàng'), 'removed line');
    assert(!/Muse|worker|credential/i.test(body), 'no internal wording');
    assert(await customer.page.locator('.first-scan-indeterminate').count() === 0, 'no fake progress bar');
  });

  const { page } = await context();
  await check('1. A fresh admin password login lands in Admin, not onboarding or a 404', async () => {
    await page.goto(`${BASE}/dang-nhap`);
    await page.getByLabel('Email công việc').fill(ADMIN_EMAIL);
    await page.getByLabel('Mật khẩu', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /^Đăng nhập/ }).click();
    await page.waitForURL(`${BASE}/admin/workers`);
    await page.getByRole('heading', { name: /^Kết nối Muse/, level: 1 }).waitFor();
  });

  await check('2–3. /app shows the Admin link; /app/admin and the link both reach Admin', async () => {
    await page.goto(`${BASE}/app`); await page.waitForURL(`${BASE}/app`);
    await page.locator('.sidebar').getByRole('link', { name: 'Quản trị' }).click();
    await page.waitForURL(`${BASE}/admin/workers`);
    const r = await page.goto(`${BASE}/app/admin`); await page.waitForURL(`${BASE}/admin/workers`);
    assert(r?.status() === 200, `status ${r?.status()}`);
  });

  // ---------- 5–8: Muse 2 ----------
  await check('5. Muse Worker 02 is listed and selected; not connected', async () => {
    await waitBadge(page, 'Chưa kết nối');
    assert(await page.locator('.mc-worker').count() === 1, 'one account');
    assert(await row(page, 'Muse Worker 02').getAttribute('aria-pressed') === 'true', 'selected');
    assert((await card(page).getAttribute('data-worker')) === 'Muse Worker 02', 'card worker');
    assert(await page.locator('.mc-env').innerText() === 'Local', 'environment indicator (this isolated run is Local)');
    assert(await page.locator('.tech-details').getAttribute('open') === null, 'technical details collapsed');
    await shot(page, '01-muse2-not-connected-1440');
  });

  let copied = '';
  await check('6. Copy puts the complete prompt for the selected worker on the clipboard', async () => {
    await card(page).getByRole('button', { name: 'Sao chép prompt kết nối Muse' }).click();
    copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    assert(copied === await page.locator('.mc-prompt textarea').inputValue(), 'clipboard equals preview');
    for (const part of ['BƯỚC 0', 'BƯỚC 1', 'BƯỚC 2', 'BƯỚC 3', 'BƯỚC 4', 'BÁO CÁO CUỐI', '"Muse Worker 02"', 'https://qlead-e2e.example/api/worker/status']) assert(copied.includes(part), `missing ${part}`);
    assert(!copied.includes(initialToken) && !/Bearer\s+[A-Za-z0-9_-]{30,}/.test(copied) && !/postgres(ql)?:\/\/|service_role|DATABASE_URL/i.test(copied), 'secret in prompt');
    await waitBadge(page, 'Đang chờ Muse xác minh');
    return `${copied.length} ký tự`;
  });

  let token02 = '';
  await check('7. "Tạo mã bảo mật": one-time display, only the hash is stored, never in the page afterwards', async () => {
    await card(page).getByRole('button', { name: 'Tạo mã bảo mật' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Tạo mã bảo mật', exact: true }).click();
    token02 = await takeCredential(page);
    assert((await workerRow('Muse Worker 02')).credential_hash === hash(token02), 'stored hash');
    assert(!(await page.content()).includes(token02), 'credential still in page');
    assert(!(await page.locator('.mc-prompt textarea').inputValue()).includes(token02), 'credential in prompt');
    assert((await muse(initialToken).status()).statusCode === 401, 'old credential still works');
  });

  await check('9a. Waiting survives refresh and navigation', async () => {
    await page.reload(); await waitBadge(page, 'Đang chờ Muse xác minh');
    await page.getByRole('link', { name: 'Khách hàng' }).click(); await page.waitForURL(/admin\/users/);
    await page.getByRole('link', { name: 'Kết nối Muse' }).click(); await waitBadge(page, 'Đang chờ Muse xác minh');
  });

  await check('8. Verification is picked up automatically (Muse calls /status with the new credential)', async () => {
    assert((await muse(token02).status()).statusCode === 200, 'status 200');
    await waitBadge(page, 'Đã xác minh · chưa nhận việc', 12_000);
    await shot(page, '02-muse2-verified-1440');
  });

  await check('9. Activation when eligible', async () => {
    await card(page).getByRole('button', { name: 'Cho phép nhận việc' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cho phép nhận việc', exact: true }).click();
    await waitBadge(page, 'Sẵn sàng nhận việc');
    assert((await workerRow('Muse Worker 02')).status === 'active', 'db active');
    assert(await row(page, 'Muse Worker 02').getByText('ACTIVE').isVisible(), 'list shows ACTIVE');
    await shot(page, '03-muse2-ready-1440');
  });

  await check('First scan: normal queued copy once the service is ready, still without the removed line', async () => {
    await customer.page.goto(`${BASE}/app/lan-tim-dau`);
    await customer.page.getByRole('heading', { name: 'Đang chờ bắt đầu lượt tìm đầu tiên' }).waitFor();
    const est = await customer.page.locator('.first-scan-estimate').innerText();
    assert(est.includes('2–3 phút') && !est.includes('Thời gian chờ trong hàng'), est);
  });

  await check('Muse 2 completes a search; its record is counted', async () => {
    const jobs = await muse(token02).claim(); assert(jobs.length === 1, 'claimed');
    await page.goto(`${BASE}/admin/workers`); await waitBadge(page, 'Đang xử lý');
    assert((await muse(token02).submit(jobs[0])).statusCode === 200, 'submit');
    await page.goto(`${BASE}/admin/workers`); await waitBadge(page, 'Sẵn sàng nhận việc');
    assert((await row(page, 'Muse Worker 02').innerText()).includes('1 lượt tìm đã hoàn tất'), 'count');
  });

  // ---------- 4, 10–12: Muse 3 ----------
  let token03 = '';
  await check('4/10. Adding Muse 3 creates a separate paused worker without replacing Muse 2', async () => {
    await page.locator('.mc-list').getByRole('button', { name: 'Thêm tài khoản Muse' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thêm tài khoản Muse' });
    assert(await dialog.getByLabel('Tên tài khoản').inputValue() === 'Muse Worker 03', 'suggested name');
    await dialog.getByRole('button', { name: 'Tạo tài khoản' }).click();
    token03 = await takeCredential(page);
    await page.locator('.mc-worker').nth(1).waitFor();
    assert(await page.locator('.mc-worker').count() === 2, 'two accounts');
    assert(await row(page, 'Muse Worker 03').getAttribute('aria-pressed') === 'true', 'new one selected');
    assert((await workerRow('Muse Worker 02')).status === 'active' && (await workerRow('Muse Worker 03')).status === 'paused', 'statuses');
    assert((await row(page, 'Muse Worker 02').innerText()).includes('1 lượt tìm đã hoàn tất'), 'Muse 2 history kept');
    await waitBadge(page, 'Chưa kết nối');
    const p3 = await page.locator('.mc-prompt textarea').inputValue();
    assert(p3.includes('"Muse Worker 03"') && !p3.includes(token03), 'prompt targets Muse 3 without secret');
  });

  await check('11. Verified Muse 3 cannot be activated beside Muse 2; the safe handoff is offered instead', async () => {
    // As the owner would: copy Muse 3's prompt (QLead now waits for it), then Muse 3 calls /status.
    await card(page).getByRole('button', { name: 'Sao chép prompt kết nối Muse' }).click();
    await waitBadge(page, 'Đang chờ Muse xác minh');
    assert((await muse(token03).status()).statusCode === 200, 'status');
    await waitBadge(page, 'Đã xác minh · chưa nhận việc', 12_000);
    assert(await card(page).getByRole('button', { name: 'Cho phép nhận việc' }).count() === 0, 'activate offered');
    assert((await card(page).locator('.mc-next').innerText()).includes('Không lượt tìm nào bị bỏ'), 'explains safety');
    await shot(page, '04-muse3-needs-handoff-1440');
    await card(page).getByRole('button', { name: 'Chuẩn bị chuyển từ Muse Worker 02' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Tài khoản cũ đang xử lý', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Tạo bản chuẩn bị', exact: true }).click();
    await page.locator('.mc-handoff-banner').waitFor();
    await page.getByRole('heading', { name: 'Muse Worker 02 → Muse Worker 03' }).waitFor();
    assert((await workerRow('Muse Worker 02')).status === 'active', 'prepare changed the source');
    await shot(page, '05-handoff-prepared-1440');
    await page.getByRole('button', { name: 'Huỷ', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Huỷ chuyển đổi', exact: true }).click();
    await page.locator('.mc-handoff-banner').waitFor({ state: 'detached' });
    assert((await workerRow('Muse Worker 02')).status === 'active', 'cancel kept Muse 2 active');
  });

  await check('12. Records stay visible: both accounts, Muse 2 history, handoff history', async () => {
    await page.reload(); await page.locator('.mc-worker').nth(1).waitFor();
    await page.locator('.mc-worker[aria-pressed="true"]', { hasText: 'Muse Worker 03' }).waitFor({ timeout: 10_000 }); // selection survived refresh
    assert((await row(page, 'Muse Worker 02').innerText()).includes('1 lượt tìm đã hoàn tất'), 'history');
    if (await page.locator('.tech-details').getAttribute('open') === null) await page.locator('.tech-details > summary').click();
    assert(await page.locator('.handoff-history li').first().getByText('Đã huỷ').isVisible(), 'handoff history');
  });

  await check('13c. Error state: revoked credential is shown on the account', async () => {
    await pool.query("UPDATE muse_workers SET credential_status = 'revoked' WHERE name = 'Muse Worker 03'");
    await page.reload();
    await row(page, 'Muse Worker 03').getByText('Lỗi kết nối').waitFor();
    await waitBadge(page, 'Lỗi kết nối');
    assert(await card(page).getByRole('button', { name: /Tạo mã bảo mật/ }).isVisible(), 'recovery action');
    await pool.query("UPDATE muse_workers SET credential_status = 'active' WHERE name = 'Muse Worker 03'");
  });

  await check('Production prompt for Muse Worker 02 (pure): own connector, own Hook, no Local Hook switch', async () => {
    const p = museConnectPrompt({ environment: 'production', baseUrl: 'https://qlead.vercel.app', workerName: 'Muse Worker 02' });
    assert(p.includes('QLead Production') && p.includes('https://qlead.vercel.app/api/worker/status') && p.includes('"Muse Worker 02"'), 'env, url, worker');
    assert(p.includes('Connector dành riêng: "QLead Worker Production"') && p.includes('"QLead Worker", "Local Lead Bridge"'), 'connectors');
    assert(!p.includes('ngrok'), 'ngrok mentioned');
    assert(!p.includes('worker-dispatch') && !p.includes('ĐỒNG Ý CHUYỂN HOOK'), 'local hook switch');
    assert(p.includes('GET https://qlead.vercel.app/api/public/worker-wake') && p.includes('không tạo Hook trùng'), 'own hook, no duplicate');
    assert(!/Bearer\s+[A-Za-z0-9_-]{30,}/.test(p), 'secret');
  });

  await check('Viewports 390 / 768 / 1440: no horizontal scroll; mobile selection reveals the card', async () => {
    for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/admin/workers`); await page.locator('.mc-card').waitFor();
      assert(await noOverflow(page), `overflow at ${w}`);
      await shot(page, `06-admin-${w}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/admin/workers`); await page.locator('.mc-card').waitFor();
    await row(page, 'Muse Worker 02').click();
    await page.waitForFunction(() => { const r = document.querySelector('.mc-card')!.getBoundingClientRect(); return r.top < window.innerHeight && r.top > -10; });
    await page.screenshot({ path: `${SHOTS}/07-mobile-selected-390.png` });
    await page.goto(`${BASE}/app`); await page.waitForURL(`${BASE}/app`);
    assert(await page.locator('.app-topbar').getByRole('link', { name: 'Quản trị' }).isVisible(), 'mobile admin link');
    assert(await noOverflow(page), 'app overflow at 390');
    await page.screenshot({ path: `${SHOTS}/08-app-admin-link-390.png` });
    await customer.page.setViewportSize({ width: 390, height: 844 });
    await customer.page.goto(`${BASE}/app/lan-tim-dau`); assert(await noOverflow(customer.page), 'first scan 390');
  });

  await check('No page errors', async () => { assert(errors.length === 0, errors.join(' | ')); });
} finally {
  await browser.close();
  await app.close();
  await pool.end();
}
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
