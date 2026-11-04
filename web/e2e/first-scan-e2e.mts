// First-scan E2E on the ISOLATED test database. Real accounts are registered through the UI; the worker is a
// synthetic one driven in-process through the real Fastify worker API (app.inject). No Muse, no Facebook.
// 1. Start the web app against the test DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; $env:QLEAD_DIST_DIR='.next-profiles-e2e'
//    npm run dev -- -p 3005
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/first-scan-e2e.mts http://127.0.0.1:3005
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/first-scan-screenshots');
mkdirSync(SHOTS, { recursive: true });

const RUN = randomBytes(4).toString('hex');
const email = (tag: string) => `e2e-first-${RUN}-${tag}@qlead.test`;
const PASSWORD = `E2e-${randomBytes(6).toString('hex')}`;
const workerToken = randomBytes(32).toString('base64url');
const OTHER = '00000000-0000-4000-8000-00000000f5a1';
let workerId = '';
let otherProfile = '';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const worker = {
  claim: async (max = 1) => (await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${workerToken}` }, payload: { max_jobs: max } })).json().jobs as any[],
  submit: (j: any, posts: Array<{ slug: string; content: string }>, totalFound: number) => app.inject({ method: 'POST', url: `/api/worker/jobs/${j.job_id}/results`, headers: { authorization: `Bearer ${workerToken}` }, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: j.configuration_version, scan_id: j.scan_id, scanned_at: new Date().toISOString(),
    posts: posts.map(p => ({ url: `https://facebook.com/e2e-first/${RUN}/${p.slug}`, content: p.content, author: `Trang ${p.slug}`, published_at: new Date(Date.now() - 2 * 3600_000).toISOString(), platform: 'facebook', collected_via: 'qlead_shared_worker' })),
    stats: { total_found: totalFound }, errors: [] } }),
  fail: (j: any) => app.inject({ method: 'POST', url: `/api/worker/jobs/${j.job_id}/failure`, headers: { authorization: `Bearer ${workerToken}` }, payload: { scan_id: j.scan_id, code: 'execution_error', message: 'e2e', retryable: false } }),
};
// Counts every confetti burst mounted in the page, so replays across polling, rerenders and refreshes are visible.
const COUNT_CONFETTI = () => {
  const w = window as unknown as { __confetti: number };
  w.__confetti = 0;
  new MutationObserver(records => { for (const r of records) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains('first-scan-confetti')) w.__confetti++; }); })
    .observe(document, { childList: true, subtree: true });
};
const confettiCount = (p: Page) => p.evaluate(() => (window as unknown as { __confetti: number }).__confetti);
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function cleanup() {
  const own = await q<{ user_id: string }>('SELECT user_id FROM user_accounts WHERE email LIKE $1', [`e2e-first-${RUN}-%@qlead.test`]);
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[OTHER, ...own.map(row => row.user_id)]]);
  await q('DELETE FROM search_job_attempts WHERE worker_id IN (SELECT id FROM muse_workers WHERE name = $1)', [`E2E First ${RUN}`]);
  await q('DELETE FROM muse_workers WHERE name = $1', [`E2E First ${RUN}`]);
}
async function seed() {
  // Make the test queue deterministic: earlier fixtures' jobs must not be claimed by this synthetic worker.
  await q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");
  workerId = (await q<{ id: string }>("INSERT INTO muse_workers(name, credential_hash, status, lease_minutes) VALUES ($1, $2, 'active', 30) RETURNING id", [`E2E First ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]))[0].id;
  // A routine job is older but still inside the bounded initial-job priority window.
  await q("INSERT INTO users(id, display_name) VALUES ($1, 'E2E Other')", [OTHER]);
  otherProfile = (await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Routine', 'search_profile') RETURNING id", [OTHER]))[0].id;
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes) VALUES ($1, 1, true, '["quán nhậu sắp khai trương"]', 'Cần Thơ', '["social.search"]', 30)`, [otherProfile]);
  await q("INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, $2, 1, now() - interval '2 days', 1, 0, 0, 0)", [otherProfile, `e2e-first-${RUN}-old`]);
  await q("INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources) VALUES ($1, 1, $2, now() - interval '10 minutes', '[\"social.search\"]')", [otherProfile, `job-e2e-first-${RUN}`]);
}

const consoleErrors: string[] = [];
async function fresh(browser: Browser, width = 1440, height = 1000): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return { context, page };
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
async function onboard(p: Page, tag: string, description: string, keyword: string, location = 'TP.HCM') {
  await p.goto(`${BASE}/dang-ky`);
  await p.getByLabel('Tên của bạn').fill(`E2E ${tag}`);
  await p.getByLabel('Email công việc').fill(email(tag));
  await p.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await p.waitForURL(`${BASE}/bat-dau`);
  await p.getByRole('button', { name: /Ngành khác/ }).click();
  await p.getByLabel('Mô tả khách hàng bạn muốn tìm').fill(description);
  await p.getByRole('button', { name: /Tiếp tục/ }).click();
  // Search phrases come from the description now; the customer only reviews them.
  const phrases = await p.locator('.search-preview .keyword-chips li').allInnerTexts();
  if (!phrases.some(phrase => phrase.includes(keyword.split(' ')[0]!))) throw new Error(`preview ${phrases.join('|')} lacks ${keyword}`);
  await p.getByLabel('Khu vực', { exact: true }).selectOption(location);
  await p.getByRole('button', { name: /Tiếp tục/ }).click();
  await p.getByRole('button', { name: /Lưu và vào QLead/ }).click();
  await p.waitForURL(`${BASE}/app/lan-tim-dau`);
  const [row] = await q<{ user_id: string; profile: string }>("SELECT ua.user_id, ac.id AS profile FROM user_accounts ua JOIN agent_connections ac ON ac.user_id = ua.user_id WHERE ua.email = $1", [email(tag)]);
  return row;
}
const title = (p: Page) => p.locator('#first-scan-title').innerText();
async function waitTitle(p: Page, text: string) { await p.locator('#first-scan-title', { hasText: text }).waitFor({ timeout: 20000 }); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await seed();
  const one = await fresh(browser);
  let u1 = { user_id: '', profile: '' };
  let job1: any;

  await check('A1 onboarding saves the profile and queues exactly one initial job', async () => {
    u1 = await onboard(one.page, 'one', 'Tôi bán máy pha cà phê, muốn tìm quán cafe sắp khai trương ở TP.HCM', 'quán cafe sắp khai trương');
    const jobs = await q<{ kind: string; status: string; configuration_version: number }>('SELECT kind, status, configuration_version FROM search_jobs WHERE search_profile_id = $1', [u1.profile]);
    assert(jobs.length === 1 && jobs[0].kind === 'initial' && jobs[0].status === 'pending' && jobs[0].configuration_version === 1, JSON.stringify(jobs));
    return `profile ${u1.profile.slice(0, 8)}`;
  });

  await check('A2 queued state is shown honestly and survives refresh', async () => {
    const p = one.page;
    assert(await title(p) === 'Đang chờ bắt đầu lượt tìm đầu tiên', await title(p));
    const text = await p.locator('body').innerText();
    assert(!text.includes('đang tìm bài đăng phù hợp') && !/\d+%/.test(text), 'claims searching or shows a percentage');
    assert(await p.locator('.discovery-card').count() === 0, 'active-search animation while waiting');
    assert(!/Muse|worker/i.test(text), 'internal wording');
    assert(await p.locator('.first-scan-estimate').isVisible() && text.includes('2–3 phút') && text.includes('rời trang'), 'expected duration or leave-page note missing');
    assert(await p.locator('.first-scan').getAttribute('data-phase') === 'queued', 'queued phase');
    await shot(p, 'waiting-1440');
    await p.reload();
    assert(await title(p) === 'Đang chờ bắt đầu lượt tìm đầu tiên', 'state lost on refresh');
    await p.goto(`${BASE}/app`);
    assert(await p.locator('.first-scan').count() === 1 && await p.locator('.summary-row').count() === 0, 'Today does not lead with first scan');
    await shot(p, 'today-first-run-1440');
  });

  await check('B worker claims the initial job before an older routine job; UI shows real searching', async () => {
    const claimed = await worker.claim(1);
    assert(claimed.length === 1, `claimed ${claimed.length}`);
    const [owner] = await q<{ search_profile_id: string }>('SELECT search_profile_id FROM search_jobs WHERE id = $1', [claimed[0].job_id]);
    assert(owner.search_profile_id === u1.profile, 'the initial job should receive its bounded priority');
    job1 = claimed[0];
    const p = one.page;
    await p.goto(`${BASE}/app/lan-tim-dau`);
    await waitTitle(p, 'QLead đang tìm bài đăng phù hợp');
    assert(await p.locator('.discovery-card').count() === 3, 'no active-search visual');
    assert(!/\d+%/.test(await p.locator('body').innerText()), 'percentage shown');
    assert((await p.locator('.first-scan-estimate').innerText()).includes('Lượt tìm đầu tiên có thể mất khoảng 2–3 phút.'), '2–3 minute message');
    const panel = await p.locator('.first-scan-profile').innerText();
    for (const part of ['Nhu cầu', 'Bạn đã mô tả', 'Tìm theo', 'Bắt đầu lúc', 'Sau lượt đầu', 'máy pha cà phê']) assert(panel.includes(part), `requirement panel lacks ${part}`);
    await shot(p, 'running-1440');
  });

  await check('B2 a search running past the estimate says it is slower, not failed', async () => {
    const p = one.page;
    await q("UPDATE search_job_attempts SET claimed_at = now() - interval '5 minutes' WHERE job_id = $1", [job1.job_id]);
    await p.reload();
    await p.locator('.first-scan[data-phase="running_long"]').waitFor({ timeout: 10000 });
    assert(await title(p) === 'QLead đang tìm bài đăng phù hợp', await title(p));
    const estimate = await p.locator('.first-scan-estimate.is-slow').innerText();
    assert(estimate.includes('lâu hơn') && !/lỗi|thất bại/i.test(estimate), estimate);
    await shot(p, 'running-long-1440');
    await q("UPDATE search_job_attempts SET claimed_at = now() WHERE job_id = $1", [job1.job_id]);
  });

  await check('C results appear without reload as a completion screen with real counts and one confetti burst', async () => {
    const p = one.page;
    await one.context.addInitScript(COUNT_CONFETTI);
    await p.goto(`${BASE}/app/lan-tim-dau`);
    await waitTitle(p, 'QLead đang tìm bài đăng phù hợp');
    const ack = await worker.submit(job1, [
      { slug: 'may', content: 'Quán cafe Mây sắp khai trương ở Quận 3, đang tuyển nhân viên pha chế.' },
      { slug: 'go', content: 'Cần tư vấn máy pha cà phê cho quán mới mở ở Bình Thạnh, liên hệ 0901 234 567.' },
    ], 18);
    assert(ack.statusCode === 200, `submit ${ack.statusCode} ${ack.body}`);
    await waitTitle(p, 'QLead đã thấy khách hàng');
    await p.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 3000 });
    await shot(p, 'results-confetti-1440');
    assert(await p.locator('.first-leads, .first-lead-head').count() === 0, 'lead cards still on the completion screen');
    assert(!(await p.locator('body').innerText()).includes('Quán cafe Mây'), 'lead content on the completion screen');
    const stats = (await p.locator('.first-scan-stats').innerText()).replace(/\s+/g, ' ');
    assert(stats.includes('Đã xem 18 bài đăng') && stats.includes('Tìm thấy 2 lead mới'), stats);
    // Completion time is the stored scan_runs.scanned_at in Vietnam time, right under the heading; no requirement line here.
    const stamp = (await p.locator('.first-scan-finished-at').innerText()).replace(/\s+/g, ' ').trim();
    const [run] = await q<{ scanned_at: Date }>('SELECT scanned_at FROM scan_runs WHERE agent_connection_id = $1 ORDER BY scanned_at LIMIT 1', [u1.profile]);
    const expected = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }).format(run.scanned_at);
    assert(stamp === `Hoàn tất lúc ${expected}` && /^Hoàn tất lúc \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/.test(stamp), `stamp "${stamp}" expected ${expected}`);
    const order = await p.evaluate(() => [...document.querySelectorAll('.first-scan-copy > *')].map(el => el.id || el.className));
    assert(order.join('|') === 'first-scan-title|first-scan-finished-at|first-scan-lead', order.join('|'));
    assert(await p.locator('.first-scan-facts').count() === 0, 'requirement line on the success screen');
    assert((await p.locator('.first-scan-lead').innerText()) === 'QLead đã hoàn thành lượt tìm đầu tiên và tìm thấy những cơ hội phù hợp với nhu cầu của bạn.', 'description');
    assert(await p.getByRole('link', { name: /Xem danh sách lead/ }).getAttribute('href') === `/app/bai-viet?nhu-cau=${u1.profile}`, 'CTA');
    assert(await p.getByRole('link', { name: 'Tiếp tục theo dõi' }).getAttribute('href') === '/app/bo-loc', 'secondary CTA');
    const assoc = await q<{ n: number }>('SELECT count(*)::int AS n FROM facebook_post_search_configs WHERE agent_connection_id = $1 AND configuration_version = 1', [u1.profile]);
    assert(assoc[0].n === 2, 'association');
    // The burst is brief and removes itself; further responses and rerenders must not replay it.
    await p.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 4000 });
    await pause(6000);
    assert(await confettiCount(p) === 1, `confetti bursts ${await confettiCount(p)}`);
    await shot(p, 'results-1440');
    await worker.claim(2);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND status <> 'cancelled'", [u1.profile]);
    assert(n === 1, `extra job in the same slot: ${n}`);
    return '2 new leads, 1 burst, no duplicate slot job';
  });

  await check('C2 refresh keeps the backend state and does not replay the celebration', async () => {
    const p = one.page;
    await p.reload();
    await waitTitle(p, 'QLead đã thấy khách hàng');
    await pause(2500);
    assert(await confettiCount(p) === 0, `confetti replayed after refresh: ${await confettiCount(p)}`);
  });

  await check('C3 "Xem danh sách lead" opens the existing lead list for this search without starting a scan', async () => {
    const p = one.page;
    const before = await q<{ n: number }>('SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1', [u1.profile]);
    await p.getByRole('link', { name: /Xem danh sách lead/ }).click();
    await p.waitForURL(`${BASE}/app/bai-viet?nhu-cau=${u1.profile}`);
    await p.getByText('Quán cafe Mây', { exact: false }).first().waitFor({ timeout: 15000 });
    const after = await q<{ n: number }>('SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1', [u1.profile]);
    assert(before[0].n === after[0].n, `jobs ${before[0].n} -> ${after[0].n}`);
    await p.goto(`${BASE}/app`);
    assert(await p.locator('.first-scan').count() === 0 && await p.locator('.summary-row').count() === 1, 'normal dashboard after first scan');
  });

  const two = await fresh(browser);
  await check('D empty successful scan shows the no-result state; monitoring stays on', async () => {
    const u2 = await onboard(two.page, 'two', 'Tôi bán nội thất, muốn tìm spa sắp khai trương ở Hà Nội', 'spa sắp khai trương', 'Hà Nội');
    const [job] = await worker.claim(1);
    const [owner] = await q<{ search_profile_id: string }>('SELECT search_profile_id FROM search_jobs WHERE id = $1', [job.job_id]);
    assert(owner.search_profile_id === u2.profile, 'wrong job');
    await two.context.addInitScript(COUNT_CONFETTI);
    assert((await worker.submit(job, [], 7)).statusCode === 200, 'submit');
    await two.page.reload();
    await waitTitle(two.page, 'Đã hoàn tất lượt tìm đầu tiên');
    const text = await two.page.locator('body').innerText();
    assert(text.includes('Chưa tìm thấy bài đăng phù hợp với nhu cầu hiện tại. QLead sẽ tiếp tục theo dõi theo lịch.'), 'empty copy');
    assert(!text.includes('đã thấy khách hàng') && !text.includes('đã tìm thấy lead') && !text.includes('lead mới cho') && !/Tìm thấy \d+ lead mới/.test(text), 'claims leads');
    const stats = (await two.page.locator('.first-scan-stats').innerText()).replace(/\s+/g, ' ');
    assert(stats.includes('Đã xem 7 bài đăng') && stats.includes('Chưa có lead mới'), stats);
    assert(await two.page.getByRole('link', { name: 'Chỉnh nhu cầu' }).isVisible(), 'edit action');
    await pause(2000);
    assert(await confettiCount(two.page) === 0, 'confetti without new leads');
    const [cfg] = await q<{ enabled: boolean }>('SELECT enabled FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [u2.profile]);
    assert(cfg.enabled, 'monitoring turned off');
    await shot(two.page, 'no-results-1440');
  });

  const three = await fresh(browser);
  let u3 = { user_id: '', profile: '' };
  await check('E unclaimed job: delayed, never "searching"', async () => {
    u3 = await onboard(three.page, 'three', 'Tôi bán phần mềm khách sạn, muốn tìm homestay sắp mở ở Đà Lạt', 'homestay sắp khai trương');
    await q("UPDATE search_jobs SET created_at = now() - interval '2 hours' WHERE search_profile_id = $1", [u3.profile]);
    await three.page.reload();
    await waitTitle(three.page, 'Việc tìm kiếm đang chậm hơn dự kiến');
    assert(await three.page.locator('.discovery-card').count() === 0, 'active-search visual while delayed');
    assert(!(await three.page.locator('body').innerText()).includes('đang tìm bài đăng phù hợp'), 'claims searching');
    await shot(three.page, 'delayed-1440');
  });

  await check('I pausing before the first scan cancels it and shows the paused state', async () => {
    const status = await three.page.evaluate(async id => (await fetch(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) })).status, u3.profile);
    assert(status === 200, `pause ${status}`);
    await three.page.reload();
    await waitTitle(three.page, 'Đã tạm dừng theo dõi');
    assert(await three.page.locator('.first-scan-indeterminate').count() === 0, 'waiting animation while paused');
    const [job] = await q<{ status: string }>("SELECT status FROM search_jobs WHERE search_profile_id = $1 AND kind = 'initial'", [u3.profile]);
    assert(job.status === 'cancelled', job.status);
    const resume = await three.page.evaluate(async id => (await fetch(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) })).status, u3.profile);
    const live = await q<{ n: number }>("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND kind = 'initial' AND status = 'pending'", [u3.profile]);
    assert(resume === 200 && live[0].n === 1, `resume ${resume}, live initial ${live[0].n}`);
  });

  await check('F tenants never see each other\'s jobs, scans or results', async () => {
    const own = await three.page.evaluate(async () => (await (await fetch('/api/first-scan')).json()).scan);
    assert(own.profile.id === u3.profile && !('leads' in own), 'first-scan API scoped');
    const [lead] = await q<{ id: string }>('SELECT id FROM facebook_posts WHERE agent_connection_id = $1 LIMIT 1', [u1.profile]);
    // A first navigation can be aborted by the dev server compiling the route; retry once.
    await three.page.goto(`${BASE}/app/bai-viet/${lead.id}`).catch(() => three.page.goto(`${BASE}/app/bai-viet/${lead.id}`));
    await three.page.getByRole('heading', { name: 'Không tìm thấy lead' }).waitFor();
    await three.page.goto(`${BASE}/app`);
    const text = await three.page.locator('body').innerText();
    assert(!text.includes('Quán cafe Mây') && !text.includes('Routine'), 'foreign data on Today');
    const anon = await fetch(`${BASE}/api/first-scan`);
    assert(anon.status === 401, `anonymous ${anon.status}`);
  });

  const four = await fresh(browser);
  await check('H failed first scan: honest failure, no celebration', async () => {
    await four.context.addInitScript(COUNT_CONFETTI);
    const u4 = await onboard(four.page, 'four', 'Tôi bán máy in, muốn tìm cửa hàng in ấn sắp mở ở TP.HCM', 'cửa hàng sắp khai trương');
    // Keep user three's resumed job queued so it stays the "waiting" fixture below.
    await q("UPDATE search_jobs SET scheduled_for = now() + interval '1 day' WHERE search_profile_id = $1 AND status = 'pending'", [u3.profile]);
    const [job] = await worker.claim(1);
    await q("UPDATE search_jobs SET scheduled_for = now() WHERE search_profile_id = $1 AND status = 'pending'", [u3.profile]);
    const [owner] = await q<{ search_profile_id: string }>('SELECT search_profile_id FROM search_jobs WHERE id = $1', [job.job_id]);
    assert(owner.search_profile_id === u4.profile, 'wrong job');
    const failed = await worker.fail(job);
    assert(failed.statusCode === 200, `fail ${failed.statusCode} ${failed.body}`);
    await four.page.reload();
    await waitTitle(four.page, 'Lượt tìm đầu tiên chưa hoàn tất');
    const text = await four.page.locator('body').innerText();
    assert(!text.includes('đã thấy khách hàng') && !text.includes('đã tìm thấy lead') && !text.includes('Xem danh sách lead'), 'false success');
    await pause(1500);
    assert(await confettiCount(four.page) === 0, 'confetti on failure');
    await shot(four.page, 'failed-1440');
  });

  const WIDTHS = [320, 360, 375, 390, 414, 440, 768, 1024, 1280, 1440];
  await check(`G layouts at ${WIDTHS.join(', ')}px: no sideways scroll, CTA fully visible`, async () => {
    const issues: string[] = [];
    for (const w of WIDTHS) {
      for (const [ctx, name] of [[one, 'results'], [two, 'no-results'], [three, 'waiting'], [four, 'failed']] as const) {
        await ctx.page.setViewportSize({ width: w, height: w < 768 ? 800 : 1000 });
        await ctx.page.goto(`${BASE}/app/lan-tim-dau`); await ctx.page.waitForLoadState('networkidle');
        const m = await ctx.page.evaluate(() => {
          const doc = document.documentElement;
          const cta = document.querySelector('.first-scan-actions .btn-primary, .first-scan-actions .btn')?.getBoundingClientRect();
          const title = document.querySelector('#first-scan-title')?.getBoundingClientRect();
          const scene = document.querySelector('.first-scan .discovery-scene')?.getBoundingClientRect();
          return { sw: doc.scrollWidth, cw: doc.clientWidth, cta: cta && { l: cta.left, r: cta.right, h: cta.height }, title: title && { l: title.left, r: title.right }, scene: scene && { l: scene.left, r: scene.right } };
        });
        if (m.sw > m.cw) issues.push(`${name}@${w} scrollWidth ${m.sw} > ${m.cw}`);
        if (m.cta && (m.cta.l < 0 || m.cta.r > m.cw || m.cta.h < 44)) issues.push(`${name}@${w} CTA ${JSON.stringify(m.cta)}`);
        if (m.title && (m.title.l < 0 || m.title.r > m.cw)) issues.push(`${name}@${w} title clipped`);
        if (m.scene && (m.scene.l < 0 || m.scene.r > m.cw)) issues.push(`${name}@${w} goat clipped`);
        if ([320, 390, 768].includes(w)) await shot(ctx.page, `${name}-${w}`);
      }
    }
    assert(issues.length === 0, issues.join('; '));
    return `${WIDTHS.length} widths × 4 states`;
  });

  await check('G confetti stays inside the page at 320px', async () => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/dang-nhap`);
    await p.getByLabel('Email công việc').fill(email('one'));
    await p.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await p.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await p.waitForURL(`${BASE}/app`);
    await p.goto(`${BASE}/app/lan-tim-dau`);
    await p.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 5000 });
    let worst = 0;
    for (let i = 0; i < 8; i++) {
      worst = Math.max(worst, await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
      if (i === 2) await shot(p, 'results-confetti-320');
      await pause(150);
    }
    await ctx.close();
    assert(worst <= 0, `overflow ${worst}px during confetti`);
  });
  await check('G reduced motion keeps the scene still', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/dang-nhap`);
    await p.getByLabel('Email công việc').fill(email('three'));
    await p.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await p.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await p.waitForURL(`${BASE}/app`);
    const anim = await p.locator('.first-scan-indeterminate i').evaluate(el => getComputedStyle(el).animationName);
    assert(anim === 'none', `indeterminate animation ${anim}`);
    await ctx.close();
  });
  await check('G reduced motion: an unacknowledged success shows no confetti', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(COUNT_CONFETTI);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/dang-nhap`);
    await p.getByLabel('Email công việc').fill(email('one'));
    await p.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
    await p.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await p.waitForURL(`${BASE}/app`);
    await p.goto(`${BASE}/app/lan-tim-dau`);
    await waitTitle(p, 'QLead đã thấy khách hàng');
    await pause(2000);
    const n = await confettiCount(p);
    const summaryAnim = await p.locator('.first-scan-summary').evaluate(el => getComputedStyle(el).animationName);
    await shot(p, 'results-reduced-motion-390');
    await ctx.close();
    assert(n === 0 && summaryAnim === 'none', `confetti ${n}, summary animation ${summaryAnim}`);
  });

  await check('No browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
  for (const c of [one, two, three, four]) await c.context.close();
} finally {
  await cleanup().catch(error => console.error('cleanup failed', error));
  await browser.close();
  await app.close().catch(() => undefined);
  await pool.end();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed, ${results.length - passed} failed`;
  console.log(summary);
  writeFileSync(resolve(SHOTS, 'results.json'), JSON.stringify({ summary, results }, null, 2));
}
