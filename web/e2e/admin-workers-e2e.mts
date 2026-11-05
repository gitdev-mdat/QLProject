// Browser + API E2E for /admin/workers on the ISOLATED test database (never the live one).
// Muse workers are simulated in-process through the real Fastify worker API (app.inject); no real Muse or Facebook.
//
// 1. Start the web app against the test DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; $env:QLEAD_DIST_DIR='.next-admin-e2e'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'; $env:QLEAD_WORKER_PUBLIC_URL='https://qlead-e2e.example'
//    $env:DEV_QUICK_LOGIN_USERS='admin:E2E Admin:00000000-0000-4000-8000-0000000000ad,a:E2E User A:00000000-0000-4000-8000-0000000000a1,b:E2E User B:00000000-0000-4000-8000-0000000000b1'
//    $env:QLEAD_ADMIN_USER_IDS='00000000-0000-4000-8000-0000000000ad'; npm run dev -- -p 3005
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/admin-workers-e2e.ts http://127.0.0.1:3005
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/admin-screenshots');
mkdirSync(SHOTS, { recursive: true });

const ID = { admin: '00000000-0000-4000-8000-0000000000ad', a: '00000000-0000-4000-8000-0000000000a1', b: '00000000-0000-4000-8000-0000000000b1' };
const tok = { w1: randomBytes(32).toString('base64url'), w2: randomBytes(32).toString('base64url') };
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const W = { w1: '', w2: '', pa: '', pb: '' };

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const worker = (t: string) => ({
  status: () => app.inject({ method: 'GET', url: '/api/worker/status', headers: { authorization: `Bearer ${t}` } }),
  claim: async () => (await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${t}` }, payload: { max_jobs: 2 } })).json().jobs as any[],
  submit: (j: any, posts: Array<{ url: string; content: string }>) => app.inject({ method: 'POST', url: `/api/worker/jobs/${j.job_id}/results`, headers: { authorization: `Bearer ${t}` }, payload: {
    // attempt_no is required for retried/released jobs since the attempt-identity contract (src/worker-api.ts).
    event: 'facebook_scan_completed', source: 'muse', configuration_version: j.configuration_version, scan_id: j.scan_id, attempt_no: j.attempt_no, scanned_at: new Date().toISOString(),
    posts: posts.map(p => ({ url: p.url, content: p.content, author: 'E2E Page', published_at: new Date(Date.now() - 3600_000).toISOString(), platform: 'facebook', collected_via: 'qlead_shared_worker' })),
    stats: { total_found: posts.length }, errors: [] } }),
});
const m1 = worker(tok.w1); const m2 = worker(tok.w2);
let shift = 0;
const nextSlot = () => pool.query(`UPDATE search_jobs SET scheduled_for = scheduled_for - make_interval(days => $1) WHERE status IN ('completed', 'failed') AND scheduled_for > now() - interval '1 hour'`, [++shift]);

async function removeFixtures() {
  await pool.query('DELETE FROM worker_handoffs');
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ID.admin, ID.a, ID.b]]);
  await pool.query("DELETE FROM muse_workers WHERE name LIKE 'E2E %'");
}
async function resetFixtures() {
  await removeFixtures();
  for (const [id, name] of [[ID.admin, 'E2E Admin'], [ID.a, 'E2E User A'], [ID.b, 'E2E User B']]) await pool.query('INSERT INTO users(id, display_name) VALUES ($1, $2)', [id, name]);
  W.pa = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [ID.a])).rows[0].id;
  W.pb = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [ID.b])).rows[0].id;
  await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES ($1, 1, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 30), ($2, 1, '["khách sạn sắp khai trương"]', 'Hà Nội', '["social.search"]', 30)`, [W.pa, W.pb]);
  W.w1 = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes) VALUES ('E2E Muse 01', $1, 'active', 45) RETURNING id", [hash(tok.w1)])).rows[0].id;
  W.w2 = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes) VALUES ('E2E Muse 02', $1, 'paused', 45) RETURNING id", [hash(tok.w2)])).rows[0].id;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()} @ ${m.location().url}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  return { context, page };
}
// The worker cards live under "Chi tiết kỹ thuật" since the Kết nối Muse redesign.
const openTech = async (p: Page) => { if (await p.locator('.tech-details').getAttribute('open') === null) await p.locator('.tech-details > summary').click(); };
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
async function confirmModal(p: Page, label: string) { await p.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); await p.getByRole('dialog').waitFor({ state: 'detached' }); }

try {
  await resetFixtures();
  // Muse 02 did its one-time connection check earlier; Muse 01 works normally.
  assert((await m2.status()).statusCode === 200, 'muse 02 status');
  const first = await m1.claim();
  for (const j of first) await m1.submit(j, [{ url: `https://facebook.com/e2e/${j.search.location === 'Hà Nội' ? 'b' : 'a'}/1`, content: j.search.location === 'Hà Nội' ? 'Khách sạn E2E Hà Nội sắp khai trương' : 'Quán ăn E2E miền Nam sắp khai trương' }]);
  await nextSlot();
  const inFlight = await m1.claim(); // both jobs of the next slot stay in flight on Muse 01
  const historyBefore = (await pool.query('SELECT id, agent_connection_id, external_scan_id, status, received_at FROM scan_runs ORDER BY id')).rows;
  const w2Before = (await pool.query('SELECT last_seen_at, last_claim_at FROM muse_workers WHERE id = $1', [W.w2])).rows[0];

  // ---------- 17: access control ----------
  const userB = await login('E2E User B');
  await check('17 non-admin gets 404 on /admin/workers', async () => {
    const r = await userB.page.goto(`${BASE}/admin/workers`); assert(r?.status() === 404, `status ${r?.status()}`);
  });
  await check('17 non-admin is refused by admin APIs (server-side)', async () => {
    // fetch from the page so the Secure HttpOnly session cookie is sent exactly as the browser sends it
    const [get, post] = await userB.page.evaluate(async id => [
      (await fetch('/api/admin/workers')).status,
      (await fetch(`/api/admin/workers/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ action: 'activate' }) })).status,
    ], W.w2);
    assert(get === 404 && post === 404, `${get} / ${post}`);
    assert((await pool.query('SELECT status FROM muse_workers WHERE id = $1', [W.w2])).rows[0].status === 'paused', 'worker changed');
  });
  await check('17 anonymous request is 401; admin POST without CSRF header is 403', async () => {
    const anon = await (await browser.newContext()).request.get(`${BASE}/api/admin/workers`);
    assert(anon.status() === 401, `anon ${anon.status()}`);
  });

  const admin = await login('E2E Admin');
  const p = admin.page;
  await check('17 admin POST without CSRF header is rejected', async () => {
    const [noHeader, ok] = await p.evaluate(async id => [
      (await fetch(`/api/admin/workers/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'activate' }) })).status,
      (await fetch('/api/admin/workers')).status,
    ], W.w2);
    assert(noHeader === 403 && ok === 200, `${noHeader} / ${ok}`);
    consoleErrors.length = 0; // the intentional 404/403 responses above are logged by the browser
  });

  // ---------- 1/2: overview ----------
  await check('1 Muse 01 active, Muse 02 ready standby', async () => {
    await p.goto(`${BASE}/admin/workers`);
    await p.getByRole('heading', { name: /^Kết nối Muse/, level: 1 }).waitFor();
    await openTech(p);
    const c1 = p.getByRole('article', { name: 'E2E Muse 01' }); const c2 = p.getByRole('article', { name: 'E2E Muse 02' });
    assert(await c1.getByText('Tài khoản đang hoạt động').isVisible(), 'muse 01 label');
    assert(await c2.getByText('Tài khoản dự phòng · sẵn sàng').isVisible(), 'muse 02 label');
    assert(await c2.getByText('không chứng minh Muse đang trực tuyến').isVisible(), 'historical connection caveat');
    await shot(p, 'admin-overview-1440');
  });
  await check('2 standby Muse 02 made no requests while Muse 01 worked', async () => {
    const now = (await pool.query('SELECT last_seen_at, last_claim_at FROM muse_workers WHERE id = $1', [W.w2])).rows[0];
    assert(String(now.last_seen_at) === String(w2Before.last_seen_at) && now.last_claim_at === null, 'muse 02 contacted');
    return 'Muse 02 last_claim_at is null; only its one-time status check is recorded';
  });

  // ---------- 3: prepare ----------
  await check('3 admin reviews the pre-switch summary and prepares', async () => {
    await p.getByRole('button', { name: 'Xem lại công việc' }).click();
    const dialog = p.getByRole('dialog');
    await dialog.getByText('Tài khoản cũ đang xử lý', { exact: true }).waitFor();
    await shot(p, 'admin-prepare-modal-1440');
    const text = await dialog.innerText();
    assert(/Tài khoản cũ đang xử lý\s*2/.test(text), 'in-flight count 2 shown');
    await confirmModal(p, 'Tạo bản chuẩn bị');
    await p.getByText('Chuẩn bị chuyển đổi', { exact: true }).first().waitFor();
    assert((await pool.query('SELECT status FROM muse_workers WHERE id = $1', [W.w1])).rows[0].status === 'active', 'source untouched by prepare');
  });

  // ---------- 4: drain ----------
  await check('4 drain: Muse 01 stops claiming new jobs', async () => {
    await p.getByRole('button', { name: 'Ngừng nhận việc ở E2E Muse 01' }).click();
    await p.getByText('Đang chờ tài khoản cũ xử lý xong').first().waitFor();
    await nextSlot();
    assert((await m1.claim()).length === 0, 'draining worker got work');
  });

  // ---------- 7: normal cutover refused while in flight ----------
  await check('7 normal cutover is refused while Muse 01 holds valid leases', async () => {
    await p.getByRole('button', { name: 'Chuyển sang tài khoản mới', exact: true }).click();
    await confirmModal(p, 'Chuyển sang tài khoản mới');
    await p.getByRole('alert').getByText('vẫn đang giữ 2 job').waitFor();
    assert((await pool.query('SELECT status FROM worker_handoffs')).rows[0].status === 'draining', 'state changed');
    const refused = consoleErrors.filter(e => e.includes('409 (Conflict)')).length;
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter(e => !e.includes('409 (Conflict)'))); // the intended refusal
    return `refused with 409 (${refused} logged by the browser), handoff stays draining`;
  });

  // ---------- emergency cutover → awaiting ----------
  await check('8/15 emergency cutover shows AWAITING, not success', async () => {
    await p.getByRole('button', { name: 'Chuyển khẩn cấp', exact: true }).click();
    await confirmModal(p, 'Chuyển khẩn cấp');
    await p.getByText('chưa gọi QLead').waitFor();
    assert(!(await p.getByText('Chuyển đổi hoàn tất').isVisible()), 'claimed success');
    await shot(p, 'admin-awaiting-1440');
  });
  await check('16 refresh keeps the handoff state', async () => {
    await p.reload(); await p.getByText('Chờ Muse mới bắt đầu').first().waitFor();
    // Since 48b6120 the destination's work cycle is embedded in its Hook activation prompt.
    assert(await p.getByText('Prompt kích hoạt Hook · E2E Muse 02').isVisible(), 'activation prompt visible');
    const prompt = await p.locator('.copy-block pre').first().innerText();
    assert(prompt.includes('https://qlead-e2e.example') && !prompt.includes(tok.w2) && !prompt.includes(tok.w1), 'prompt must have URL and no credential');
  });

  // ---------- 9/8: stale Muse 01, Muse 02 starts ----------
  await check('9 stale Muse 01 submission is rejected after release', async () => {
    const r = await m1.submit(inFlight[0], [{ url: 'https://facebook.com/e2e/stale/1', content: 'stale' }]);
    assert(r.json().error === 'lease_lost', r.body);
  });
  await check('8 Muse 02 receives the interrupted jobs and completes them; UI shows real progress', async () => {
    await m2.status();
    await p.getByRole('button', { name: 'Kiểm tra lại' }).first().click();
    await p.getByText('Đang kiểm tra Muse mới').first().waitFor();
    const jobs = await m2.claim();
    assert(jobs.length === 2 && jobs.every(j => inFlight.some(i => i.job_id === j.job_id && i.scan_id === j.scan_id)), 'same job identities');
    for (const j of jobs) await m2.submit(j, [{ url: `https://facebook.com/e2e/${j.search.location === 'Hà Nội' ? 'b' : 'a'}/2`, content: j.search.location === 'Hà Nội' ? 'Khách sạn E2E thứ hai' : 'Quán ăn E2E thứ hai' }]);
    await p.getByRole('button', { name: 'Kiểm tra lại' }).first().click();
    await p.getByRole('heading', { name: 'Chuẩn bị chuyển đổi' }).waitFor();
    assert(await p.locator('.handoff-history li').first().getByText('Chuyển đổi hoàn tất').isVisible(), 'history shows completed');
    return 'jobs re-run as attempt 2 with the same job_id and scan_id';
  });

  await check('5/10/12 history unchanged and no duplicate results', async () => {
    const now = (await pool.query('SELECT id, agent_connection_id, external_scan_id, status, received_at FROM scan_runs ORDER BY id')).rows;
    for (const r of historyBefore) assert(JSON.stringify(now.find(n => n.id === r.id)) === JSON.stringify(r), 'history row changed');
    const dup = (await pool.query('SELECT search_job_id, count(*) FROM scan_runs WHERE search_job_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1')).rowCount;
    assert(dup === 0, 'duplicate scan rows');
    assert((await pool.query("SELECT count(*)::int AS n FROM facebook_posts WHERE normalized_url LIKE '%/e2e/stale/%'")).rows[0].n === 0, 'stale post stored');
  });

  await check('13 handoff is recorded with its event log', async () => {
    const { rows: [h] } = await pool.query('SELECT status, mode, released_jobs, events FROM worker_handoffs ORDER BY created_at DESC LIMIT 1');
    assert(h.status === 'completed' && h.mode === 'emergency' && h.released_jobs === 2, JSON.stringify({ s: h.status, m: h.mode, r: h.released_jobs }));
    return h.events.map((e: any) => e.type).join(' → ');
  });

  // ---------- 14: switch back ----------
  await check('14 switch back to Muse 01 with the same workflow (normal mode)', async () => {
    await p.locator('select').first().selectOption(W.w2);
    await p.locator('select').nth(1).selectOption(W.w1);
    await p.getByRole('button', { name: 'Xem lại công việc' }).click();
    await confirmModal(p, 'Tạo bản chuẩn bị');
    await p.getByRole('button', { name: 'Ngừng nhận việc ở E2E Muse 02' }).click();
    await p.getByText('Không còn job nào đang xử lý').waitFor();
    await p.getByRole('button', { name: 'Chuyển sang tài khoản mới', exact: true }).click();
    await confirmModal(p, 'Chuyển sang tài khoản mới');
    await p.getByText('chưa gọi QLead').waitFor();
    await nextSlot();
    for (const j of await m1.claim()) await m1.submit(j, []);
    await p.getByRole('button', { name: 'Kiểm tra lại' }).first().click();
    await p.getByRole('heading', { name: 'Chuẩn bị chuyển đổi' }).waitFor();
    const statuses = (await pool.query('SELECT status, mode FROM worker_handoffs ORDER BY created_at')).rows.map(r => `${r.status}/${r.mode}`);
    assert(statuses.join() === 'completed/emergency,completed/normal', statuses.join());
  });

  await check('standby polling after switch-back is flagged on the card', async () => {
    await m2.claim();
    await p.reload();
    await p.getByRole('article', { name: 'E2E Muse 02' }).getByText('vẫn gọi nhận việc').waitFor();
  });

  // ---------- 15: destination never starts ----------
  await check('15 failure to activate Muse 02 is displayed and recorded', async () => {
    await pool.query("UPDATE muse_workers SET last_claim_at = NULL WHERE id = $1", [W.w2]);
    await p.reload();
    await p.locator('select').first().selectOption(W.w1);
    await p.locator('select').nth(1).selectOption(W.w2);
    await p.getByRole('button', { name: 'Xem lại công việc' }).click();
    await confirmModal(p, 'Tạo bản chuẩn bị');
    await p.getByRole('button', { name: 'Chuyển sang tài khoản mới', exact: true }).click();
    await confirmModal(p, 'Chuyển sang tài khoản mới');
    await p.getByText('chưa gọi QLead').waitFor();
    await p.getByRole('button', { name: 'Muse mới không khởi động được' }).click();
    await p.getByRole('dialog').locator('textarea').fill('E2E: Muse 02 không gọi QLead');
    await confirmModal(p, 'Đánh dấu thất bại');
    await p.locator('.handoff-history li').first().getByText('Thất bại · cần xử lý').waitFor();
    await shot(p, 'admin-failed-history-1440');
    // Recover with the same workflow back to Muse 01 (emergency, nothing in flight).
    await p.locator('select').first().selectOption(W.w2);
    await p.locator('select').nth(1).selectOption(W.w1);
    await p.getByRole('button', { name: 'Xem lại công việc' }).click();
    await confirmModal(p, 'Tạo bản chuẩn bị');
    await p.getByRole('button', { name: 'Chuyển sang tài khoản mới', exact: true }).click();
    await confirmModal(p, 'Chuyển sang tài khoản mới');
    await p.getByText('chưa gọi QLead').waitFor();
    await nextSlot();
    for (const j of await m1.claim()) await m1.submit(j, []);
    await p.getByRole('button', { name: 'Kiểm tra lại' }).first().click();
    await p.getByRole('heading', { name: 'Chuẩn bị chuyển đổi' }).waitFor();
  });

  // ---------- add worker / credential handling ----------
  await check('add worker: starts paused, credential shown once and never in console', async () => {
    await p.getByRole('button', { name: 'Thêm tài khoản Muse' }).click();
    await p.getByRole('dialog').getByLabel('Tên tài khoản').fill('E2E Muse 03');
    await p.getByRole('dialog').getByRole('button', { name: 'Tạo tài khoản' }).click();
    const reveal = p.getByRole('dialog', { name: 'Mã bảo mật mới (chỉ hiện một lần)' });
    await reveal.waitFor();
    const credential = (await reveal.locator('pre').innerText()).trim();
    assert(/^[A-Za-z0-9_-]{40,}$/.test(credential), 'credential format');
    await reveal.getByRole('button', { name: 'Tôi đã lưu vào Muse' }).click();
    const card = p.getByRole('article', { name: 'E2E Muse 03' });
    await card.getByText('Tạm dừng · chưa xác minh kết nối').waitFor();
    assert(!consoleErrors.some(e => e.includes(credential)), 'credential in console');
    const { rows: [row] } = await pool.query("SELECT status, credential_hash FROM muse_workers WHERE name = 'E2E Muse 03'");
    assert(row.status === 'paused' && row.credential_hash === hash(credential), 'stored hash only');
    await card.getByRole('button', { name: 'Hướng dẫn kết nối' }).click();
    const setup = await p.getByRole('dialog').locator('pre').first().innerText();
    assert(setup.includes('/api/worker/status') && !setup.includes('jobs/claim with'), 'setup prompt is a single status check');
    await p.getByRole('dialog').getByRole('button', { name: 'Đóng' }).click();
  });

  // ---------- 11: tenant isolation in the customer UI ----------
  await check('11 User A sees only A leads; User B sees only B leads', async () => {
    const ua = await login('E2E User A');
    await ua.page.goto(`${BASE}/app/bai-viet`);
    const textA = await ua.page.locator('main').innerText();
    await userB.page.goto(`${BASE}/app/bai-viet`);
    const textB = await userB.page.locator('main').innerText();
    assert(textA.includes('Quán ăn E2E') && !textA.includes('Khách sạn E2E'), 'A view');
    assert(textB.includes('Khách sạn E2E') && !textB.includes('Quán ăn E2E'), 'B view');
    assert(!textA.includes('E2E Muse') && !textB.includes('E2E Muse'), 'worker identity exposed to customer');
    await ua.context.close();
  });

  // ---------- layouts ----------
  for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]] as const) {
    await check(`layout ${w}px has no horizontal overflow`, async () => {
      const v = await login('E2E Admin', w, h);
      await v.page.goto(`${BASE}/admin/workers`);
      await v.page.getByRole('heading', { name: /^Kết nối Muse/, level: 1 }).waitFor();
      await openTech(v.page);
      assert(await noOverflow(v.page), 'overflow');
      await shot(v.page, `admin-workers-${w}`);
      await v.page.getByRole('button', { name: 'Xem lại công việc' }).click();
      await v.page.getByRole('dialog').getByText('Tài khoản cũ đang xử lý', { exact: true }).waitFor();
      assert(await noOverflow(v.page), 'overflow in modal');
      await v.page.screenshot({ path: `${SHOTS}/admin-modal-${w}.png`, caret: 'initial' });
      await v.context.close();
    });
  }

  await check('18 legacy agents untouched (none exist in the test DB fixture besides pre-existing rows)', async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM agent_connections WHERE kind = 'legacy_agent' AND credential_hash IS NULL");
    assert(rows[0].n === 0, 'legacy row without credential');
  });
  await check('no browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ')); });
} finally {
  await browser.close();
  writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  // Leave the test DB empty so the backend suites, which refuse to run beside other profiles or workers, can run.
  if (!process.env.KEEP_FIXTURES) await removeFixtures();
  await app.close(); await pool.end();
  process.exitCode = failed ? 1 : 0;
}
