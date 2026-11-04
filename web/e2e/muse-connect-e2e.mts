// Browser E2E for the redesigned /admin/workers ("Kết nối Muse") and the honest first-scan wait, on an ISOLATED
// database. Muse is simulated through the real worker API (app.inject); no real Muse, Hook or Facebook is touched.
//
// 1. Clone an empty schema:  docker exec muse-local-bridge-postgres-1 psql -U muse -d postgres -c "CREATE DATABASE muse_bridge_test_museconnect TEMPLATE muse_bridge_envtest"
// 2. Start web (from web/) with DATABASE_URL=…/muse_bridge_test_museconnect, QLEAD_DIST_DIR=.next-museconnect,
//    ENABLE_DEV_QUICK_LOGIN=true, QLEAD_WORKER_PUBLIC_URL=https://qlead-e2e.example, QLEAD_ADMIN_USER_IDS=00000000-0000-4000-8000-0000000000ad,
//    DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,a:E2E Khach:00000000-0000-4000-8000-0000000000a1'
//    then: npx next dev --webpack -H 127.0.0.1 -p 3031
// 3. From the repo root, same DATABASE_URL: npx tsx web/e2e/muse-connect-e2e.mts http://127.0.0.1:3031
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { museConnectPrompt } from '../lib/admin-prompts.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3031';
if (!/muse_bridge_test_museconnect/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_museconnect.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/muse-connect-20261104/screens');
mkdirSync(SHOTS, { recursive: true });

const ID = { admin: '00000000-0000-4000-8000-0000000000ad', a: '00000000-0000-4000-8000-0000000000a1' };
const token = randomBytes(32).toString('base64url');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
let workerId = ''; let profileId = '';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const museStatus = () => app.inject({ method: 'GET', url: '/api/worker/status', headers: { authorization: `Bearer ${token}` } });

async function reset() {
  await pool.query('DELETE FROM worker_handoffs');
  await pool.query('DELETE FROM search_job_attempts');
  await pool.query('DELETE FROM search_jobs');
  await pool.query('DELETE FROM muse_workers');
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ID.admin, ID.a]]);
  await pool.query("INSERT INTO users(id, display_name) VALUES ($1, 'E2E Admin'), ($2, 'E2E Khach')", [ID.admin, ID.a]);
  profileId = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Quán cà phê sắp mở', 'search_profile') RETURNING id", [ID.a])).rows[0].id;
  await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes, description) VALUES ($1, 1, '["quán cà phê sắp khai trương"]', 'TP.HCM', '["social.search"]', 30, 'Quán cà phê sắp khai trương ở TP.HCM')`, [profileId]);
  await pool.query(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind) VALUES ($1, 1, 'job-' || gen_random_uuid(), now(), '["social.search"]', 'initial')`, [profileId]);
  workerId = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes, max_jobs_per_claim) VALUES ('Muse Worker 02', $1, 'paused', 45, 1) RETURNING id", [hash(token)])).rows[0].id;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
async function login(label: string, width = 1440, height = 900): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(/\/app/);
  return { context, page };
}
const badge = (p: Page) => p.locator('.mc-badge').innerText();
const waitBadge = (p: Page, text: string, timeout = 15_000) => p.locator('.mc-badge', { hasText: text }).waitFor({ timeout });
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

try {
  await reset();
  const { page } = await login('E2E Admin');
  await page.goto(`${BASE}/admin/workers`);

  await check('1. Not connected: one main action, technical details collapsed', async () => {
    await waitBadge(page, 'Chưa kết nối');
    assert(await page.getByRole('heading', { name: /Kết nối Muse/ }).isVisible(), 'title');
    assert(await page.locator('.mc-env').innerText() === 'Local', 'environment indicator');
    assert(await page.getByRole('button', { name: 'Sao chép prompt kết nối Muse' }).isVisible(), 'copy button');
    assert(!(await page.locator('.tech-details').getAttribute('open') !== null), 'details closed');
    assert(!(await page.getByText('Hướng dẫn Hook').isVisible()), 'technical buttons hidden');
    await shot(page, '01-not-connected-1440');
  });

  let copied = '';
  await check('2. Copy puts the complete prompt on the clipboard', async () => {
    await page.getByRole('button', { name: 'Sao chép prompt kết nối Muse' }).click();
    // The OS clipboard on Windows stores CRLF; compare the text itself.
    copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    const shown = await page.locator('.mc-prompt textarea').inputValue();
    assert(copied.length > 1500 && copied === shown, `clipboard ${copied.length} vs preview ${shown.length}; first diff at ${[...copied].findIndex((ch, i) => ch !== shown[i])}`);
    for (const part of ['BƯỚC 0', 'BƯỚC 1', 'BƯỚC 2', 'BƯỚC 3', 'BƯỚC 4', 'BÁO CÁO CUỐI', '/api/worker/status']) assert(copied.includes(part), `missing ${part}`);
    return `${copied.length} ký tự`;
  });

  await check('3. Prompt targets the right worker and environment', async () => {
    assert(copied.includes('"Muse Worker 02"'), 'worker');
    assert(copied.includes('https://qlead-e2e.example'), 'base url');
    assert(copied.includes('connector "QLead Worker"') || copied.includes('Connector dành riêng: "QLead Worker"'), 'local connector');
    assert(copied.includes('"QLead Worker Production"'), 'names the other connector as off-limits');
  });

  await check('4. No secret in the copied content', async () => {
    assert(!copied.includes(token), 'worker token');
    assert(!/Bearer\s+[A-Za-z0-9_-]{30,}/.test(copied), 'bearer literal');
    assert(!/postgres(ql)?:\/\//i.test(copied) && !/service_role|DATABASE_URL|sk_live/i.test(copied), 'db/service secrets');
    assert(!(await page.content()).includes(token), 'page html');
  });

  await check('5. Waiting for Muse verification (bounded, honest)', async () => {
    await waitBadge(page, 'Đang chờ Muse xác minh');
    assert((await page.locator('.mc-text').innerText()).includes('Đã sao chép prompt lúc'), 'copy time shown');
    await shot(page, '02-waiting-1440');
  });

  await check('9a. Waiting survives refresh and navigation', async () => {
    await page.reload(); await waitBadge(page, 'Đang chờ Muse xác minh');
    await page.getByRole('link', { name: 'Khách hàng' }).click(); await page.waitForURL(/admin\/users/);
    await page.getByRole('link', { name: 'Kết nối Muse' }).click(); await waitBadge(page, 'Đang chờ Muse xác minh');
  });

  const customer = await login('E2E Khach');
  await check('First scan: honest wait while no verified worker is active', async () => {
    await customer.page.goto(`${BASE}/app/lan-tim-dau`);
    await customer.page.getByRole('heading', { name: 'Lượt tìm đầu tiên chưa thể bắt đầu' }).waitFor();
    const body = await customer.page.locator('main').innerText();
    assert(!body.includes('Thời gian chờ trong hàng'), 'removed line');
    assert(!/Muse|worker|credential/i.test(body), 'no internal wording');
    assert(await customer.page.locator('.first-scan-indeterminate').count() === 0, 'no fake progress bar');
    await shot(customer.page, '07-first-scan-not-ready');
  });

  await check('6. Verified but paused: page updates by itself after Muse calls /status', async () => {
    assert((await museStatus()).statusCode === 200, 'status 200');
    await waitBadge(page, 'Đã xác minh · đang tạm dừng', 12_000);
    assert(await page.getByRole('button', { name: 'Cho phép nhận việc' }).isVisible(), 'activate action');
    await shot(page, '03-verified-paused-1440');
  });

  await check('7. Active and ready after "Cho phép nhận việc"', async () => {
    await page.getByRole('button', { name: 'Cho phép nhận việc' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cho phép nhận việc', exact: true }).click();
    await waitBadge(page, 'Sẵn sàng nhận việc');
    await shot(page, '04-ready-1440');
  });

  await check('First scan: normal queued copy once the service is ready, without the removed line', async () => {
    await customer.page.reload();
    await customer.page.getByRole('heading', { name: 'Đang chờ bắt đầu lượt tìm đầu tiên' }).waitFor();
    const est = await customer.page.locator('.first-scan-estimate').innerText();
    assert(est.includes('2–3 phút') && !est.includes('Thời gian chờ trong hàng'), est);
    await shot(customer.page, '08-first-scan-queued');
  });

  await check('Stalled: work waiting but Muse never claimed', async () => {
    await pool.query("UPDATE search_jobs SET scheduled_for = now() - interval '40 minutes'");
    await pool.query("UPDATE muse_workers SET status_changed_at = now() - interval '40 minutes'");
    await page.reload(); await waitBadge(page, 'Muse chưa nhận việc');
    assert((await page.locator('.mc-next').innerText()).includes('Hook'), 'points at Hook');
    await shot(page, '05-stalled-1440');
  });

  await check('Busy while a search is claimed', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${token}` }, payload: { max_jobs: 1 } });
    assert(r.json().jobs.length === 1, 'claimed one');
    await page.reload(); await waitBadge(page, 'Đang xử lý');
  });

  await check('8. Connection failure (credential revoked)', async () => {
    await pool.query("UPDATE muse_workers SET credential_status = 'revoked'");
    await page.reload(); await waitBadge(page, 'Lỗi kết nối');
    assert(await page.getByRole('button', { name: /Tạo mã bảo mật/ }).isVisible(), 'recovery action');
    await shot(page, '06-error-1440');
    await pool.query("UPDATE muse_workers SET credential_status = 'active'");
  });

  await check('Production prompt (pure): Worker 02, Vercel URL, own connector, Hook gated', async () => {
    const p = museConnectPrompt({ environment: 'production', baseUrl: 'https://qlead.vercel.app', workerName: 'Muse Worker 02', dispatchRelaysLocal: false });
    assert(p.includes('QLead Production') && p.includes('https://qlead.vercel.app/api/worker/status'), 'env + url');
    assert(p.includes('Connector dành riêng: "QLead Worker Production"'), 'own connector');
    assert(p.includes('"QLead Worker", "Local Lead Bridge"'), 'local connectors off-limits');
    assert(!p.includes('ngrok-skip-browser-warning: true. ') && !/Kèm header ngrok/.test(p.split('BƯỚC 4')[0]!), 'no ngrok header for production');
    assert(p.includes('ĐỒNG Ý CHUYỂN HOOK SANG PRODUCTION') && p.includes('Local sẽ ngừng được đánh thức'), 'hook gated + local warning');
    assert(p.includes('/api/public/worker-dispatch') && p.includes('Không tạo Hook mới'), 'dispatcher, no new hook');
    assert(!/Bearer\s+[A-Za-z0-9_-]{30,}/.test(p), 'no secret');
  });

  await check('10. Responsive 390 / 768 / 1440 without horizontal scroll', async () => {
    const out: string[] = [];
    for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${BASE}/admin/workers`); await page.locator('.mc-badge').waitFor();
      assert(await noOverflow(page), `overflow at ${w}`);
      await shot(page, `09-responsive-${w}`);
      out.push(String(w));
    }
    await customer.page.setViewportSize({ width: 390, height: 844 });
    await customer.page.reload(); assert(await noOverflow(customer.page), 'first scan 390 overflow');
    return out.join('/');
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
