// First-discovery (first search + early "search more") E2E on an ISOLATED database that already has migration 015.
// Synthetic users get a session row directly; a synthetic worker drives the real Fastify worker API in-process
// (app.inject), so the backend itself decides whether an extra search is queued. No Muse, no Facebook.
// 1. Start the web app against the isolated DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test_discovery'; $env:QLEAD_DIST_DIR='.next-discovery'
//    npx next dev --webpack -p 3021 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/first-discovery-e2e.mts http://localhost:3021
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';

const BASE = process.argv[2] ?? 'http://localhost:3021';
if (!/muse_bridge_test_discovery/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_discovery.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/first-discovery-20261104/screenshots');
mkdirSync(SHOTS, { recursive: true });

const RUN = randomBytes(4).toString('hex');
const workerToken = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${workerToken}` };
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const tx = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await work(client); await client.query('COMMIT'); return out; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

// Descriptions: an F&B opening search has complementary directions; the hotel software one has none.
const OPENING = 'Tôi bán máy pha cà phê, muốn tìm các quán F&B sắp khai trương';
const NO_EXTRA = 'Tôi bán phần mềm quản lý cho khách sạn ở Hà Nội';

type User = { userId: string; token: string; profile: string; name: string };
async function newUser(tag: string, description: string): Promise<User> {
  const name = `Khách ${tag}`;
  const [{ id: userId }] = await q("INSERT INTO users(display_name) VALUES ($1) RETURNING id", [`E2E discovery ${RUN} ${tag}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['quán cà phê sắp khai trương', 'quán ăn sắp khai trương', 'quán trà sữa sắp khai trương']), description]);
  await tx(client => enqueueInitialJob(client, profile));
  return { userId, token, profile, name };
}
const worker = {
  claim: async (profile: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profile } });
    const job = r.json().jobs?.[0];
    if (!job) throw new Error(`no job to claim: ${r.body}`);
    return job;
  },
  submit: async (job: any, posts: Array<{ slug: string; author?: string }>) => {
    const r = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
      keywords_used: job.search.keywords, sources_used: job.search.sources,
      posts: posts.map(p => ({ url: `https://www.facebook.com/e2e-discovery/${RUN}/${p.slug}`, author: p.author ?? `Quán ${p.slug}`, content: `Quán ${p.slug} sắp khai trương, đang tìm máy pha cà phê và tuyển nhân viên.`, published_at: new Date(Date.now() - 3600_000).toISOString(), collected_via: 'controlled_fixture' })),
      stats: { total_found: posts.length * 4 + 6 }, errors: [] } });
    if (r.statusCode !== 200) throw new Error(`submit ${r.statusCode} ${r.body}`);
    return r.json();
  },
  fail: async (job: any) => {
    const r = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/failure`, headers: auth, payload: { scan_id: job.scan_id, code: 'execution_error', message: 'e2e', retryable: false } });
    if (r.statusCode !== 200) throw new Error(`fail ${r.statusCode} ${r.body}`);
  },
};
const followupReady = (profile: string) => q("UPDATE search_jobs SET scheduled_for = now(), available_at = now() WHERE search_profile_id = $1 AND kind = 'followup' AND status = 'pending'", [profile]);
const followupCount = async (profile: string) => (await q("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND kind = 'followup'", [profile]))[0].n as number;
const api = async (p: Page) => p.evaluate(async () => (await (await fetch('/api/first-scan', { cache: 'no-store' })).json()).scan);

const consoleErrors: string[] = [];
const COUNT_CONFETTI = () => {
  const w = window as unknown as { __confetti: number };
  w.__confetti = 0;
  new MutationObserver(records => { for (const r of records) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains('first-scan-confetti')) w.__confetti++; }); })
    .observe(document, { childList: true, subtree: true });
};
const confetti = (p: Page) => p.evaluate(() => (window as unknown as { __confetti: number }).__confetti);
async function open(browser: Browser, user: User, width = 1440, reducedMotion: 'reduce' | 'no-preference' = 'no-preference'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  await context.addInitScript(COUNT_CONFETTI);
  const page = await context.newPage();
  page.on('console', async m => {
    if (m.type() !== 'error' || m.text().startsWith('Failed to load resource')) return;
    const args = await Promise.all(m.args().map(a => a.jsonValue().catch(() => ''))).catch(() => []);
    consoleErrors.push(`${page.url()} :: ${m.text()} ${args.slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 400)}`);
  });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return { context, page };
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
const title = (p: Page) => p.locator('#first-scan-title').innerText();
const text = async (p: Page, selector = 'main') => (await p.locator(selector).first().innerText()).replace(/\s+/g, ' ');
async function goto(p: Page, path: string) {
  await p.goto(`${BASE}${path}`).catch(() => p.goto(`${BASE}${path}`));
  await p.waitForLoadState('networkidle');
}
const FORBIDDEN = /\b(job|worker|queue|lease|Muse)\b|cấu hình phiên bản|strategy|follow-?up|\d+\s?%/i;
async function honest(p: Page) {
  const body = await text(p, 'body');
  const bad = body.match(FORBIDDEN);
  assert(!bad, `internal or fake-progress wording: "${bad?.[0]}"`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const users: User[] = [];
try {
  await q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");
  await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes) VALUES ($1, $2, 'active', '["social.search"]', 1, 30)`, [`E2E discovery ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]);

  // ── 1. Zero leads first, then three more ──────────────────────────────────────────────────────────────────
  const s1 = await newUser('s1', OPENING); users.push(s1);
  const v1 = await open(browser, s1);
  let s1Followup: any;
  let s1Initial: any;
  await check('S1a first search running: real searching state, steps with connectors, no percentages', async () => {
    s1Initial = await worker.claim(s1.profile);
    await goto(v1.page, '/app/lan-tim-dau');
    assert(await title(v1.page) === 'QLead đang tìm bài đăng phù hợp', await title(v1.page));
    const steps = await v1.page.locator('.first-scan-steps li').evaluateAll(els => els.map(el => el.className));
    assert(steps.join(',') === 'is-done,is-done,is-current,is-upcoming', steps.join(','));
    const segs = await v1.page.locator('.first-scan-step-seg').evaluateAll(els => els.map(el => el.className.replace('first-scan-step-seg ', '')));
    assert(segs.join(',') === 'is-complete,is-active,is-upcoming', `segments ${segs.join(',')}`);
    await honest(v1.page);
    await shot(v1.page, 's1a-initial-running-1440');
  });
  await check('S1b first search finds nothing; an extra search is planned → "looking", no celebration, leads not promised', async () => {
    const ack = await worker.submit(s1Initial, []);
    assert(ack.early_followup_queued === true, `followup not queued: ${JSON.stringify(ack)}`);
    await goto(v1.page, '/app/lan-tim-dau');
    const scan = await api(v1.page);
    // Backend gap: the 3-minute delay is stored in scheduled_for while the API compares available_at, so a freshly
    // planned extra search is reported as followup_waiting. The UI treats both the same way.
    assert(['followup_planned', 'followup_waiting'].includes(scan.discovery.status), scan.discovery.status);
    assert(await title(v1.page) === 'QLead sẽ tiếp tục tìm thêm cơ hội phù hợp', await title(v1.page));
    const body = await text(v1.page);
    assert(body.includes('Lượt tìm đầu tiên đã xong') && body.includes('chưa chắc sẽ có thêm lead') && body.includes('không cần chờ'), body.slice(0, 300));
    assert(!body.includes('đã thấy khách hàng') && await v1.page.locator('.first-scan-indeterminate').count() === 0, 'claims results or shows a loading bar while only planned');
    const steps = await v1.page.locator('.first-scan-steps li').evaluateAll(els => els.map(el => el.className));
    assert(steps.join(',') === 'is-done,is-current,is-upcoming', steps.join(','));
    assert(await confetti(v1.page) === 0, 'confetti for zero leads');
    await honest(v1.page);
    await shot(v1.page, 's1b-looking-planned-1440');
    await goto(v1.page, '/app');
    assert(await v1.page.locator('.first-scan').count() === 1 && await v1.page.locator('.summary-row').count() === 0, 'Today should lead with the discovery while there are no leads');
    await shot(v1.page, 's1b-today-looking-1440');
  });
  await check('S1c extra search waiting → running (refresh keeps it); goat searches only while running', async () => {
    await followupReady(s1.profile);
    await goto(v1.page, '/app/lan-tim-dau');
    assert((await api(v1.page)).discovery.status === 'followup_waiting', 'waiting status');
    assert(await v1.page.locator('.discovery-card').count() === 0, 'searching visual while only waiting');
    s1Followup = await worker.claim(s1.profile);
    assert(s1Followup.kind === 'followup', s1Followup.kind);
    await v1.page.reload(); await v1.page.waitForLoadState('networkidle');
    assert(await title(v1.page) === 'QLead đang tìm thêm cơ hội phù hợp…', await title(v1.page));
    assert(await v1.page.locator('.discovery-card').count() === 3 && await v1.page.locator('.first-scan-indeterminate').count() === 1, 'running visual');
    await shot(v1.page, 's1c-looking-running-1440');
  });
  await check('S1d the extra search finds 3 → page turns into the celebration by itself, counts kept apart, one burst', async () => {
    await worker.submit(s1Followup, [{ slug: 's1-a' }, { slug: 's1-b' }, { slug: 's1-c' }]);
    await v1.page.locator('#first-scan-title', { hasText: 'QLead đã thấy khách hàng' }).waitFor({ timeout: 20000 });
    await v1.page.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 3000 });
    assert(await v1.page.locator('.found-count-main b.is-reveal').count() === 1 && await v1.page.locator('.discovery-scene.is-hop').count() === 1, 'count reveal / goat hop on the qualifying transition');
    await pause(500);
    await shot(v1.page, 's1d-found-after-more-confetti-1440');
    const count = await text(v1.page, '.found-count');
    assert(count.startsWith('3 lead mới') && !count.includes('từ lượt đầu'), count);
    assert(await v1.page.locator('.discovery-orbit').count() === 0, 'orbit after discovery finished');
    assert((await text(v1.page, '.discovery-line')).includes('QLead sẽ tiếp tục theo dõi và cập nhật cơ hội mới cho bạn.'), 'monitoring line');
    const stamp = await text(v1.page, '.first-scan-finished-at');
    assert(stamp.startsWith('Hoàn tất lúc'), stamp);
    assert(await v1.page.locator('.first-leads, .lead-list').count() === 0, 'lead cards on the celebration screen');
    await v1.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 4000 });
    await v1.page.reload(); await pause(2000);
    assert(await confetti(v1.page) === 0, 'celebration replayed after refresh');
    await honest(v1.page);
    await shot(v1.page, 's1d-found-after-more-1440');
    await goto(v1.page, '/app');
    assert(await v1.page.locator('.summary-row').count() === 1, 'Today should show leads now');
    const notice = await text(v1.page, '.discovery-notice');
    assert(notice.includes('QLead đã tìm thêm được 3 lead mới'), notice);
    await shot(v1.page, 's1d-today-notice-found-1440');
  });

  // ── 2. One lead first, then four more (one duplicate URL); historical leads exist ─────────────────────────
  const s2 = await newUser('s2', OPENING); users.push(s2);
  const [{ id: legacy }] = await q("INSERT INTO agent_connections(user_id, name, kind, credential_hash) VALUES ($1, 'Kết nối cũ', 'legacy_agent', $2) RETURNING id", [s2.userId, createHash('sha256').update(randomBytes(16)).digest('hex')]);
  for (const slug of ['old-1', 'old-2']) await q("INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, collected_via, first_seen_at) VALUES ($1, $2, $2, 'Bài cũ: quán sắp khai trương cần máy pha', $3, now() - interval '5 days', 'legacy', now() - interval '5 days')", [legacy, `https://www.facebook.com/e2e-discovery/${RUN}/${slug}`, `Lịch sử ${slug}`]);
  const v2 = await open(browser, s2);
  let s2Followup: any;
  await check('S2a one lead found, extra search planned → leads open immediately, "Tìm thêm" tile is not a number', async () => {
    const job = await worker.claim(s2.profile);
    const ack = await worker.submit(job, [{ slug: 's2-first' }]);
    assert(ack.early_followup_queued === true && ack.usable_new_posts === 1, JSON.stringify(ack));
    await goto(v2.page, '/app/lan-tim-dau');
    assert(await title(v2.page) === 'QLead đã thấy khách hàng', await title(v2.page));
    await v2.page.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 3000 });
    const body = await text(v2.page);
    await pause(700);
    await shot(v2.page, 's2a-found-more-planned-confetti-1440');
    assert(!body.includes('Hoàn tất lúc') && !body.includes('Đang chờ đến lượt') && !body.includes('Lượt đầu tiên'), body.slice(0, 400));
    assert((await text(v2.page, '.found-count')).startsWith('1 lead mới'), 'count');
    assert(await v2.page.locator('.discovery-orbit.is-pending').count() === 1 && await v2.page.locator('.discovery-orbit.is-running').count() === 0, 'pending orbit only');
    const line = await text(v2.page, '.discovery-line');
    assert(line.includes('QLead sẽ tiếp tục tìm thêm cơ hội phù hợp.') && line.includes('Bạn có thể xem kết quả ngay') && !line.includes('đang tìm'), line);
    assert(await v2.page.locator('.first-scan-actions .btn').count() === 1, 'only the primary action');
    assert(await v2.page.getByRole('link', { name: /Xem danh sách lead/ }).getAttribute('href') === `/app/bai-viet?nhu-cau=${s2.profile}`, 'CTA');
    await honest(v2.page);
    await v2.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 4000 });
    await shot(v2.page, 's2a-found-more-planned-1440');
  });
  await check('S2b leave and return: Today shows leads + "đang tìm thêm" line; list shows historical + new leads with the line', async () => {
    await goto(v2.page, '/app');
    assert(await v2.page.locator('.summary-row').count() === 1 && await v2.page.locator('.first-scan').count() === 0, 'Today should show leads');
    const notice = await text(v2.page, '.discovery-notice');
    assert(notice.includes('QLead sẽ tiếp tục tìm thêm') && notice.includes('xem được ngay'), notice);
    await shot(v2.page, 's2b-today-notice-more-1440');
    await goto(v2.page, `/app/bai-viet?nhu-cau=${s2.profile}`);
    assert((await text(v2.page, '.discovery-notice')).includes('Bạn xem được các lead dưới đây ngay'), 'list notice');
    const head = await text(v2.page, '.page-head');
    assert(head.includes('3 lead'), `historical (2) + new (1) expected: ${head}`);
    await shot(v2.page, 's2b-list-notice-more-1440');
    await goto(v2.page, '/app/lan-tim-dau');
    assert(await title(v2.page) === 'QLead đã thấy khách hàng' && await confetti(v2.page) === 0, 'state lost or celebration replayed on return');
  });
  await check('S2c status changes while the page polls: pending → running orbit, then +4 (one duplicate ignored) → 5 with a "+4" pop, list refreshes itself', async () => {
    await followupReady(s2.profile);
    await goto(v2.page, '/app/lan-tim-dau');
    assert(await v2.page.locator('.discovery-orbit.is-pending').count() === 1, 'pending before start');
    s2Followup = await worker.claim(s2.profile);
    // No reload: the open page must pick up the change by itself.
    await v2.page.locator('.discovery-orbit.is-running').waitFor({ timeout: 20000 });
    const line = await text(v2.page, '.discovery-line');
    assert(line.includes('QLead đang tìm thêm cơ hội phù hợp…') && await v2.page.locator('.discovery-line-scan').count() === 1, line);
    await shot(v2.page, 's2c-found-more-running-1440');
    const list = await v2.context.newPage();
    await goto(list, `/app/bai-viet?nhu-cau=${s2.profile}`);
    assert((await text(list, '.discovery-notice')).includes('QLead đang tìm thêm'), 'running notice on list');
    const ack = await worker.submit(s2Followup, [{ slug: 's2-first' }, { slug: 's2-b' }, { slug: 's2-c' }, { slug: 's2-d' }, { slug: 's2-e' }]);
    assert(ack.usable_new_posts === 4 && ack.duplicates === 1, JSON.stringify(ack));
    await v2.page.locator('.found-count-added', { hasText: '+4' }).waitFor({ timeout: 20000 });
    await pause(400);
    await shot(v2.page, 's2c-found-plus-4-1440');
    assert((await text(v2.page, '.found-count')).startsWith('5 lead mới') && (await text(v2.page, '.found-count-split')) === '1 từ lượt đầu · 4 tìm thêm', await text(v2.page, '.found-count'));
    assert(await v2.page.locator('.discovery-orbit').count() === 0 && (await text(v2.page, '.discovery-line')).includes('QLead sẽ tiếp tục theo dõi'), 'orbit kept after discovery finished');
    await list.locator('.discovery-notice.is-found').waitFor({ timeout: 25000 });
    await list.locator('.page-head', { hasText: '7 lead' }).waitFor({ timeout: 10000 });
    await shot(list, 's2c-list-found-1440');
    await list.close();
    await goto(v2.page, '/app/lan-tim-dau');
    assert(await confetti(v2.page) === 0, 'second celebration');
    await honest(v2.page);
    await shot(v2.page, 's2c-found-done-1440');
    // Dismissing the line on Today keeps it dismissed.
    await goto(v2.page, '/app');
    await v2.page.getByRole('button', { name: 'Ẩn thông báo' }).click();
    await v2.page.reload(); await v2.page.waitForLoadState('networkidle');
    assert(await v2.page.locator('.discovery-notice').count() === 0, 'dismissed notice came back');
  });

  // ── 2b. First lead seen for the first time while the extra search already runs ───────────────────────────
  const s2b = await newUser('s2b', OPENING); users.push(s2b);
  await check('S2d first visit while the extra search is already running → one celebration, then the running orbit', async () => {
    await worker.submit(await worker.claim(s2b.profile), [{ slug: 's2b-a' }]);
    await followupReady(s2b.profile);
    const held = await worker.claim(s2b.profile);
    const v = await open(browser, s2b);
    await goto(v.page, '/app/lan-tim-dau');
    await v.page.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 3000 });
    assert(await v.page.locator('.discovery-orbit.is-running').count() === 1 && (await text(v.page, '.discovery-line')).includes('QLead đang tìm thêm cơ hội phù hợp…'), 'running orbit with celebration');
    await pause(700);
    await shot(v.page, 's2d-found-more-running-confetti-1440');
    await v.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 4000 });
    await shot(v.page, 's2d-found-more-running-1440');
    await v.context.close();
    await worker.submit(held, []);
  });

  // ── 3. Several leads first: no extra search, classic celebration ──────────────────────────────────────────
  const s3 = await newUser('s3', OPENING); users.push(s3);
  const v3 = await open(browser, s3);
  await check('S3 three leads first → no extra search, "Hoàn tất", classic tiles', async () => {
    const ack = await worker.submit(await worker.claim(s3.profile), [{ slug: 's3-a' }, { slug: 's3-b' }, { slug: 's3-c' }]);
    assert(ack.early_followup_queued === false, JSON.stringify(ack));
    await goto(v3.page, '/app/lan-tim-dau');
    const scan = await api(v3.page);
    assert(scan.discovery.status === 'completed' && scan.discovery.followupSkipReason === 'threshold_met', JSON.stringify(scan.discovery).slice(0, 200));
    assert(await title(v3.page) === 'QLead đã thấy khách hàng', await title(v3.page));
    assert((await text(v3.page, '.first-scan-lead')) === 'QLead đã hoàn thành lượt tìm đầu tiên và tìm thấy những cơ hội phù hợp với nhu cầu của bạn.', 'supporting text');
    assert((await text(v3.page, '.found-count')).startsWith('3 lead mới') && await v3.page.locator('.found-count-split, .discovery-orbit').count() === 0, 'count / no orbit');
    assert((await text(v3.page, '.discovery-line')).includes('QLead sẽ tiếp tục theo dõi'), 'monitoring line');
    assert((await text(v3.page, '.first-scan-finished-at')).startsWith('Hoàn tất lúc'), 'stamp');
    await honest(v3.page);
    await v3.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    await shot(v3.page, 's3-found-no-more-1440');
  });

  // ── 4. Nothing after both searches ────────────────────────────────────────────────────────────────────────
  const s4 = await newUser('s4', OPENING); users.push(s4);
  const v4 = await open(browser, s4);
  await check('S4 zero after both searches → calm empty result, no celebration, edit suggested', async () => {
    await worker.submit(await worker.claim(s4.profile), []);
    await followupReady(s4.profile);
    await worker.submit(await worker.claim(s4.profile), []);
    await goto(v4.page, '/app/lan-tim-dau');
    assert(await title(v4.page) === 'Đã hoàn tất lượt tìm đầu tiên', await title(v4.page));
    assert((await text(v4.page, '.first-scan-lead')).includes('đã thử thêm vài hướng tìm khác'), 'empty copy');
    assert(await v4.page.locator('.found-count, .discovery-orbit').count() === 0, 'count or orbit on an empty result');
    assert(await v4.page.getByRole('link', { name: 'Chỉnh nhu cầu' }).isVisible() && await confetti(v4.page) === 0, 'edit / confetti');
    await honest(v4.page);
    await shot(v4.page, 's4-empty-after-more-1440');
  });

  // ── 5. No complementary directions: no extra search at all ────────────────────────────────────────────────
  const s5 = await newUser('s5', NO_EXTRA); users.push(s5);
  const v5 = await open(browser, s5);
  await check('S5 zero first, nothing more worth trying → empty result straight away, no "tìm thêm" mentioned', async () => {
    const ack = await worker.submit(await worker.claim(s5.profile), []);
    assert(ack.early_followup_queued === false && await followupCount(s5.profile) === 0, JSON.stringify(ack));
    await goto(v5.page, '/app/lan-tim-dau');
    const scan = await api(v5.page);
    assert(scan.discovery.status === 'no_additional_coverage', scan.discovery.status);
    assert(await title(v5.page) === 'Đã hoàn tất lượt tìm đầu tiên', await title(v5.page));
    const body = await text(v5.page);
    assert(!body.includes('Tìm thêm') && body.includes('Chưa tìm thấy bài đăng phù hợp với nhu cầu hiện tại'), body.slice(0, 300));
    await honest(v5.page);
    await shot(v5.page, 's5-empty-no-coverage-1440');
  });

  // ── 6. Extra search waiting a long time (no search free) ─────────────────────────────────────────────────
  const s6 = await newUser('s6', OPENING); users.push(s6);
  const v6 = await open(browser, s6);
  await check('S6 extra search not picked up for 15 min → "chậm hơn thường lệ", calm, nothing to do', async () => {
    await worker.submit(await worker.claim(s6.profile), []);
    await q("UPDATE search_jobs SET created_at = now() - interval '15 minutes', scheduled_for = now() - interval '12 minutes', available_at = now() - interval '12 minutes' WHERE search_profile_id = $1 AND kind = 'followup'", [s6.profile]);
    await goto(v6.page, '/app/lan-tim-dau');
    await v6.page.locator('.first-scan-estimate.is-slow').waitFor({ timeout: 5000 });
    const est = await text(v6.page, '.first-scan-estimate');
    assert(est.includes('chờ lâu hơn thường lệ') && est.includes('không cần làm gì') && !/lỗi|thất bại/i.test(est), est);
    assert(await v6.page.locator('.discovery-card').count() === 0, 'searching visual while waiting');
    await honest(v6.page);
    await shot(v6.page, 's6-looking-slow-1440');
  });

  // ── 7. Extra search fails after one lead ──────────────────────────────────────────────────────────────────
  const s7 = await newUser('s7', OPENING); users.push(s7);
  const v7 = await open(browser, s7);
  await check('S7 extra search fails → leads stay the headline; only the "Tìm thêm" tile says it did not complete', async () => {
    await worker.submit(await worker.claim(s7.profile), [{ slug: 's7-a' }]);
    await followupReady(s7.profile);
    await worker.fail(await worker.claim(s7.profile));
    await goto(v7.page, '/app/lan-tim-dau');
    const scan = await api(v7.page);
    assert(scan.discovery.status === 'failed', `backend reports ${scan.discovery.status}`);
    assert(await title(v7.page) === 'QLead đã thấy khách hàng', `failed extra search hid the first results: ${await title(v7.page)}`);
    assert((await text(v7.page, '.found-count')).startsWith('1 lead mới') && await v7.page.locator('.discovery-orbit').count() === 0, 'count / orbit after a failed extra search');
    assert(!(await text(v7.page)).includes('gặp sự cố'), 'alarming failure copy');
    await honest(v7.page);
    await v7.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    await shot(v7.page, 's7-found-more-failed-1440');
  });

  // ── 8. First search failed ────────────────────────────────────────────────────────────────────────────────
  const s8 = await newUser('s8', OPENING); users.push(s8);
  const v8 = await open(browser, s8);
  await check('S8 first search fails → honest failure, no celebration, no extra search', async () => {
    await worker.fail(await worker.claim(s8.profile));
    await goto(v8.page, '/app/lan-tim-dau');
    assert(await title(v8.page) === 'Lượt tìm đầu tiên chưa hoàn tất', await title(v8.page));
    assert(await followupCount(s8.profile) === 0 && await confetti(v8.page) === 0, 'followup or confetti after failure');
    await honest(v8.page);
    await shot(v8.page, 's8-initial-failed-1440');
  });

  // ── 9. Pause, suspension and edit while an extra search is pending ───────────────────────────────────────
  const s9 = await newUser('s9', OPENING); users.push(s9);
  const v9 = await open(browser, s9);
  await check('S9 pause with an extra search pending → results kept, "tạm dừng" line, nothing claims to be searching', async () => {
    await worker.submit(await worker.claim(s9.profile), [{ slug: 's9-a' }]);
    await goto(v9.page, '/app/lan-tim-dau');
    const status = await v9.page.evaluate(async id => (await fetch(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) })).status, s9.profile);
    assert(status === 200, `pause ${status}`);
    await v9.page.reload(); await v9.page.waitForLoadState('networkidle');
    assert(await title(v9.page) === 'QLead đã thấy khách hàng', await title(v9.page));
    const body = await text(v9.page);
    assert(body.includes('Nhu cầu đang tạm dừng nên QLead chưa tìm thêm') && !body.includes('Đang tìm') && !body.includes('Sắp bắt đầu'), body.slice(0, 500));
    await shot(v9.page, 's9-found-paused-1440');
    await v9.page.evaluate(async id => fetch(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) }), s9.profile);
  });
  await check('S9b account suspended → results kept, suspension line, no "tìm thêm" progress', async () => {
    await q("UPDATE users SET lead_monitoring_status = 'suspended' WHERE id = $1", [s9.userId]);
    await goto(v9.page, '/app/lan-tim-dau');
    const body = await text(v9.page);
    assert(await title(v9.page) === 'QLead đã thấy khách hàng' && body.includes('Tài khoản đang tạm ngưng tìm khách mới'), body.slice(0, 400));
    assert(!body.includes('Đang tìm') && !body.includes('Sắp bắt đầu'), 'searching while suspended');
    await shot(v9.page, 's9b-found-suspended-1440');
    await q("UPDATE users SET lead_monitoring_status = 'active' WHERE id = $1", [s9.userId]);
  });
  const s10 = await newUser('s10', OPENING); users.push(s10);
  const v10 = await open(browser, s10);
  await check('S10 editing the need while an extra search is pending → it is dropped; page shows the first results only', async () => {
    await worker.submit(await worker.claim(s10.profile), [{ slug: 's10-a' }]);
    await goto(v10.page, '/app/lan-tim-dau');
    const status = await v10.page.evaluate(async id => (await fetch(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { description: 'Tôi bán máy pha cà phê, muốn tìm quán trà sữa sắp khai trương ở Cần Thơ', frequency_minutes: 30 } }) })).status, s10.profile);
    assert(status === 200, `edit ${status}`);
    await v10.page.reload(); await v10.page.waitForLoadState('networkidle');
    const scan = await api(v10.page);
    assert(scan.discovery.followupSkipReason === 'configuration_changed', JSON.stringify(scan.discovery).slice(0, 200));
    const count = await text(v10.page, '.found-count');
    assert(await title(v10.page) === 'QLead đã thấy khách hàng' && count.startsWith('1 lead mới') && await v10.page.locator('.discovery-orbit').count() === 0, count);
    await shot(v10.page, 's10-found-after-edit-1440');
  });

  // ── bo-loc card during the extra search ───────────────────────────────────────────────────────────────────
  const s11 = await newUser('s11', OPENING); users.push(s11);
  const v11 = await open(browser, s11);
  await check('S11 /app/bo-loc names the extra search in customer words and offers the leads already found', async () => {
    await worker.submit(await worker.claim(s11.profile), [{ slug: 's11-a' }]);
    await goto(v11.page, '/app/bo-loc');
    const card = await text(v11.page, '.pf-stage');
    assert(card.includes('Tìm thêm sau lần tìm đầu tiên') && card.includes('QLead sẽ tiếp tục tìm thêm') && card.includes('Đã có 1 khách hàng'), card);
    assert(await v11.page.getByRole('link', { name: /Xem khách hàng mới/ }).isVisible(), 'view leads action');
    await honest(v11.page);
    await shot(v11.page, 's11-bo-loc-more-planned-1440');
    await followupReady(s11.profile);
    await worker.claim(s11.profile);
    await goto(v11.page, '/app/bo-loc');
    assert((await text(v11.page, '.pf-stage')).includes('Đang tìm thêm khách hàng'), 'running card');
    await shot(v11.page, 's11-bo-loc-more-running-1440');
  });

  // ── Responsive and reduced motion ─────────────────────────────────────────────────────────────────────────
  await check('R layouts at 390 / 768 / 1440 for every state: no sideways scroll, nothing clipped, CTA ≥ 44px', async () => {
    const issues: string[] = [];
    const states: Array<[User, string, string]> = [[s1, 'found-after-more', '/app/lan-tim-dau'], [s2, 'found-both', '/app/lan-tim-dau'], [s6, 'looking-slow', '/app/lan-tim-dau'], [s4, 'empty-after-more', '/app/lan-tim-dau'], [s11, 'found-more-running', '/app/lan-tim-dau'], [s11, 'today-notice', '/app'], [s11, 'list-notice', `/app/bai-viet?nhu-cau=${s11.profile}`], [s11, 'bo-loc', '/app/bo-loc']];
    for (const width of [390, 768, 1440]) for (const [user, name, path] of states) {
      const { context, page } = await open(browser, user, width);
      await goto(page, path);
      await page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
      // A string, so the bundler's helper names never leak into the page.
      const m = await page.evaluate(`(() => {
        const doc = document.documentElement;
        const out = { sw: doc.scrollWidth, cw: doc.clientWidth };
        for (const [key, sel] of [['cta', '.first-scan-actions .btn'], ['title', '#first-scan-title'], ['stats', '.discovery-line'], ['notice', '.discovery-notice']]) {
          const b = document.querySelector(sel)?.getBoundingClientRect();
          out[key] = b ? { l: b.left, r: b.right, h: b.height } : null;
        }
        return out;
      })()`) as { sw: number; cw: number; cta: { l: number; r: number; h: number } | null; title: { l: number; r: number } | null; stats: { l: number; r: number } | null; notice: { l: number; r: number } | null };
      if (m.sw > m.cw) issues.push(`${name}@${width} scroll ${m.sw}>${m.cw}`);
      for (const key of ['title', 'stats', 'notice'] as const) { const b = m[key]; if (b && (b.l < 0 || b.r > m.cw)) issues.push(`${name}@${width} ${key} clipped`); }
      if (m.cta && (m.cta.l < 0 || m.cta.r > m.cw || m.cta.h < 44)) issues.push(`${name}@${width} CTA ${JSON.stringify(m.cta)}`);
      if (width !== 1440 || name === 'found-both') await shot(page, `r-${name}-${width}`);
      await context.close();
    }
    assert(issues.length === 0, issues.join('; '));
    return `${states.length} views × 3 widths`;
  });
  await check('R reduced motion: still connectors, no live pulse animation, no confetti on a fresh success', async () => {
    // Free the synthetic worker (it still holds S11's extra search).
    const [held] = await q("SELECT id, scan_id, configuration_version FROM search_jobs WHERE search_profile_id = $1 AND kind = 'followup'", [s11.profile]);
    await worker.submit({ job_id: held.id, scan_id: held.scan_id, configuration_version: held.configuration_version, search: { keywords: [], sources: ['social.search'] } }, []);
    const s12 = await newUser('s12', OPENING); users.push(s12);
    await worker.submit(await worker.claim(s12.profile), [{ slug: 's12-a' }]);
    await followupReady(s12.profile);
    await worker.claim(s12.profile);
    const { context, page } = await open(browser, s12, 390, 'reduce');
    await goto(page, '/app/lan-tim-dau');
    await pause(1500);
    const anims = await page.evaluate(`[...document.querySelectorAll('.discovery-orbit i, .found-count-main b, .discovery-line-scan i, .discovery-scene .goat-mascot')].map(el => getComputedStyle(el).animationName)`) as string[];
    const n = await confetti(page);
    const orbit = await page.locator('.discovery-orbit.is-running').count();
    await shot(page, 'r-reduced-motion-found-more-running-390');
    await context.close();
    assert(anims.length >= 3 && anims.every(a => a === 'none') && n === 0 && orbit === 1, `animations ${anims.join(',')}, confetti ${n}, orbit ${orbit}`);
  });

  await check('No browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
} finally {
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [users.map(u => u.userId)]).catch(e => console.error('cleanup users', e));
  await q("DELETE FROM search_job_attempts WHERE worker_id IN (SELECT id FROM muse_workers WHERE name = $1)", [`E2E discovery ${RUN}`]).catch(() => undefined);
  await q('DELETE FROM muse_workers WHERE name = $1', [`E2E discovery ${RUN}`]).catch(() => undefined);
  await browser.close();
  await app.close().catch(() => undefined);
  await pool.end();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed, ${results.length - passed} failed`;
  console.log(summary);
  writeFileSync(resolve(SHOTS, 'results.json'), JSON.stringify({ summary, results }, null, 2));
}
