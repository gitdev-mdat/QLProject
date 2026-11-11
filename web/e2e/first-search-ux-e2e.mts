// First-search UX + bounded lead delivery, browser QA on an ISOLATED database (migrations 001–021).
// Controlled test data only: synthetic users get a session row directly, and a synthetic worker drives the real
// worker API in-process (app.inject). No Muse, no Facebook: this is a simulation, NOT an end-to-end check with Muse.
// 1. Start the web app against the isolated DB (from web/):
//    $env:DATABASE_URL='postgres://muse:<pw>@127.0.0.1:55432/muse_bridge_test_firstux'; $env:QLEAD_DIST_DIR='.next-firstux'
//    npx next dev --webpack -p 3061 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/first-search-ux-e2e.mts http://localhost:3061
//    MODE=before only takes screenshots (for the unchanged baseline build); SHOT_DIR picks the folder.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';

const BASE = process.argv[2] ?? 'http://localhost:3061';
const MODE = process.env.MODE === 'before' ? 'before' : 'after';
if (!/muse_bridge_test_firstux/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_firstux.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? `docs/first-search-ux-20261108/screenshots/${MODE}`);
mkdirSync(SHOTS, { recursive: true });

const RUN = randomBytes(4).toString('hex');
const workerToken = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${workerToken}` };
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0]! }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (MODE === 'after' && !c) throw new Error(m); };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const tx = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await work(client); await client.query('COMMIT'); return out; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};

type User = { userId: string; token: string; profile: string };
async function newUser(tag: string): Promise<User> {
  const [{ id: userId }] = await q("INSERT INTO users(display_name) VALUES ($1) RETURNING id", [`E2E first-search ${RUN} ${tag}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, 'Quán cà phê sắp khai trương']);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['quán cà phê sắp khai trương', 'quán trà sữa sắp khai trương']), 'Tôi bán máy pha cà phê, muốn tìm các quán F&B sắp khai trương']);
  await tx(client => enqueueInitialJob(client, profile));
  return { userId, token, profile };
}

const AREAS = ['Quận 7, TP.HCM', 'Thủ Đức', 'Biên Hòa', 'Gò Vấp', 'Bình Thạnh'];
type Post = { slug: string; author?: string | null; content?: string | null; hoursAgo?: number };
function post(i: number, extra: Partial<Post> = {}): Post {
  return { slug: `p${i}`, author: `Quán ${['Mộc', 'Lá', 'Sương', 'Gió', 'Nắng', 'Mây'][i % 6]} ${i}`, hoursAgo: 1 + i,
    content: `Quán mình sắp khai trương ở ${AREAS[i % AREAS.length]}, đang cần tìm máy pha cà phê và phần mềm bán hàng.${i % 3 === 0 ? ' LH 0912 345 6' + String(10 + i).slice(-2) : ''}`, ...extra };
}
const worker = {
  claim: async (profile: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profile } });
    const job = r.json().jobs?.[0];
    if (!job) throw new Error(`no job to claim: ${r.body}`);
    return job;
  },
  submit: async (job: any, posts: Post[]) => {
    const r = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
      keywords_used: job.search.keywords, sources_used: job.search.sources,
      posts: posts.map(p => ({ url: `https://www.facebook.com/groups/e2efirstux${RUN}/posts/${job.job_id.slice(0, 6)}${p.slug}`, ...(p.author ? { author: p.author } : {}), ...(p.content ? { content: p.content } : {}),
        published_at: new Date(Date.now() - (p.hoursAgo ?? 1) * 3600_000).toISOString(), collected_via: 'controlled_fixture' })),
      stats: { total_found: posts.length * 3 + 5 }, errors: [] } });
    if (r.statusCode !== 200) throw new Error(`submit ${r.statusCode} ${r.body}`);
    return r.json();
  },
  fail: async (job: any, retryable: boolean) => {
    const r = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/failure`, headers: auth, payload: { scan_id: job.scan_id, code: 'execution_error', message: 'e2e', retryable } });
    if (r.statusCode !== 200) throw new Error(`fail ${r.statusCode} ${r.body}`);
  },
};
// No extra search in these scenarios: it has its own E2E (first-discovery-e2e.mts).
const noFollowup = (profile: string) => q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation' WHERE search_profile_id = $1 AND kind = 'followup' AND status = 'pending'", [profile]);

const consoleErrors: string[] = [];
async function open(browser: Browser, user: User, width = 1440): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 300)}`); });
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
const FORBIDDEN = /\b(job|worker|queue|lease|Muse|cycle)\b|\d+\s?%|2–3 phút/i;
async function honest(p: Page) {
  const body = await text(p, 'body');
  const bad = body.match(FORBIDDEN);
  assert(!bad, `internal, fake-progress or fixed-ETA wording: "${bad?.[0]}"`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
}
async function widths(browser: Browser, user: User, path: string, name: string, ready?: (p: Page) => Promise<unknown>) {
  for (const width of [390, 768, 1440]) {
    const v = await open(browser, user, width);
    await goto(v.page, path);
    if (ready) await ready(v.page);
    await honest(v.page);
    await shot(v.page, `${name}-${width}`);
    await v.context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");
  await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at) VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`E2E first-search ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]);

  // ── A. Waiting: saved just now, then minutes later, then much later. Elapsed time is real, no fixed ETA. ──
  const w = await newUser('wait');
  await check('A1 just saved: "đang chuẩn bị", saved time, no ETA, no moving bar', async () => {
    await widths(browser, w, '/app/lan-tim-dau', 'a1-waiting-fresh', async p => {
      assert(await title(p) === 'QLead đang chuẩn bị lượt tìm kiếm của bạn', `title: ${await title(p)}`);
      const box = await text(p, '.first-scan-estimate');
      assert(/Đã lưu lúc \d{1,2}:\d{2}/.test(box), `timing box: ${box}`);
      assert(await p.locator('.first-scan-indeterminate').count() === 0, 'indeterminate bar while only waiting');
      const steps = await p.locator('.first-scan-steps li').evaluateAll(els => els.map(el => el.className));
      assert(steps.join(',') === 'is-done,is-current,is-upcoming,is-upcoming', steps.join(','));
    });
  });
  await check('A2 waiting 4 minutes: "chưa bắt đầu" + "Đã chờ 4 phút"', async () => {
    await q("UPDATE search_jobs SET created_at = now() - interval '4 minutes 5 seconds' WHERE search_profile_id = $1", [w.profile]);
    const v = await open(browser, w);
    await goto(v.page, '/app/lan-tim-dau');
    await v.page.waitForFunction(() => /Đã chờ 4 phút/.test(document.querySelector('.first-scan-estimate')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
    assert(await title(v.page) === 'Lượt tìm đầu tiên chưa bắt đầu', `title: ${await title(v.page)}`);
    assert(/Đã chờ 4 phút/.test(await text(v.page, '.first-scan-estimate')), await text(v.page, '.first-scan-estimate'));
    await honest(v.page); await shot(v.page, 'a2-waiting-4min-1440'); await v.context.close();
  });
  await check('A3 waiting 15 minutes: honest "lâu hơn bình thường" + what to do', async () => {
    await q("UPDATE search_jobs SET created_at = now() - interval '15 minutes 5 seconds' WHERE search_profile_id = $1", [w.profile]);
    await widths(browser, w, '/app/lan-tim-dau', 'a3-waiting-slow', async p => {
      await p.waitForFunction(() => /15 phút/.test(document.querySelector('.first-scan-estimate')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
      assert(await title(p) === 'Lượt tìm đang chờ lâu hơn bình thường', `title: ${await title(p)}`);
      const body = await text(p);
      assert(/không cần tạo lại nhu cầu/.test(body) && /rời trang/.test(body), 'guidance missing');
    });
  });

  // ── B. Running, then running long. ──
  const r = await newUser('run');
  const rJob = await worker.claim(r.profile);
  await check('B1 claimed: "đang tìm", start time, moving bar, no percentage', async () => {
    await widths(browser, r, '/app/lan-tim-dau', 'b1-running', async p => {
      assert(await title(p) === 'QLead đang tìm khách hàng phù hợp', `title: ${await title(p)}`);
      assert(/Bắt đầu lúc \d{1,2}:\d{2}/.test(await text(p, '.first-scan-estimate')), await text(p, '.first-scan-estimate'));
      assert(await p.locator('.first-scan-indeterminate').count() === 1, 'no running indicator');
    });
  });
  await check('B2 running 7 minutes: "lâu hơn thường lệ", elapsed from the real start', async () => {
    await q("UPDATE search_job_attempts SET claimed_at = now() - interval '7 minutes' WHERE job_id = $1", [rJob.job_id]);
    const v = await open(browser, r);
    await goto(v.page, '/app/lan-tim-dau');
    const body = await text(v.page);
    assert(/lâu hơn thường lệ/.test(body) && /đã tìm 7 phút/.test(body), body.slice(0, 300));
    await honest(v.page); await shot(v.page, 'b2-running-long-1440'); await v.context.close();
  });
  // Free the synthetic worker's single lease for the next scenarios.
  await worker.submit(rJob, []); await noFollowup(r.profile);

  // ── C. Found 14 → the customer is given 10 (one bounded delivery) and told 4 are held. ──
  const f = await newUser('found');
  const fView = await open(browser, f);
  await check('C1 page open while the search runs, then results arrive without a reload', async () => {
    const job = await worker.claim(f.profile);
    await goto(fView.page, '/app/lan-tim-dau');
    await shot(fView.page, 'c0-running-before-results-1440');
    await worker.submit(job, Array.from({ length: 14 }, (_, i) => post(i)));
    await noFollowup(f.profile);
    await fView.page.waitForFunction(() => /khách hàng cho bạn/.test(document.querySelector('#first-scan-title')?.textContent ?? ''), null, { timeout: 15000 });
    await fView.page.waitForSelector('.found-count:not(.is-loading)', { timeout: 10000 });
    const count = await fView.page.locator('.found-count-main b').innerText();
    assert(count.trim() === '10', `delivered count shown: ${count}`);
    const body = await text(fView.page);
    assert(/khách hàng cho bạn/.test(body) && /Đã có trong danh sách lead của bạn/.test(body), 'success sentence');
    assert(/giữ thêm 4 cơ hội khác/.test(body), 'held-back line');
    const href = await fView.page.getByRole('link', { name: /Xem khách hàng/ }).getAttribute('href');
    assert(href === `/app/bai-viet?nhu-cau=${f.profile}&luot=moi`, `CTA ${href}`);
    await honest(fView.page); await shot(fView.page, 'c1-found-live-1440');
    return `count ${count}`;
  });
  await check('C2 leave and come back: same delivered count, no second batch', async () => {
    await widths(browser, f, '/app/lan-tim-dau', 'c2-found-return', async p => {
      await p.waitForSelector('.found-count:not(.is-loading)', { timeout: 10000 });
      assert((await p.locator('.found-count-main b').innerText()).trim() === '10', 'count changed on return');
    });
    const [{ n }] = await q("SELECT count(*)::int AS n FROM profile_lead_deliveries WHERE search_profile_id = $1 AND state = 'delivered'", [f.profile]);
    assert(n === 10, `delivered rows ${n}`);
  });
  await check('C3 CTA → list opens on the latest delivery: band, 10 rows, start + next one by one', async () => {
    await fView.page.getByRole('link', { name: /Xem khách hàng/ }).click();
    await fView.page.waitForURL(/luot=moi/); await fView.page.waitForLoadState('networkidle');
    const band = await text(fView.page, '.latest-delivery');
    assert(/10 khách hàng mới trong lượt gửi gần nhất/.test(band) && /còn 10 chưa xem/.test(band), band);
    assert(/giữ thêm 4 cơ hội khác/.test(band), `held line in band: ${band}`);
    assert(await fView.page.locator('.lead-table tbody tr').count() === 10, 'rows');
    await honest(fView.page); await shot(fView.page, 'c3-list-latest-1440');
    await fView.page.getByRole('button', { name: 'Bắt đầu xem' }).click();
    await fView.page.waitForSelector('.lead-drawer .drawer-next');
    assert(/đã xem 1\/10/.test(await text(fView.page, '.drawer-next')), await text(fView.page, '.drawer-next'));
    await shot(fView.page, 'c3b-drawer-first-1440');
    await fView.page.getByRole('button', { name: /Khách tiếp theo/ }).click();
    await fView.page.waitForFunction(() => /đã xem 2\/10/.test(document.querySelector('.drawer-next')?.textContent ?? ''));
    await fView.page.keyboard.press('Escape');
    await fView.page.waitForFunction(() => /Đã xem 2\/10/.test(document.querySelector('.latest-delivery')?.textContent ?? ''));
    await shot(fView.page, 'c3c-list-progress-1440');
  });
  await check('C4 "Hiện tất cả lead" keeps history reachable', async () => {
    await fView.page.getByRole('button', { name: 'Hiện tất cả lead' }).click();
    assert(await fView.page.locator('.lead-table tbody tr').count() === 10, 'still the same 10 (no older leads for a new account)');
    await fView.context.close();
  });

  // ── D. Early visit locks an empty delivery cycle (backend gap) → honest "not handed over yet" with the time. ──
  const d = await newUser('locked');
  await check('D1 Today visited while waiting, results land in the same cycle → told when they will arrive', async () => {
    const v = await open(browser, d);
    await goto(v.page, '/app');
    const job = await worker.claim(d.profile);
    await worker.submit(job, Array.from({ length: 6 }, (_, i) => post(i)));
    await noFollowup(d.profile);
    await goto(v.page, '/app/lan-tim-dau');
    await v.page.waitForFunction(() => /bài đăng phù hợp|khách hàng cho bạn/.test(document.querySelector('#first-scan-title')?.textContent ?? ''), null, { timeout: 15000 });
    await v.page.waitForTimeout(1500);
    const t = await title(v.page);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM profile_lead_deliveries WHERE search_profile_id = $1 AND state = 'delivered'", [d.profile]);
    assert(n === 0 ? t === 'QLead đã tìm thấy bài đăng phù hợp' && /được gửi vào danh sách lead từ lúc/.test(await text(v.page)) : true, `title "${t}" with ${n} delivered`);
    assert(await v.page.locator('.found-count').count() === 0 || n > 0, 'a zero count was shown');
    await honest(v.page); await shot(v.page, 'd1-found-not-yet-given-1440'); await v.context.close();
    return `delivered now: ${n} (0 = backend cycle gap reproduced)`;
  });

  // ── E. Retry and failure. ──
  const e = await newUser('retry');
  await check('E1 retryable failure → "đang thử lại", never "đang tìm"', async () => {
    await worker.fail(await worker.claim(e.profile), true);
    const v = await open(browser, e);
    await goto(v.page, '/app/lan-tim-dau');
    assert(await title(v.page) === 'QLead đang thử lại lượt tìm', `title: ${await title(v.page)}`);
    await honest(v.page); await shot(v.page, 'e1-retrying-1440'); await v.context.close();
  });
  const x = await newUser('failed');
  await check('E2 final failure → "chưa hoàn tất", needs kept', async () => {
    await worker.fail(await worker.claim(x.profile), false);
    const v = await open(browser, x);
    await goto(v.page, '/app/lan-tim-dau');
    assert(await title(v.page) === 'Lượt tìm đầu tiên chưa hoàn tất', `title: ${await title(v.page)}`);
    await honest(v.page); await shot(v.page, 'e2-failed-1440'); await v.context.close();
  });
  const z = await newUser('empty');
  await check('E3 nothing found → no count, edit-need CTA', async () => {
    await worker.submit(await worker.claim(z.profile), []);
    await noFollowup(z.profile);
    const v = await open(browser, z);
    await goto(v.page, '/app/lan-tim-dau');
    assert(await v.page.locator('.found-count').count() === 0, 'count shown for zero');
    const t = await title(v.page);
    await honest(v.page); await shot(v.page, 'e3-empty-1440'); await v.context.close();
    return t;
  });

  // ── F. 37 earlier leads + a new delivery of 10: highlight the batch, keep history, missing content/phone. ──
  const h = await newUser('history');
  await check('F1 list with 37 older leads and 10 new: band + markers, nothing hidden, mobile/tablet/desktop', async () => {
    const posts = Array.from({ length: 47 }, (_, i) => post(i, i === 40 ? { content: null, author: null } : i === 41 ? { content: null } : {}));
    await worker.submit(await worker.claim(h.profile), posts);
    await noFollowup(h.profile);
    // The 37 older ones were delivered two days ago (as the migration backfills history); 20 of them were already seen.
    const older = await q<{ id: string }>(`SELECT fp.id FROM facebook_posts fp WHERE fp.agent_connection_id = $1 AND fp.original_url ~ 'p([0-9]|[12][0-9]|3[0-6])$' ORDER BY fp.original_url`, [h.profile]);
    for (const [i, row] of older.entries()) {
      await q("INSERT INTO profile_lead_deliveries(search_profile_id, post_id, state, delivered_at) VALUES ($1, $2, 'delivered', now() - interval '2 days') ON CONFLICT DO NOTHING", [h.profile, row.id]);
      if (i < 20) await q("INSERT INTO lead_states(user_id, post_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [h.userId, row.id, i < 14 ? 'seen' : i < 17 ? 'contacted' : 'interested']);
    }
    await widths(browser, h, '/app/bai-viet', 'f1-list-37-plus-10', async p => {
      const band = await text(p, '.latest-delivery');
      assert(/10 khách hàng mới trong lượt gửi gần nhất/.test(band), band);
      const head = await text(p, '.page-head');
      assert(/47 lead/.test(head), `total ${head}`);
    });
    const [{ n }] = await q("SELECT count(*)::int AS n FROM profile_lead_deliveries WHERE search_profile_id = $1 AND state = 'delivered'", [h.profile]);
    assert(n === 47, `delivered rows ${n}`);
  });
  // Thi (2026-11-11): Today no longer repeats the delivery band; the lead list keeps it.
  await check('F2 Today has no separate delivery band', async () => {
    await widths(browser, h, '/app', 'f2-today-latest', async p => {
      assert(await p.locator('.latest-delivery').count() === 0, 'today band still shown');
    });
  });
  await check('F3 missing content: one quiet line, no repeated chip; phone labelled as from the post', async () => {
    const v = await open(browser, h);
    await goto(v.page, '/app/bai-viet?luot=moi');
    const row = v.page.locator('.lead-table tbody tr', { hasText: 'Chưa trích xuất được nội dung bài này.' }).first();
    assert(await row.count() === 1, 'fallback row missing');
    assert(await row.locator('.content-status').count() === 0, 'duplicate chip on fallback row');
    assert(await v.page.locator('.lead-table th', { hasText: 'SĐT trong bài' }).count() === 1, 'phone column label');
    await row.click();
    await v.page.waitForSelector('.lead-drawer');
    await shot(v.page, 'f3-missing-content-drawer-1440');
    await v.context.close();
  });
} finally {
  const failed = results.filter(r => !r.pass);
  writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ base: BASE, mode: MODE, run: RUN, results, consoleErrors }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${MODE})${consoleErrors.length ? `, ${consoleErrors.length} console errors` : ''}`);
  consoleErrors.slice(0, 8).forEach(line => console.log(`  console: ${line}`));
  await browser.close(); await app.close(); await pool.end();
  process.exitCode = failed.length ? 1 : 0;
}
