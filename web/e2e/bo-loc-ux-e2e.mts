// UX states of /app/bo-loc (Nhu cầu theo dõi) on an ISOLATED test database, never the live one. Seeds search
// profiles and stored search states directly (no Muse, no worker process, no Facebook) and checks what a customer sees.
//
// 1. Start the web app against the test DB (from web/; the DB must have migration 013):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test_boloc'; $env:QLEAD_DIST_DIR='.next-boloc'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'; $env:QLEAD_ADMIN_USER_IDS=''
//    $env:DEV_QUICK_LOGIN_USERS='ux:E2E Bộ lọc:00000000-0000-4000-8000-00000000b001,ngung:E2E Bị ngưng:00000000-0000-4000-8000-00000000b002,cho:E2E Chờ:00000000-0000-4000-8000-00000000b003,trong:E2E Trống:00000000-0000-4000-8000-00000000b004'
//    npx next dev --webpack -H 127.0.0.1 -p 3015
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/bo-loc-ux-e2e.mts http://127.0.0.1:3015
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3015';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at a muse_bridge_test* database.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/bo-loc-ux-20261103/screenshots');
mkdirSync(SHOTS, { recursive: true });

const U = { ux: '00000000-0000-4000-8000-00000000b001', ngung: '00000000-0000-4000-8000-00000000b002', cho: '00000000-0000-4000-8000-00000000b003', trong: '00000000-0000-4000-8000-00000000b004' };
const LONG = 'Tìm các chuỗi cửa hàng bán lẻ, siêu thị mini, cửa hàng tiện lợi và nhà thuốc đang mở thêm chi nhánh mới, đang tuyển quản lý cửa hàng, thu ngân hoặc nhân viên kho cho chi nhánh sắp khai trương, hoặc chủ cửa hàng đang hỏi kinh nghiệm chọn phần mềm quản lý bán hàng, máy POS, máy in hóa đơn và đầu đọc mã vạch cho cửa hàng mới.';
const P: Record<string, string> = {};
let workerId = '';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

async function profile(user: string, key: string, name: string, configs: Array<{ description: string; enabled?: boolean; location?: string; ago?: string; keywords?: string[]; frequency?: number }>) {
  const [{ id }] = await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind, created_at) VALUES ($1, $2, 'search_profile', now() - interval '3 days') RETURNING id", [user, name]);
  let version = 0;
  for (const c of configs) {
    version++;
    await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, updated_at)
      VALUES ($1, $2, $3, $4, 'description', $5, '["social.search"]', $6, $7, now() - $8::interval)`,
    [id, version, c.enabled ?? true, JSON.stringify(c.keywords ?? ['quán cafe sắp khai trương', 'tuyển nhân viên quán mới', 'sắp khai trương quán', 'mở chi nhánh mới', 'cần phần mềm bán hàng', 'tư vấn máy POS']), c.location ?? '', c.frequency ?? 60, c.description, c.ago ?? '2 days']);
  }
  P[key] = id;
  return id;
}
type JobSpec = { version: number; kind: 'initial' | 'manual' | 'scheduled'; status: 'pending' | 'claimed' | 'completed' | 'failed'; createdAgo: string; scheduledFor?: string; finishedAgo?: string; newPosts?: number; total?: number; runStatus?: string };
async function job(profileId: string, s: JobSpec) {
  const [j] = await q<{ id: string }>(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind, status, created_at, completed_at, attempts, requested_by_user_id)
    VALUES ($1, $2, 'job-e2e-' || gen_random_uuid(), coalesce($8::timestamptz, now() - $3::interval), '["social.search"]', $4, $5, now() - $3::interval, CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::interval END, $7,
      (SELECT user_id FROM agent_connections WHERE id = $1)) RETURNING id`,
  [profileId, s.version, s.createdAgo, s.kind, s.status, s.finishedAgo ?? null, s.status === 'pending' ? 0 : 1, s.scheduledFor ?? null]);
  if (s.status !== 'pending') {
    const [a] = await q<{ id: string }>(`INSERT INTO search_job_attempts(job_id, worker_id, attempt_no, claimed_at, lease_expires_at, outcome, finished_at)
      VALUES ($1, $2, 1, now() - $3::interval + interval '1 minute', now() + interval '15 minutes', $4, CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $5::interval END) RETURNING id`,
    [j.id, workerId, s.createdAgo, s.status === 'claimed' ? 'running' : s.status, s.finishedAgo ?? null]);
    await q(`UPDATE search_jobs SET current_attempt_id = $2, claimed_by_worker_id = $3, lease_expires_at = CASE WHEN status = 'claimed' THEN now() + interval '15 minutes' END WHERE id = $1`, [j.id, a.id, workerId]);
  }
  if (s.finishedAgo) {
    await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status, search_job_id, executed_by_worker_id)
      VALUES ($1, 'e2e-' || gen_random_uuid(), $2, now() - $3::interval, now() - $3::interval, $4, $5, $5, 0, $6, $7, $8)`,
    [profileId, s.version, s.finishedAgo, s.total ?? 0, s.newPosts ?? 0, s.runStatus ?? (s.status === 'failed' ? 'failed' : 'success'), j.id, workerId]);
  }
}
async function run(profileId: string, version: number, ago: string, newPosts: number, total: number) {
  await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status)
    VALUES ($1, 'e2e-' || gen_random_uuid(), $2, now() - $3::interval, now() - $3::interval, $4, $5, $5, 0, 'success')`, [profileId, version, ago, total, newPosts]);
}
async function posts(profileId: string, n: number, ago = '30 minutes') {
  for (let i = 0; i < n; i++) await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    VALUES ($1, $2, $2, 'Quán cà phê mới sắp khai trương ở Thủ Đức, đang tìm phần mềm bán hàng.', 'E2E Trang', now() - $3::interval, now() - $3::interval, 'qlead_shared_worker')`,
  [profileId, `https://facebook.com/e2e-boloc/${profileId}/${i}`, ago]);
}

async function removeFixtures() {
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  await q("DELETE FROM muse_workers WHERE name = 'E2E bo-loc worker'");
}
async function seed() {
  await removeFixtures();
  // Pause every other worker-visible job source is unnecessary: this test never runs a worker, it only stores states.
  const [w] = await q<{ id: string }>("INSERT INTO muse_workers(name, credential_hash, status) VALUES ('E2E bo-loc worker', $1, 'paused') RETURNING id", [createHash('sha256').update(randomBytes(16)).digest('hex')]);
  workerId = w.id;
  await q('INSERT INTO users(id, display_name) VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)', [U.ux, 'E2E Bộ lọc', U.ngung, 'E2E Bị ngưng', U.cho, 'E2E Chờ', U.trong, 'E2E Trống']);
  await q("UPDATE users SET lead_monitoring_status = 'suspended', lead_monitoring_suspended_at = now() WHERE id = $1", [U.ngung]);

  const slot = "to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600)";
  const [{ slotAt }] = await q<{ slotAt: string }>(`SELECT ${slot} AS "slotAt"`);

  // ux: one card per search state
  await profile(U.ux, 'new', 'Quán cafe sắp khai trương', [{ description: 'Quán cafe, trà sữa sắp khai trương ở TP.HCM', location: 'TP.HCM', ago: '2 minutes' }]);
  await job(P.new, { version: 1, kind: 'initial', status: 'pending', createdAgo: '2 minutes' });

  await profile(U.ux, 'queued', 'Nhà hàng tuyển nhân viên', [{ description: 'Nhà hàng chuẩn bị khai trương hoặc đang tuyển nhân viên phục vụ' }]);
  await run(P.queued, 1, '3 hours', 1, 14); await posts(P.queued, 1, '3 hours');
  await job(P.queued, { version: 1, kind: 'manual', status: 'pending', createdAgo: '1 minute' });

  await profile(U.ux, 'running', 'Tiệm bánh mở chi nhánh', [{ description: 'Tiệm bánh, tiệm trà đang mở thêm chi nhánh mới' }]);
  await job(P.running, { version: 1, kind: 'manual', status: 'claimed', createdAgo: '3 minutes' });

  await profile(U.ux, 'results', 'Spa, thẩm mỹ viện mới', [{ description: 'Spa, thẩm mỹ viện sắp khai trương cần phần mềm quản lý lịch hẹn', location: 'Hà Nội' }]);
  await job(P.results, { version: 1, kind: 'manual', status: 'completed', createdAgo: '12 minutes', finishedAgo: '8 minutes', newPosts: 3, total: 21 });
  await posts(P.results, 5, '8 minutes');

  await profile(U.ux, 'none', 'Cửa hàng điện thoại', [{ description: 'Cửa hàng điện thoại, phụ kiện mới mở cần máy in hóa đơn' }]);
  await job(P.none, { version: 1, kind: 'manual', status: 'completed', createdAgo: '20 minutes', finishedAgo: '16 minutes', newPosts: 0, total: 9 });

  await profile(U.ux, 'failed', 'Khách sạn mới ở Đà Lạt', [{ description: 'Khách sạn, homestay mới khai trương ở Đà Lạt', location: 'Đà Lạt' }]);
  await job(P.failed, { version: 1, kind: 'manual', status: 'failed', createdAgo: '30 minutes', finishedAgo: '25 minutes', runStatus: 'failed' });

  await profile(U.ux, 'recurring', 'Siêu thị mini mở mới', [{ description: 'Siêu thị mini, cửa hàng tiện lợi mới mở cần phần mềm bán hàng' }]);
  await job(P.recurring, { version: 1, kind: 'scheduled', status: 'completed', createdAgo: '40 minutes', scheduledFor: slotAt, finishedAgo: '35 minutes', newPosts: 2, total: 17 });
  await posts(P.recurring, 4, '35 minutes');

  await profile(U.ux, 'editedRunning', 'Quán nhậu sắp khai trương', [{ description: 'Quán nhậu sắp khai trương', ago: '1 day' }, { description: 'Quán nhậu, quán nướng sắp khai trương hoặc đang tuyển nhân viên', ago: '1 minute' }]);
  await job(P.editedRunning, { version: 1, kind: 'manual', status: 'claimed', createdAgo: '4 minutes' });

  await profile(U.ux, 'editedDone', 'Nhà thuốc mở chi nhánh', [{ description: 'Nhà thuốc mở chi nhánh', ago: '1 day' }, { description: 'Nhà thuốc, chuỗi dược phẩm mở chi nhánh mới cần phần mềm quản lý kho', ago: '2 minutes' }]);
  await job(P.editedDone, { version: 1, kind: 'manual', status: 'completed', createdAgo: '15 minutes', finishedAgo: '10 minutes', newPosts: 2, total: 11 });
  await posts(P.editedDone, 2, '10 minutes');

  await profile(U.ux, 'paused', 'Gara ô tô (tạm dừng)', [{ description: 'Gara ô tô, tiệm rửa xe mới mở', ago: '5 days' }, { description: 'Gara ô tô, tiệm rửa xe mới mở', enabled: false, ago: '1 day' }]);
  await run(P.paused, 1, '2 days', 2, 20); await posts(P.paused, 2, '2 days');

  // cho: draft, a routine search that is due but not started, a long description waiting longer than expected
  await profile(U.cho, 'draft', 'Tiệm hoa (nháp)', [{ description: 'Tiệm hoa tươi sắp khai trương', enabled: false, ago: '1 hour' }]);
  await profile(U.cho, 'delayed', 'Chuỗi bán lẻ mở chi nhánh', [{ description: LONG, ago: '1 day' }]);
  await run(P.delayed, 1, '2 hours', 0, 12);
  await job(P.delayed, { version: 1, kind: 'manual', status: 'pending', createdAgo: '35 minutes' });
  await profile(U.cho, 'due', 'Quán ăn sáng', [{ description: 'Quán ăn sáng, quán phở mới mở', ago: '1 day', frequency: 30 }]);
  await run(P.due, 1, '40 minutes', 1, 8); await posts(P.due, 1, '40 minutes');

  // ngung: account suspended by an admin
  await profile(U.ngung, 'suspended', 'Quán karaoke mới', [{ description: 'Quán karaoke, pub mới mở cần phần mềm tính tiền giờ' }]);
  await run(P.suspended, 1, '1 day', 3, 30); await posts(P.suspended, 3, '1 day');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pageErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  const page = await context.newPage();
  page.on('pageerror', e => pageErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith('/app'));
  await page.goto(`${BASE}/app/bo-loc`);
  await page.locator('.page-head h1').waitFor();
  return { context, page };
}
const card = (p: Page, key: string) => p.locator('.pf-card').filter({ has: p.locator(`#profile-${P[key]}`) });
const statusOf = async (p: Page, key: string) => (await card(p, key).locator('.pf-stage, .pf-status').innerText()).replace(/\s+/g, ' ');
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string, full = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full, caret: 'initial' });
const FORBIDDEN = /worker|\bjob\b|hàng chờ|scheduler|lease|claim|muse|phiên bản cấu hình|hệ thống nhận việc|đang xử lý/i;

try {
  await seed();
  const { page: ux } = await login('E2E Bộ lọc');

  await check('each stored state reads as one plain answer', async () => {
    const want: Record<string, RegExp> = {
      new: /Sắp tìm lần đầu.*Chưa bắt đầu/, queued: /Đã nhận yêu cầu tìm lại.*Chưa bắt đầu/, running: /Đang tìm khách hàng…/,
      results: /Tìm thấy 3 khách hàng mới.*Xem khách hàng mới/, none: /Đã tìm xong, chưa có khách hàng mới.*Chỉnh mô tả/, failed: /Lần tìm này chưa thành công/,
      recurring: /Lần tìm gần nhất: 2 khách hàng mới.*tự tìm lại mỗi giờ/, paused: /Đã tạm dừng theo dõi.*Bật lại theo dõi/,
    };
    const seen: string[] = [];
    for (const [key, re] of Object.entries(want)) { const s = await statusOf(ux, key); assert(re.test(s), `${key}: ${s}`); seen.push(key); }
    return seen.join(', ');
  });
  await check('waiting is never presented as running', async () => {
    for (const key of ['new', 'queued']) {
      const c = card(ux, key);
      assert(!(await c.innerText()).includes('Đang tìm khách hàng'), `${key} says running`);
      assert(await c.locator('.pf-pulse').count() === 0, `${key} animates`);
    }
    assert(await card(ux, 'running').locator('.pf-pulse').count() === 1, 'running card has no live marker');
    assert(await card(ux, 'running').locator('.pf-steps li.is-current .pf-step-label').innerText() === 'Đang tìm', 'running step');
    assert(await card(ux, 'queued').locator('.pf-steps li.is-current .pf-step-label').innerText() === 'Chờ bắt đầu', 'queued step');
    assert(/Đã xem\s*21\s*bài đăng/.test(await card(ux, 'results').locator('.pf-stats').innerText()), 'real counts');
    assert(await ux.locator('.first-scan-indeterminate, [role=progressbar]').count() === 0, 'a progress bar is shown');
  });
  await check('no internal terms or keyword chips competing on the cards', async () => {
    const text = await ux.locator('main').innerText();
    const bad = text.match(FORBIDDEN);
    assert(!bad, `found "${bad?.[0]}"`);
    const visibleChips = await ux.locator('.pf-card .keyword-chips li:visible').count();
    assert(visibleChips === 0, `${visibleChips} phrases visible before opening`);
  });
  await check('"Không giới hạn khu vực" is kept as the owner chose', async () => {
    const meta = await card(ux, 'queued').locator('.pf-meta').innerText();
    assert(meta.includes('Không giới hạn khu vực'), meta);
    assert((await card(ux, 'results').locator('.pf-meta').innerText()).includes('Hà Nội'), 'named area');
  });
  await check('search started before the latest save is labelled honestly', async () => {
    const running = await statusOf(ux, 'editedRunning');
    assert(/Đang tìm khách hàng/.test(running) && /bắt đầu trước khi bạn lưu thay đổi gần nhất/.test(running), running);
    const done = await statusOf(ux, 'editedDone');
    assert(/tìm theo mô tả trước khi bạn sửa/.test(done) && /Tìm theo mô tả mới/.test(done), done);
    const fresh = await statusOf(ux, 'results');
    assert(!/trước khi bạn/.test(fresh), 'up-to-date result marked old');
  });
  await check('"Tìm lại ngay" mirrors what a click can do', async () => {
    const label = async (key: string) => { const b = card(ux, key).locator('.pf-actions .btn-primary'); return (await b.count()) ? `${await b.innerText()}${(await b.isDisabled()) ? ' [disabled]' : ''}` : '(none)'; };
    const got = { queued: await label('queued'), running: await label('running'), recurring: await label('recurring'), paused: await label('paused') };
    assert(got.queued === '(none)', `queued: ${got.queued}`);
    assert(got.running === '(none)', `running: ${got.running}`);
    assert(got.recurring === 'Tìm lại ngay', `recurring: ${got.recurring}`);
    assert(got.paused === '(none)', `paused: ${got.paused}`);
    return JSON.stringify(got);
  });

  for (const [w, h] of [[1440, 900], [768, 1024], [390, 844]] as const) {
    await ux.setViewportSize({ width: w, height: h });
    await ux.waitForTimeout(300);
    await check(`no horizontal scroll at ${w}px`, async () => { assert(await noOverflow(ux), 'page overflows'); });
    await shot(ux, `states-${w}`);
    if (w === 390) for (const key of ['queued', 'running', 'results', 'none']) await card(ux, key).screenshot({ path: `${SHOTS}/card-${key}-390.png` });
  }
  await ux.setViewportSize({ width: 1440, height: 900 });
  for (const key of ['new', 'queued', 'running', 'results', 'none', 'failed', 'recurring', 'editedRunning', 'editedDone', 'paused']) await card(ux, key).screenshot({ path: `${SHOTS}/card-${key}.png` });

  await check('phrases stay available behind disclosure', async () => {
    const c = card(ux, 'recurring');
    await c.locator('.pf-phrases summary').click();
    assert(await c.locator('.keyword-chips li').first().isVisible(), 'phrases not shown after opening');
    await c.screenshot({ path: `${SHOTS}/card-recurring-phrases.png` });
    await c.locator('.pf-phrases summary').click();
  });

  await check('Tìm lại ngay: one request, then a calm waiting state; repeated clicks create nothing', async () => {
    const c = card(ux, 'recurring');
    const button = c.locator('.pf-actions .btn-primary');
    await button.click();
    await c.getByText('Đã nhận yêu cầu tìm lại').waitFor({ timeout: 10_000 });
    assert(await button.count() === 0, 'rescan still offered while a search waits');
    assert(await c.locator('.pf-steps li.is-current .pf-step-label').innerText() === 'Chờ bắt đầu', 'current step is not waiting');
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND kind = 'manual'", [P.recurring]);
    assert(n === 1, `${n} manual jobs`);
    await c.screenshot({ path: `${SHOTS}/flow-rescan-queued.png` });
    return 'exactly one manual request stored';
  });
  await check('a just-finished search of the same requirement explains the short wait', async () => {
    const c = card(ux, 'results');
    await c.locator('.pf-actions .btn-primary').click();
    await c.locator('.pf-note').waitFor({ timeout: 10_000 });
    const note = await c.locator('.pf-note').innerText();
    assert(/Vừa tìm xong với mô tả này/.test(note), note);
    const label = await c.locator('.pf-actions .btn-primary').innerText();
    assert(/Tìm lại sau \d+ phút/.test(label) && await c.locator('.pf-actions .btn-primary').isDisabled(), label);
    await c.screenshot({ path: `${SHOTS}/flow-cooldown.png` });
    return label;
  });
  await check('Tìm theo mô tả mới after an older result uses the latest saved requirement', async () => {
    const c = card(ux, 'editedDone');
    await c.getByRole('button', { name: 'Tìm theo mô tả mới' }).click();
    await c.getByText('Đã nhận yêu cầu tìm lại').waitFor({ timeout: 10_000 });
    const [j] = await q<{ v: number }>("SELECT configuration_version AS v FROM search_jobs WHERE search_profile_id = $1 AND status = 'pending'", [P.editedDone]);
    assert(j?.v === 2, `pending job version ${j?.v}`);
    assert(!/trước khi bạn/.test(await statusOf(ux, 'editedDone')), 'still marked old');
  });
  await check('Lưu và tìm lại: saved, requested, and using the new requirement', async () => {
    const c = card(ux, 'none');
    await c.getByRole('button', { name: 'Sửa' }).click();
    const form = ux.getByRole('form', { name: /Sửa Cửa hàng điện thoại/ });
    assert(/Sau khi lưu, QLead sẽ tìm lại theo mô tả mới/.test(await form.innerText()), 'form does not say what saving does');
    await form.locator('textarea').first().fill('Cửa hàng điện thoại, phụ kiện mới mở hoặc mở thêm chi nhánh cần máy in hóa đơn');
    await shot(ux, 'flow-edit-form', false);
    await form.getByRole('button', { name: 'Lưu và tìm lại' }).click();
    await c.locator('.pf-saved').waitFor({ timeout: 10_000 });
    await c.getByText('Đã nhận yêu cầu tìm lại').waitFor({ timeout: 10_000 });
    const [cfg] = await q<{ v: number }>('SELECT max(version)::int AS v FROM scan_configs WHERE agent_connection_id = $1', [P.none]);
    const [j] = await q<{ v: number }>("SELECT configuration_version AS v FROM search_jobs WHERE search_profile_id = $1 AND status = 'pending'", [P.none]);
    assert(j?.v === cfg.v, `job v${j?.v} vs saved v${cfg.v}`);
    assert(!/trước khi bạn/.test(await statusOf(ux, 'none')), 'new request marked old');
    await c.screenshot({ path: `${SHOTS}/flow-save-rescan.png` });
    return `job uses v${cfg.v}`;
  });
  await check('saving while a search runs says the change applies next time', async () => {
    const c = card(ux, 'running');
    await c.getByRole('button', { name: 'Sửa' }).click();
    const form = ux.getByRole('form', { name: /Sửa Tiệm bánh/ });
    assert(/Thay đổi của bạn sẽ được dùng từ lượt tìm sau/.test(await form.innerText()), 'no running note in form');
    await form.locator('textarea').first().fill('Tiệm bánh, tiệm trà sữa đang mở thêm chi nhánh mới ở TP.HCM');
    await form.getByRole('button', { name: 'Lưu và tìm lại' }).click();
    await c.locator('.pf-saved').waitFor({ timeout: 10_000 });
    await c.getByText('tiệm trà sữa đang mở thêm chi nhánh mới ở TP.HCM').waitFor({ timeout: 10_000 });
    await c.locator('.pf-status-fresh').waitFor({ timeout: 10_000 });
    const text = (await c.innerText()).replace(/\s+/g, ' ');
    assert(/Đang tìm khách hàng/.test(text) && /bắt đầu trước khi bạn lưu thay đổi gần nhất/.test(text), text);
    assert(/đã có một lượt tìm, QLead không tạo thêm/.test(text), 'no duplicate note');
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND status IN ('pending','claimed')", [P.running]);
    assert(n === 1, `${n} open jobs`);
    await c.screenshot({ path: `${SHOTS}/flow-save-while-running.png` });
  });
  await check('long descriptions are clamped with Xem thêm', async () => {
    const { page: cho } = await login('E2E Chờ', 390, 844);
    const c = card(cho, 'delayed');
    assert(await c.locator('.pf-desc.is-clamped').count() === 1, 'not clamped');
    assert(/chậm hơn thường lệ/.test(await statusOf(cho, 'delayed')), await statusOf(cho, 'delayed'));
    assert(/Chưa bật theo dõi.*Bật theo dõi/.test(await statusOf(cho, 'draft')), await statusOf(cho, 'draft'));
    const due = await statusOf(cho, 'due');
    assert(/Sắp đến lượt tìm|chậm hơn thường lệ|Lần tìm gần nhất/.test(due), due);
    assert(await noOverflow(cho), 'overflow at 390');
    await shot(cho, 'cho-390');
    await c.locator('.pf-more').click();
    assert(await c.locator('.pf-desc.is-clamped').count() === 0, 'did not expand');
    await c.screenshot({ path: `${SHOTS}/card-long-expanded-390.png` });
    await cho.setViewportSize({ width: 1440, height: 900 }); await shot(cho, 'cho-1440');
    return `due card: ${due.slice(0, 60)}`;
  });
  await check('admin-suspended account: no rescan, plain explanation, leads kept', async () => {
    const { page: ng } = await login('E2E Bị ngưng', 768, 1024);
    const c = card(ng, 'suspended');
    assert(/Tài khoản đang tạm ngưng tìm khách mới/.test(await statusOf(ng, 'suspended')), await statusOf(ng, 'suspended'));
    assert(await c.locator('.pf-actions .btn-primary').count() === 0, 'rescan offered');
    assert((await c.locator('.pf-leads').innerText()).includes('3 khách hàng'), 'leads link');
    await shot(ng, 'suspended-768');
  });
  await check('empty account shows a single clear first step', async () => {
    const { page: e } = await login('E2E Trống', 390, 844);
    assert(await e.getByRole('button', { name: 'Tạo nhu cầu đầu tiên' }).isVisible(), 'no CTA');
    await shot(e, 'empty-390');
  });
  await check('no page errors', async () => { assert(!pageErrors.length, pageErrors.join(' | ')); });
} finally {
  await browser.close();
  if (!process.env.KEEP_FIXTURES) await removeFixtures();
  await pool.end();
  writeFileSync(`${SHOTS}/../results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
