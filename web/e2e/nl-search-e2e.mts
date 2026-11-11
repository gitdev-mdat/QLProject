// Natural-language search, edit sync and manual re-scan E2E on the ISOLATED test database (never the live one).
// The worker is a synthetic test double driven in-process through the real Fastify worker API and wake endpoint
// (app.inject). No Muse, no Facebook: this verifies QLead's side of the contract, not a real Muse run.
// 1. Start the web app against the test DB exactly as described in profiles-e2e.mts (port 3005, same DEV users).
// 2. From the repo root: $env:DATABASE_URL=<test DB>; npx tsx web/e2e/nl-search-e2e.mts http://127.0.0.1:3005
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { planFromDescription } from '../../src/search-plan.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/nl-search-screenshots');
mkdirSync(SHOTS, { recursive: true });

const U = { lan: '00000000-0000-4000-8000-00000000e2a1', minh: '00000000-0000-4000-8000-00000000e2b1' };
const NAME = 'Quán F&B sắp khai trương';
const DUE_NAME = 'Routine due without inserted job';
const OLD_DESCRIPTION = 'Quán ăn sắp khai trương ở miền Nam';
const D1 = 'Các quán, nhà hàng F&B sắp khai trương hoặc tuyển dụng nhân viên cho quán sắp khai trương.';
const D2 = 'Khách sạn, homestay mới khai trương ở Đà Lạt';
const RUN = randomBytes(4).toString('hex');
const workerToken = randomBytes(32).toString('base64url');
const P = { lan: '', minh: '' };
let dueProfile = '';
let workerId = '';
let pausedWorkers: string[] = [];
let oldPost = '';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const auth = { authorization: `Bearer ${workerToken}` };
const worker = {
  wake: async () => (await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json(),
  claim: async () => (await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: P.lan } })).json().jobs as any[],
  submit: (job: any, slugs: string[]) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
    keywords_used: job.search.keywords, sources_used: job.search.sources, stats: { total_found: slugs.length + 10 }, errors: [],
    posts: slugs.map(slug => ({ url: `https://facebook.com/e2e-nl/${RUN}/${slug}`, author: `Trang ${slug}`, title: null, content: `Homestay ${slug} mới khai trương ở Đà Lạt, đang tuyển lễ tân.`, published_at: new Date(Date.now() - 3600_000).toISOString(), platform: 'facebook', collected_via: 'qlead_shared_worker' })) } }),
};

async function cleanup() {
  await q('DELETE FROM search_job_attempts WHERE job_id IN (SELECT j.id FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = ANY($1::uuid[]))', [Object.values(U)]);
  if (workerId) await q('DELETE FROM search_job_attempts WHERE worker_id = $1', [workerId]);
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  if (workerId) await q('DELETE FROM muse_workers WHERE id = $1', [workerId]);
  if (pausedWorkers.length) await q("UPDATE muse_workers SET status = 'active', status_changed_at = now() WHERE id = ANY($1::uuid[])", [pausedWorkers]);
}

async function seed() {
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  for (const [key, id] of Object.entries(U)) await q('INSERT INTO users(id, display_name) VALUES ($1, $2)', [id, `E2E ${key[0]!.toUpperCase()}${key.slice(1)}`]);
  // An existing profile saved before this change: customer-maintained phrases, a region, one lead with a note.
  P.lan = (await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [U.lan, NAME]))[0]!.id;
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at)
    VALUES ($1, 1, true, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 1440, $2, now() - interval '2 days')`, [P.lan, OLD_DESCRIPTION]);
  // Today's routine slot is already done, so only jobs this test creates exist for the profile.
  const [slotJob] = await q<{ id: string }>(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, status, completed_at, created_at)
    VALUES ($1, 1, $2, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), '["social.search"]', 'completed', now() - interval '3 hours', now() - interval '3 hours') RETURNING id`, [P.lan, `job-e2e-nl-${RUN}`]);
  await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status, search_job_id)
    VALUES ($1, $2, 1, now() - interval '3 hours', now() - interval '3 hours', 20, 1, 1, 0, 'success', $3)`, [P.lan, `job-e2e-nl-${RUN}`, slotJob!.id]);
  const url = `https://facebook.com/e2e-nl/${RUN}/old`;
  oldPost = (await q<{ id: string }>(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    VALUES ($1, $2, $2, 'Quán ăn Hương Quê sắp khai trương ở Thủ Đức.', 'E2E Trang', now() - interval '4 hours', now() - interval '3 hours', 'qlead_shared_worker') RETURNING id`, [P.lan, url]))[0]!.id;
  await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, 1)', [P.lan, url]);
  await q("INSERT INTO lead_notes(user_id, post_id, body) VALUES ($1, $2, 'E2E: đã gọi lần 1')", [U.lan, oldPost]);
  dueProfile = (await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [U.lan, DUE_NAME]))[0]!.id;
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, '["synthetic recurring search"]', '', '["social.search"]', 2, 'Synthetic due schedule')`, [dueProfile]);
  const [oldDueJob] = await q<{ id: string }>(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind, status, completed_at)
    VALUES ($1, 1, $2, now() - interval '3 minutes', '["social.search"]', 'initial', 'completed', now() - interval '3 minutes') RETURNING id`, [dueProfile, `job-e2e-due-${RUN}`]);
  await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped, status, search_job_id)
    VALUES ($1, $2, 1, now() - interval '3 minutes', 0, 0, 0, 0, 'success', $3)`, [dueProfile, `job-e2e-due-${RUN}`, oldDueJob!.id]);
  P.minh = (await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Đại lý mỹ phẩm Hà Nội', 'search_profile') RETURNING id", [U.minh]))[0]!.id;
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description)
    VALUES ($1, 1, false, '["đại lý mỹ phẩm tuyển"]', 'Hà Nội', '["social.search"]', 1440, 'Đại lý mỹ phẩm ở Hà Nội')`, [P.minh]);
  // The wake signal needs exactly one active worker: park other TEST-DB workers for the run and restore them after.
  pausedWorkers = (await q<{ id: string }>("UPDATE muse_workers SET status = 'paused', status_changed_at = now() WHERE status = 'active' RETURNING id")).map(row => row.id);
  workerId = (await q<{ id: string }>("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes) VALUES ($1, $2, 'active', 30) RETURNING id", [`E2E NL ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]))[0]!.id;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 1000, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  return { context, page };
}
const card = (p: Page) => p.locator('.profile-card').first();
const shot = (p: Page, name: string, fullPage = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial' });
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const call = (p: Page, url: string, method: string, body?: unknown) => p.evaluate(async ([u, m, b]) => {
  const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [url, method, body] as const);
const latest = async () => (await q<any>('SELECT version, keywords, keywords_source, location, description FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [P.lan]))[0];
const openJobs = () => q<any>("SELECT id, kind, configuration_version, status FROM search_jobs WHERE search_profile_id = $1 AND status IN ('pending', 'claimed', 'blocked')", [P.lan]);

try {
  await seed();
  const lan = await login('E2E Lan');
  const pa = lan.page;
  let job: any;

  await check('1-4 edit only the description; save without keywords; it persists after reload', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await card(pa).getByRole('button', { name: 'Sửa' }).click();
    const form = pa.locator('.profile-form');
    assert(await form.getByRole('heading', { name: 'Sửa nhu cầu tìm kiếm' }).isVisible(), 'form title');
    assert(!(await form.getByLabel('Cụm tìm kiếm riêng').isVisible().catch(() => false)), 'manual keyword field is not part of the normal form');
    await form.getByLabel('Bạn kinh doanh gì và muốn tìm khách hàng nào?').fill(D1);
    const chips = await form.locator('.search-preview .keyword-chips li').allInnerTexts();
    assert(JSON.stringify(chips) === JSON.stringify(planFromDescription(D1).queries), `preview ${chips.join('|')}`);
    assert(await form.getByText(/QLead tạo lại cụm tìm kiếm từ mô tả mới/).isVisible(), 'old manual phrases are replaced visibly, not silently kept');
    assert((await form.getByLabel('Khu vực', { exact: true }).inputValue()) === '', 'no hidden Miền Nam once the description no longer names it');
    assert(await form.getByText(/Gợi ý theo mô tả mới/).isVisible(), 'a better name is offered for the changed description');
    await shot(pa, 'edit-form-1440');
    await pa.route('**/api/profiles/*', async route => { await new Promise(r => setTimeout(r, 700)); await route.continue(); });
    await form.getByRole('button', { name: 'Lưu thay đổi' }).click();
    assert(await form.getByRole('button', { name: 'Đang lưu thay đổi…' }).isVisible(), 'saving state while persisting');
    await card(pa).locator('.saved-line', { hasText: 'Đã cập nhật nhu cầu tìm kiếm.' }).waitFor();
    await pa.unroute('**/api/profiles/*');
    await shot(pa, 'saved-1440');
    await pa.reload();
    assert((await card(pa).locator('.profile-description').innerText()).includes(D1), 'description after reload');
    const v = await latest();
    assert(v.version === 2 && v.keywords_source === 'description' && v.location === '' && v.description === D1, JSON.stringify(v));
    assert(JSON.stringify(v.keywords) === JSON.stringify(planFromDescription(D1).queries), 'stored phrases = generated from the new description');
    assert((await openJobs()).length === 0, '"Lưu thay đổi" does not request a scan');
    return `v2: ${v.keywords.length} generated phrases, location unrestricted`;
  });

  await check('8-12 a different category + "Lưu và tìm lại" queues exactly one job on the new version', async () => {
    await card(pa).getByRole('button', { name: 'Sửa' }).click();
    const form = pa.locator('.profile-form');
    await form.getByLabel('Bạn kinh doanh gì và muốn tìm khách hàng nào?').fill(D2);
    assert((await form.getByLabel('Khu vực', { exact: true }).inputValue()) === 'Đà Lạt', 'explicit place becomes the area');
    await form.getByRole('button', { name: 'Dùng tên này' }).click();
    assert((await form.getByLabel('Tên nhu cầu').inputValue()) === planFromDescription(D2).name, 'name follows the new intent when the customer accepts it');
    await form.getByRole('button', { name: 'Lưu và tìm lại' }).click();
    await card(pa).locator('.scan-progress.is-queued').waitFor();
    assert(await card(pa).getByText('Đã thêm lượt tìm mới vào hàng chờ.').first().isVisible(), 'queued copy');
    const v = await latest();
    assert(v.version === 3 && JSON.stringify(v.keywords) === JSON.stringify(planFromDescription(D2).queries) && v.location === 'Đà Lạt', JSON.stringify(v));
    const jobs = await openJobs();
    assert(jobs.length === 1 && jobs[0].kind === 'manual' && jobs[0].configuration_version === 3 && jobs[0].status === 'pending', JSON.stringify(jobs));
    assert(!(await pa.locator('body').innerText()).match(/Muse|worker/i), 'internal wording leaked');
    await shot(pa, 'queued-1440');
    await pa.reload();
    await card(pa).locator('.scan-progress.is-queued').waitFor();
    return 'v3, one manual job; queued state survives reload';
  });

  await check('13 the wake signal reports the new eligible job', async () => {
    const signal = await worker.wake();
    assert(signal.wake === true && /^[a-f0-9]{64}$/.test(signal.generation), JSON.stringify(signal));
    return 'wake:true';
  });

  await check('6-7 14-15 claimed payload carries the latest intent; UI moves from queued to running', async () => {
    const claimed = await worker.claim();
    assert(claimed.length === 1, `claimed ${claimed.length}`);
    job = claimed[0];
    assert(job.configuration_version === 3, `version ${job.configuration_version}`);
    assert(JSON.stringify(job.search.intent) === JSON.stringify({ description: D2, keywords_source: 'description' }), JSON.stringify(job.search.intent));
    assert(JSON.stringify(job.search.keywords) === JSON.stringify(planFromDescription(D2).queries), job.search.keywords.join('|'));
    assert(!job.search.keywords.includes('quán ăn sắp khai trương'), 'old manual keyword cannot override');
    assert((await worker.wake()).wake === false, 'no wake while the job is running');
    await card(pa).locator('.scan-progress.is-running').waitFor({ timeout: 12_000 });
    assert(await card(pa).getByText('QLead đã nhận lượt tìm và đang xử lý.').isVisible(), 'running copy');
    await pa.waitForTimeout(1500); // let the animated goat load before measuring the compact panel
    const height = (await card(pa).locator('.scan-progress').boundingBox())?.height ?? 0;
    assert(height > 60 && height < 260, `progress panel height ${height}`);
    await shot(pa, 'running-1440');
    return `${job.search.keywords.join(', ')} · ${job.search.location}`;
  });

  await check('16-17 a result under the job version shows completed state and lead provenance', async () => {
    const ack = await worker.submit(job, ['a', 'b']);
    assert(ack.statusCode === 200, ack.body);
    await card(pa).locator('.scan-progress.is-results').waitFor({ timeout: 12_000 });
    assert(await card(pa).getByText('Đã tìm thấy cơ hội phù hợp.').isVisible(), 'results copy');
    assert(await card(pa).getByText('2 bài mới trong 12 bài QLead đã xem.').isVisible(), 'real counts');
    const rows = await q<any>('SELECT configuration_version FROM facebook_post_search_configs WHERE agent_connection_id = $1 AND normalized_url LIKE $2', [P.lan, `%/${RUN}/_`]);
    assert(rows.length === 2 && rows.every(r => r.configuration_version === 3), JSON.stringify(rows));
    await shot(pa, 'results-1440');
    await card(pa).locator('.scan-progress').getByRole('link', { name: /Xem lead/ }).click();
    await pa.waitForURL(/nhu-cau=/);
    await pa.locator('.lead-table').waitFor();
    assert(await pa.locator('.lead-table tbody tr', { hasText: 'Trang a' }).count() === 1, 'new lead listed');
    return '2 leads attributed to v3';
  });

  await check('18-20 "Tìm lại ngay" reuses the saved config; cooldown and duplicate clicks create no extra work', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await card(pa).getByRole('button', { name: 'Tìm lại ngay' }).click();
    await card(pa).locator('.warning-line', { hasText: 'vừa được tìm xong' }).waitFor();
    assert((await openJobs()).length === 0, 'cooldown queued nothing');
    await shot(pa, 'cooldown-1440');
    // Move the finished scan 20 minutes into the past instead of waiting out the cooldown.
    await q("UPDATE search_jobs SET completed_at = now() - interval '20 minutes' WHERE id = $1", [job.job_id]);
    const responses = await Promise.all([1, 2, 3].map(() => call(pa, `/api/profiles/${P.lan}/scan`, 'POST')));
    const outcomes = responses.map(r => r.body?.scan?.outcome).sort();
    assert(JSON.stringify(outcomes) === JSON.stringify(['existing', 'existing', 'queued']), outcomes.join(','));
    const jobs = await openJobs();
    assert(jobs.length === 1 && jobs[0].configuration_version === 3 && jobs[0].kind === 'manual', JSON.stringify(jobs));
    await pa.reload();
    assert(await card(pa).getByRole('button', { name: 'Tìm lại ngay' }).isDisabled(), 'button disabled while a scan is open');
    return '3 concurrent clicks → 1 job on v3';
  });

  await check('zero-result completion shows an honest outcome with a refine action', async () => {
    const [next] = await worker.claim();
    assert(next?.configuration_version === 3, 'current config reused');
    assert((await worker.submit(next, [])).statusCode === 200, 'ack');
    await card(pa).locator('.scan-progress.is-no_results').waitFor({ timeout: 12_000 });
    assert(await card(pa).getByText('Đã hoàn tất lượt tìm, chưa có bài phù hợp.').isVisible(), 'no-results copy');
    assert(await card(pa).getByRole('button', { name: 'Chỉnh mô tả' }).isVisible(), 'refine action');
    await shot(pa, 'no-results-1440');
  });

  await check('a due recurring slot without a materialized job waits truthfully for execution', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    const dueCard = pa.locator('.profile-card').filter({ hasText: DUE_NAME });
    assert(await dueCard.locator('.profile-state').innerText() === 'Đến lịch · chờ xử lý', 'due but unqueued state is missing or misleading');
    assert((await dueCard.innerText()).includes('đang chờ hệ thống nhận việc'), 'customer explanation missing');
    assert(!(await dueCard.innerText()).includes('Đang tìm kiếm'), 'unclaimed recurring work is shown as running');
    await shot(pa, 'recurring-due-waiting-1440');
  });

  await check('21 historical versions, leads and notes are preserved', async () => {
    const [counts] = await q<any>(`SELECT (SELECT count(*)::int FROM scan_configs WHERE agent_connection_id = $1) AS versions,
      (SELECT configuration_version FROM facebook_post_search_configs WHERE agent_connection_id = $1 AND normalized_url LIKE '%/old') AS old_version,
      (SELECT count(*)::int FROM lead_notes WHERE post_id = $2) AS notes`, [P.lan, oldPost]);
    assert(counts.versions === 3 && counts.old_version === 1 && counts.notes === 1, JSON.stringify(counts));
    await pa.goto(`${BASE}/app/bai-viet/${oldPost}`);
    const text = await pa.locator('.lead-provenance').innerText();
    assert(text.includes('quán ăn sắp khai trương · Miền Nam'), text);
    return 'old lead still shows its v1 conditions';
  });

  await check('stale edit from an outdated form is refused; an identical retry succeeds', async () => {
    const profile = { name: 'Khách sạn mới', description: 'Nhà thuốc sắp khai trương', location: '', frequency_minutes: 1440 };
    const stale = await call(pa, `/api/profiles/${P.lan}`, 'PATCH', { profile, base_version: 1 });
    assert(stale.status === 409 && stale.body?.error === 'stale', JSON.stringify(stale));
    const same = { name: (await q<any>('SELECT name FROM agent_connections WHERE id = $1', [P.lan]))[0].name, description: D2, location: 'Đà Lạt', frequency_minutes: 1440 };
    const retry = await call(pa, `/api/profiles/${P.lan}`, 'PATCH', { profile: same, base_version: 2 });
    assert(retry.status === 200 && retry.body?.version === 3, JSON.stringify(retry));
    return '409 stale, retry is a no-op';
  });

  await check('reduced motion: progress animations are disabled', async () => {
    const reduced = await login('E2E Lan', 1440, 1000, 'reduce');
    await reduced.page.goto(`${BASE}/app/bo-loc`);
    const animation = await card(reduced.page).locator('.scan-progress').evaluate(el => getComputedStyle(el).animationName);
    assert(animation === 'none', `scan-progress animation ${animation}`);
    await reduced.context.close();
  });

  for (const [w, h] of [[768, 1024], [390, 844]] as const) {
    await check(`23 responsive ${w}px: card, progress and edit form`, async () => {
      await pa.setViewportSize({ width: w, height: h });
      await pa.goto(`${BASE}/app/bo-loc`); await pa.waitForLoadState('networkidle');
      assert(await noOverflow(pa), `card overflows at ${w}`);
      await shot(pa, `profiles-${w}`);
      await card(pa).getByRole('button', { name: 'Sửa' }).click();
      assert(await noOverflow(pa), `form overflows at ${w}`);
      await shot(pa, `edit-form-${w}`);
    });
  }
  await pa.setViewportSize({ width: 1440, height: 1000 });
  await lan.context.close();

  const minh = await login('E2E Minh');
  await check('22 User B cannot update, search or read User A’s profile', async () => {
    const p = minh.page;
    const edit = await call(p, `/api/profiles/${P.lan}`, 'PATCH', { profile: { name: 'Hijack', description: 'Hijack attempt description', location: '', frequency_minutes: 1440 }, rescan: true });
    const scan = await call(p, `/api/profiles/${P.lan}/scan`, 'POST');
    const read = await call(p, `/api/profiles/${P.lan}/scan`, 'GET');
    assert(edit.status === 404 && scan.status === 404 && read.status === 404, `${edit.status}/${scan.status}/${read.status}`);
    const v = await latest();
    assert(v.version === 3 && v.description === D2 && (await openJobs()).length === 0, 'A unchanged');
    await p.goto(`${BASE}/app/bo-loc`);
    assert(!(await p.locator('body').innerText()).includes('homestay'), 'A profile not visible');
    assert(!(await p.getByRole('button', { name: 'Tìm lại ngay' }).count()), 'paused profile offers no re-scan');
    return '404 ×3';
  });
  await minh.context.close();

  await check('No browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
} finally {
  await cleanup().catch(error => console.error('cleanup failed', error));
  await browser.close();
  await app.close();
  await pool.end();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed, ${results.length - passed} failed`;
  console.log(summary);
  writeFileSync(resolve(SHOTS, 'results.json'), JSON.stringify({ summary, results }, null, 2));
}
