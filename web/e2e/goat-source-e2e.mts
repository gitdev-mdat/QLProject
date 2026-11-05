// GOAT mascot lifecycle + source-linked first discovery E2E, on an ISOLATED database (template: muse_bridge_test_discovery).
// Synthetic users get a session row directly; a synthetic worker drives the real worker API in-process (app.inject).
// No Muse, no Facebook, no production data.
// 1. From web/: $env:DATABASE_URL=<…/muse_bridge_test_goat>; $env:QLEAD_DIST_DIR='.next-goat'; npx next dev --webpack -p 3041 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/goat-source-e2e.mts http://localhost:3041
// Optional: ONLY=goat runs the mascot scenarios only.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';

const BASE = process.argv[2] ?? 'http://localhost:3041';
if (!/muse_bridge_test_goat/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_goat.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/goat-source-20261105/screenshots');
mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.ONLY ?? 'all';

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

const OPENING = 'Tôi bán máy pha cà phê, muốn tìm các quán F&B sắp khai trương';
type User = { userId: string; token: string; profile: string; name: string };
async function newUser(tag: string): Promise<User> {
  const name = `Quán F&B sắp mở ${tag}`;
  const [{ id: userId }] = await q('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [`E2E goat ${RUN} ${tag}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['quán cà phê sắp khai trương', 'quán ăn sắp khai trương']), OPENING]);
  await tx(client => enqueueInitialJob(client, profile));
  return { userId, token, profile, name };
}
type Post = { slug: string; author?: string | null; content?: string | null; summary_vi?: string | null; published?: boolean };
const url = (slug: string) => `https://www.facebook.com/groups/e2e-goat/posts/${RUN}${slug.replace(/\W/g, '')}`;
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
      posts: posts.map(p => ({ url: url(p.slug), author: p.author === undefined ? `Quán ${p.slug}` : p.author,
        content: p.content === undefined ? `Quán ${p.slug} sắp khai trương, đang tìm máy pha cà phê.` : p.content, summary_vi: p.summary_vi ?? null,
        published_at: p.published === false ? null : new Date(Date.now() - 3600_000).toISOString(), collected_via: 'controlled_fixture' })),
      stats: { total_found: posts.length + 4 }, errors: [] } });
    if (r.statusCode !== 200) throw new Error(`submit ${r.statusCode} ${r.body}`);
    return r.json();
  },
};
const api = async (p: Page) => p.evaluate(async () => (await (await fetch('/api/first-scan', { cache: 'no-store' })).json()).scan);

/**
 * The mascot is "visible" when either the static goat is painted (loaded, not hidden) or a live Lottie SVG with a
 * real box is in the mascot. Returns a short description of what is on screen, or throws for a blank circle.
 */
async function goat(p: Page, scope = '.discovery-scene'): Promise<string> {
  const state = await p.locator(`${scope} .goat-mascot`).first().evaluate(el => {
    const img = el.querySelector<HTMLImageElement>('.goat-static')!;
    const svg = el.querySelector<SVGSVGElement>('.goat-anim svg');
    const box = el.getBoundingClientRect();
    const svgBox = svg?.getBoundingClientRect();
    return {
      playing: el.classList.contains('is-playing'), w: Math.round(box.width), h: Math.round(box.height),
      img: { visibility: getComputedStyle(img).visibility, display: getComputedStyle(img).display, loaded: img.complete && img.naturalWidth > 0 },
      svg: svg ? { w: Math.round(svgBox!.width), paths: svg.querySelectorAll('path').length } : null,
      opacity: Number(getComputedStyle(el).opacity),
    };
  });
  assert(state.w > 20 && state.h > 20 && state.opacity > 0.2, `mascot box ${JSON.stringify(state)}`);
  const staticShown = state.img.visibility === 'visible' && state.img.display !== 'none' && state.img.loaded;
  const animShown = state.playing && state.svg && state.svg.w > 20 && state.svg.paths > 0;
  assert(staticShown || animShown, `BLANK GOAT ${JSON.stringify(state)}`);
  return animShown ? 'lottie' : 'static';
}
/** Samples the mascot repeatedly (every 150ms) so a blank frame between two states cannot slip through. */
async function goatStaysVisible(p: Page, ms: number, scope?: string) {
  const seen = new Set<string>();
  const until = Date.now() + ms;
  while (Date.now() < until) { seen.add(await goat(p, scope)); await pause(150); }
  return [...seen].join('+');
}

const consoleErrors: string[] = [];
async function open(browser: Browser, user: User, width = 1440, opts: { reducedMotion?: 'reduce' | 'no-preference'; blockLottie?: boolean } = {}): Promise<{ context: BrowserContext; page: Page; lottieRequests: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion: opts.reducedMotion ?? 'no-preference' });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  const lottieRequests: string[] = [];
  if (opts.blockLottie) await context.route('**/brand/qlead-goat.json', route => route.abort('failed'));
  const page = await context.newPage();
  page.on('request', r => { if (r.url().includes('/brand/qlead-goat')) lottieRequests.push(r.url().replace(BASE, '')); });
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return { context, page, lottieRequests };
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial', animations: 'disabled' });
const title = (p: Page) => p.locator('#first-scan-title').innerText();
const text = async (p: Page, selector = 'main') => (await p.locator(selector).first().innerText()).replace(/\s+/g, ' ');
async function goto(p: Page, path: string) { await p.goto(`${BASE}${path}`).catch(() => p.goto(`${BASE}${path}`)); await p.waitForLoadState('networkidle'); }
async function noOverflow(p: Page) {
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
}
const FORBIDDEN = /\b(job|worker|queue|lease|Muse|scan_runs|usable_new_posts|configuration_version)\b|\d+\s?%/i;
async function honest(p: Page) {
  const body = await text(p, 'body');
  const bad = body.match(FORBIDDEN);
  assert(!bad, `internal or fake-progress wording: "${bad?.[0]}"`);
  await noOverflow(p);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");
  await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at) VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`E2E goat ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]);

  // ── G: the mascot through every transition (the production bug: running → waiting left an empty circle) ──
  const g = await newUser('g');
  const vg = await open(browser, g);
  let job: any; let followup: any;
  await check('G1 queued: static goat visible', async () => {
    await goto(vg.page, '/app/lan-tim-dau');
    return `${await title(vg.page)} · ${await goatStaysVisible(vg.page, 1200)}`;
  });
  await check('G2 queued → running (live poll): goat never blank, Lottie starts', async () => {
    job = await worker.claim(g.profile);
    await vg.page.locator('#first-scan-title', { hasText: 'QLead đang tìm bài đăng phù hợp' }).waitFor({ timeout: 15000 });
    const seen = await goatStaysVisible(vg.page, 2500);
    assert(seen.includes('lottie'), `Lottie never played while searching (${seen})`);
    await shot(vg.page, 'g2-running-1440');
    return seen;
  });
  await check('G3 running → waiting for the extra search (live poll): the exact production transition, goat stays', async () => {
    const ack = await worker.submit(job, []);
    assert(ack.early_followup_queued === true, `followup not queued: ${JSON.stringify(ack)}`);
    await vg.page.locator('#first-scan-title', { hasText: 'QLead sẽ tiếp tục tìm thêm' }).waitFor({ timeout: 15000 });
    const seen = await goatStaysVisible(vg.page, 2500);
    assert(seen === 'static', `expected the still goat while only waiting, saw ${seen}`);
    assert(await vg.page.locator('.discovery-scene .goat-anim svg').count() === 0, 'stale Lottie SVG left in the mascot');
    await shot(vg.page, 'g3-waiting-after-running-1440');
    return seen;
  });
  await check('G4 waiting → extra search running → results (live poll): goat visible throughout, one Lottie instance', async () => {
    await q("UPDATE search_jobs SET scheduled_for = now(), available_at = now() WHERE search_profile_id = $1 AND kind = 'followup' AND status = 'pending'", [g.profile]);
    followup = await worker.claim(g.profile);
    await vg.page.locator('#first-scan-title', { hasText: 'QLead đang tìm thêm' }).waitFor({ timeout: 20000 });
    const a = await goatStaysVisible(vg.page, 1500);
    await worker.submit(followup, [{ slug: 'g-a' }, { slug: 'g-b' }]);
    await vg.page.locator('#first-scan-title', { hasText: 'QLead đã tìm thấy cơ hội cho bạn!' }).waitFor({ timeout: 20000 });
    const b = await goatStaysVisible(vg.page, 2500);
    const svgs = await vg.page.locator('.discovery-scene .goat-anim svg').count();
    assert(svgs <= 1, `${svgs} Lottie SVGs in one mascot`);
    await shot(vg.page, 'g4-results-1440');
    return `running ${a}; results ${b}`;
  });
  await check('G5 results → refresh: goat visible, no celebration replay', async () => {
    await vg.page.reload(); await vg.page.waitForLoadState('networkidle');
    assert(await vg.page.locator('.first-scan-confetti').count() === 0, 'confetti replayed on refresh');
    return goatStaysVisible(vg.page, 1500);
  });
  await check('G6 Lottie JSON fails to load: static goat stays, no error', async () => {
    const v = await open(browser, g, 1440, { blockLottie: true });
    await goto(v.page, '/app/lan-tim-dau');
    const seen = await goatStaysVisible(v.page, 2000);
    assert(seen === 'static', seen);
    await v.context.close();
    return `${seen} · requests ${v.lottieRequests.join(', ')}`;
  });
  await check('G7 reduced motion: static goat, Lottie never requested', async () => {
    const v = await open(browser, g, 1440, { reducedMotion: 'reduce' });
    await goto(v.page, '/app/lan-tim-dau');
    const seen = await goatStaysVisible(v.page, 1500);
    assert(seen === 'static', seen);
    assert(!v.lottieRequests.some(r => r.endsWith('.json')), `Lottie requested: ${v.lottieRequests}`);
    await v.context.close();
    return seen;
  });
  await check('G8 refresh while the goat animates (running): no blank frame', async () => {
    const h = await newUser('h'); const v = await open(browser, h);
    const hJob = await worker.claim(h.profile);
    await goto(v.page, '/app/lan-tim-dau');
    await pause(800);
    await v.page.reload();
    const seen = await goatStaysVisible(v.page, 2000);
    await worker.submit(hJob, [{ slug: 'h-a' }]); // frees the synthetic worker for the next scenario
    await v.context.close();
    return seen;
  });
  await check('L1 complete leads: every card has the stored Facebook link, opening it never opens the lead (390/768/1440)', async () => {
    const stored = (await q('SELECT original_url FROM facebook_posts WHERE agent_connection_id = $1', [g.profile])).map(r => r.original_url);
    for (const w of [1440, 768, 390]) {
      await vg.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 });
      await goto(vg.page, '/app/bai-viet');
      const links = vg.page.locator(w >= 1080 ? '.lead-table .fb-link' : '.lead-cards .fb-link');
      const hrefs = await links.evaluateAll(els => els.map(el => [el.getAttribute('href'), el.getAttribute('target'), el.getAttribute('rel')]));
      assert(hrefs.length === stored.length && hrefs.every(([h, t, r]) => stored.includes(h) && t === '_blank' && r?.includes('noopener')), `${w}: ${JSON.stringify(hrefs)}`);
      const [popup] = await Promise.all([vg.page.context().waitForEvent('page'), links.first().click()]);
      await popup.close();
      assert(new URL(vg.page.url()).pathname === '/app/bai-viet' && await vg.page.locator('.lead-drawer').count() === 0, `${w}: clicking the Facebook link opened the lead`);
      await honest(vg.page);
      await shot(vg.page, `l1-list-complete-${w}`);
      await goto(vg.page, '/app');
      await honest(vg.page);
      await shot(vg.page, `l1-today-${w}`);
    }
    await vg.page.setViewportSize({ width: 1440, height: 1000 });
    return `${stored.length} links`;
  });
  await vg.context.close();

  if (ONLY !== 'goat') {
    // ── S: source-linked opportunities without extracted text (needs the backend eligibility change) ──
    const s = await newUser('s');
    const vs = await open(browser, s);
    await check('S1 initial discovery stores 10 source-linked posts without title/content → success, not "no results"', async () => {
      const j = await worker.claim(s.profile);
      const posts: Post[] = Array.from({ length: 10 }, (_, i) => ({ slug: `s-${i}`, content: null, author: i === 3 ? null : `Trang ${i}`, published: i % 4 !== 0 }));
      const ack = await worker.submit(j, posts);
      await goto(vs.page, '/app/lan-tim-dau');
      const t = await title(vs.page);
      const scan = await api(vs.page);
      assert(t === 'QLead đã tìm thấy cơ hội cho bạn!', `title "${t}" · discovery ${JSON.stringify(scan.discovery?.status)} initialUsable=${scan.discovery?.initialUsablePosts} ack=${JSON.stringify(ack).slice(0, 160)}`);
      assert(!(await text(vs.page)).includes('chưa thấy bài đăng phù hợp'), 'false-zero copy');
      await vs.page.locator('.first-scan-confetti').waitFor({ state: 'attached', timeout: 3000 });
      const count = await text(vs.page, '.found-count');
      assert(count.startsWith('10 cơ hội mới') && !count.includes('chưa có đủ thông tin'), count);
      await goat(vs.page);
      await vs.page.locator('.first-scan-confetti').waitFor({ state: 'detached', timeout: 5000 });
      await vs.page.reload(); await vs.page.waitForLoadState('networkidle'); await pause(800);
      assert(await vs.page.locator('.first-scan-confetti').count() === 0, 'celebration replayed after refresh');
      for (const w of [390, 768, 1440]) { await vs.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vs.page); await shot(vs.page, `s1-found-incomplete-${w}`); }
      return `count ${(await text(vs.page, '.found-count'))}`;
    });
    await check('S2 lead list shows all 10 with "Chưa trích xuất nội dung" and the exact stored Facebook link', async () => {
      await goto(vs.page, `/app/bai-viet?nhu-cau=${s.profile}`);
      const rows = vs.page.locator('.lead-table tbody tr');
      assert(await rows.count() === 10, `rows ${await rows.count()}`);
      const hrefs = await vs.page.locator('.lead-table .fb-link').evaluateAll(els => els.map(el => el.getAttribute('href')));
      const stored = (await q('SELECT original_url FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.id = $1', [s.profile])).map(r => r.original_url);
      assert(hrefs.every(h => stored.includes(h)), `link not from backend: ${hrefs.find(h => !stored.includes(h))}`);
      assert(await vs.page.locator('.lead-table .content-status').count() === 10, 'data status chip');
      assert((await text(vs.page)).includes('Bài đăng Facebook'), 'neutral author fallback');
      for (const w of [1440, 768, 390]) { await vs.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vs.page); await shot(vs.page, `s2-list-incomplete-${w}`); }
      return `${hrefs.length} links`;
    });
    await check('S3 Today count matches the lead list and the first-scan count', async () => {
      await vs.page.setViewportSize({ width: 1440, height: 1000 });
      await goto(vs.page, '/app');
      const unseen = Number(await vs.page.locator('.summary-row dd').first().innerText());
      const scan = await api(vs.page);
      await goto(vs.page, '/app/bai-viet');
      const listed = await vs.page.locator('.lead-table tbody tr').count();
      assert(unseen === 10 && listed === 10 && scan.discovery.totalSourceLinkedPosts === 10, `today ${unseen}, list ${listed}, first scan ${scan.discovery.totalSourceLinkedPosts}`);
      await goto(vs.page, '/app');
      await shot(vs.page, 's3-today-1440');
    });
    await check('S4 lead detail without text: honest note, primary "Xem bài Facebook", no publication time invented', async () => {
      const [{ id }] = await q("SELECT fp.id FROM facebook_posts fp WHERE fp.agent_connection_id = $1 AND fp.published_at IS NULL LIMIT 1", [s.profile]);
      await goto(vs.page, `/app/bai-viet/${id}`);
      const body = await text(vs.page);
      assert(body.includes('Nội dung bài đăng chưa được trích xuất') && body.includes('Chưa rõ giờ đăng'), body.slice(0, 300));
      const href = await vs.page.locator('.lead-post-missing .fb-link').getAttribute('href');
      assert(href?.startsWith('https://www.facebook.com/groups/e2e-goat/'), `${href}`);
      for (const w of [390, 768, 1440]) { await vs.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vs.page); await shot(vs.page, `s4-detail-incomplete-${w}`); }
    });
    await check('S5 the same URL found by a second search: still 10 leads, shown once with both searches', async () => {
      const [{ id: second }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Nhà hàng mới mở', 'search_profile') RETURNING id", [s.userId]);
      await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
        VALUES ($1, 1, true, '["nhà hàng mới mở"]', 'description', '', '["social.search"]', 30, 'Nhà hàng mới mở')`, [second]);
      await tx(client => enqueueInitialJob(client, second));
      const j = await worker.claim(second);
      await worker.submit(j, [{ slug: 's-0', content: null, author: 'Trang 0' }]);
      await vs.page.setViewportSize({ width: 1440, height: 1000 });
      await goto(vs.page, '/app/bai-viet');
      const rows = await vs.page.locator('.lead-table tbody tr').count();
      const both = await vs.page.locator('.lead-table .lead-source', { hasText: '+1 nhu cầu' }).count();
      assert(rows === 10 && both === 1, `rows ${rows}, shared ${both}`);
      await goto(vs.page, '/app');
      const unseen = Number(await vs.page.locator('.summary-row dd').first().innerText());
      // S4 opened one lead, so Today's "Chưa xem" is 9; the list still has all 10 (and its header says so).
      assert(unseen === 9, `Today unseen ${unseen}`);
      await goto(vs.page, '/app/bai-viet');
      assert((await text(vs.page, '.page-head')).includes('10 lead · 9 chưa xem'), await text(vs.page, '.page-head'));
      return `${rows} leads`;
    });
    await vs.context.close();

    // ── F: early follow-up adds one more; a URL it finds again is not counted twice ──
    const f = await newUser('f');
    const vf = await open(browser, f);
    await check('F1 initial finds 1 → follow-up planned; follow-up re-finds it + 1 new → "2 cơ hội mới", split 1 + 1', async () => {
      const j = await worker.claim(f.profile);
      const ack = await worker.submit(j, [{ slug: 'f-a' }]);
      assert(ack.early_followup_queued === true, `followup ${JSON.stringify(ack).slice(0, 200)}`);
      await goto(vf.page, '/app/lan-tim-dau');
      assert(await title(vf.page) === 'QLead đã tìm thấy cơ hội cho bạn!', await title(vf.page));
      assert((await text(vf.page, '.discovery-line')).includes('QLead sẽ tiếp tục tìm thêm'), 'planned line');
      await goat(vf.page);
      await shot(vf.page, 'f1-found-followup-planned-1440');
      await q("UPDATE search_jobs SET scheduled_for = now(), available_at = now() WHERE search_profile_id = $1 AND kind = 'followup' AND status = 'pending'", [f.profile]);
      const fj = await worker.claim(f.profile);
      await vf.page.reload(); await vf.page.waitForLoadState('networkidle');
      assert((await text(vf.page, '.discovery-line')).includes('QLead đang tìm thêm'), 'running line');
      await worker.submit(fj, [{ slug: 'f-a' }, { slug: 'f-b' }]);
      await vf.page.locator('.found-count-main', { hasText: '2' }).waitFor({ timeout: 20000 });
      const count = await text(vf.page, '.found-count');
      assert(count.startsWith('2 cơ hội mới') && count.includes('1 từ lượt đầu · 1 tìm thêm'), count);
      assert((await text(vf.page, '.discovery-line')).includes('QLead sẽ tiếp tục theo dõi'), 'monitoring line');
      await goat(vf.page);
      for (const w of [390, 768, 1440]) { await vf.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vf.page); await shot(vf.page, `f1-found-after-followup-${w}`); }
      await vf.page.setViewportSize({ width: 1440, height: 1000 });
      await goto(vf.page, '/app/bai-viet');
      const rows = await vf.page.locator('.lead-table tbody tr').count();
      const scan = await api(vf.page);
      assert(rows === 2 && scan.discovery.totalSourceLinkedPosts === 2, `list ${rows}, api ${scan.discovery.totalSourceLinkedPosts}`);
      return count;
    });
    await vf.context.close();

    // ── V: Vietnamese-first lead text ──
    const v = await newUser('v');
    const vv = await open(browser, v);
    const EN = "Advertisement for Hontil Homestay announcing its grand opening ('Khai truong') on November 2, 2026, with a 15% discount for early guests.";
    const VI = 'Quán cà phê Mộc sắp khai trương ở Thủ Đức, đang cần tìm máy pha cà phê và phần mềm bán hàng.';
    await check('V1 list previews are Vietnamese: original Vietnamese quoted, English description replaced by a Vietnamese line', async () => {
      const j = await worker.claim(v.profile);
      await worker.submit(j, [
        { slug: 'v-vi', author: 'Quán cà phê Mộc', content: VI },
        { slug: 'v-en', author: 'Hontil Homestay', content: EN },
        { slug: 'v-none', author: null, content: null },
        { slug: 'v-sum', author: 'Nhà hàng Sen', content: 'Photo of a restaurant banner announcing the opening of a second branch in District 7 next week.', summary_vi: 'Nhà hàng Sen thông báo sắp mở chi nhánh thứ hai ở Quận 7 vào tuần tới.' },
        { slug: 'v-notime', author: 'Bếp Nhà Mây', content: 'Bếp Nhà Mây mới mở chi nhánh 2, tuyển nhân viên phục vụ.', published: false },
      ]);
      for (const w of [1440, 768, 390]) {
        await vv.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 });
        await goto(vv.page, '/app/bai-viet');
        const list = await text(vv.page);
        assert(!/Advertisement|announcing|Photo of/i.test(list), `${w}: English description shown by default`);
        assert(list.includes('máy pha cà phê') && list.includes('QLead đã ghi nhận bài đăng này. Mở Facebook để xem nội dung gốc.'), `${w}: previews ${list.slice(0, 300)}`);
        assert(list.includes('Chưa có tóm tắt tiếng Việt') && list.includes('Chưa trích xuất nội dung'), `${w}: status chips`);
        assert(list.includes('QLead tóm tắt') && list.includes('sắp mở chi nhánh thứ hai'), `${w}: summary preview`);
        assert(list.includes('Tìm thấy'), `${w}: discovery time label for the post without a time`);
        await honest(vv.page);
        await shot(vv.page, `v1-list-vietnamese-${w}`);
      }
    });
    await check('V2 search finds Vietnamese text and the stored English text; filters still work', async () => {
      await vv.page.setViewportSize({ width: 1440, height: 1000 });
      await goto(vv.page, '/app/bai-viet');
      const search = vv.page.getByRole('searchbox', { name: 'Tìm lead' });
      await search.fill('máy pha');
      assert(await vv.page.locator('.lead-table tbody tr').count() === 1, 'Vietnamese search');
      await search.fill('Hontil');
      assert(await vv.page.locator('.lead-table tbody tr').count() === 1, 'search over stored original text');
      await search.fill('chi nhánh thứ hai');
      assert(await vv.page.locator('.lead-table tbody tr').count() === 1, 'search over the Vietnamese summary');
      await search.fill('không có gì khớp');
      assert(await vv.page.locator('.lead-table tbody tr').count() === 0 && (await text(vv.page)).includes('Không có lead khớp bộ lọc'), 'empty filter state');
      await search.fill('');
      return `${await vv.page.locator('.lead-table tbody tr').count()} rows after clearing`;
    });
    await check('V3 detail of the English description: Vietnamese line first, English only under "Xem nội dung gốc" (closed), labelled', async () => {
      const [{ id }] = await q("SELECT id FROM facebook_posts WHERE agent_connection_id = $1 AND content LIKE 'Advertisement%'", [v.profile]);
      await goto(vv.page, `/app/bai-viet/${id}`);
      const details = vv.page.locator('details.lead-stored');
      assert(await details.count() === 1 && !(await details.evaluate(el => (el as HTMLDetailsElement).open)), 'stored text not collapsed');
      assert(!(await vv.page.locator('blockquote', { hasText: 'Advertisement' }).isVisible()), 'English visible before opening');
      await details.locator('summary').click();
      assert(await vv.page.locator('blockquote[lang="en"]', { hasText: 'Hontil' }).isVisible(), 'English after opening');
      assert((await text(vv.page, 'details.lead-stored')).includes('chưa dịch'), 'label');
      for (const w of [390, 768, 1440]) { await vv.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vv.page); await shot(vv.page, `v3-detail-english-${w}`); }
    });
    await check('V4 detail of a Vietnamese post: quoted as "Nội dung trên Facebook", missing time stays unknown', async () => {
      const [{ id }] = await q("SELECT id FROM facebook_posts WHERE agent_connection_id = $1 AND published_at IS NULL", [v.profile]);
      await vv.page.setViewportSize({ width: 1440, height: 1000 });
      await goto(vv.page, `/app/bai-viet/${id}`);
      const body = await text(vv.page);
      assert(body.includes('Nội dung trên Facebook') && body.includes('Chưa rõ giờ đăng') && body.includes('QLead tìm thấy lúc'), body.slice(0, 300));
      assert(await vv.page.locator('details.lead-stored').count() === 0, 'nothing extra for Vietnamese text');
      await shot(vv.page, 'v4-detail-vietnamese-1440');
    });
    await check('V4b detail with a Vietnamese summary: labelled "QLead tóm tắt" (not a quote), English original collapsed', async () => {
      const [{ id }] = await q("SELECT id FROM facebook_posts WHERE agent_connection_id = $1 AND summary_vi IS NOT NULL", [v.profile]);
      await goto(vv.page, `/app/bai-viet/${id}`);
      const summary = await text(vv.page, '.lead-summary');
      assert(summary.startsWith('QLead tóm tắt') && summary.includes('Quận 7') && summary.includes('không phải lời của người đăng'), summary);
      assert(await vv.page.locator('blockquote', { hasText: 'Quận 7' }).count() === 0, 'summary shown as a quote');
      assert(!(await vv.page.locator('details.lead-stored').evaluate(el => (el as HTMLDetailsElement).open)), 'original open by default');
      for (const w of [390, 768, 1440]) { await vv.page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(vv.page); await shot(vv.page, `v4b-detail-summary-${w}`); }
      await vv.page.setViewportSize({ width: 1440, height: 1000 });
    });
    await check('V5 another customer cannot open these leads', async () => {
      const other = await newUser('o');
      const vo = await open(browser, other);
      const [{ id }] = await q('SELECT id FROM facebook_posts WHERE agent_connection_id = $1 LIMIT 1', [v.profile]);
      await goto(vo.page, `/app/bai-viet/${id}`);
      const body = await text(vo.page);
      await goto(vo.page, '/app/bai-viet');
      const list = await text(vo.page);
      await vo.context.close();
      assert(body.includes('Không tìm thấy lead') && !list.includes('Hontil') && !list.includes('Mộc'), 'cross-tenant leak');
    });
    await vv.context.close();
  }
} finally {
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (consoleErrors.length) console.log(`console errors:\n${consoleErrors.join('\n')}`);
  writeFileSync(resolve(SHOTS, '..', 'results.json'), JSON.stringify({ base: BASE, results, consoleErrors }, null, 2));
  await pool.end();
  await app.close();
}
