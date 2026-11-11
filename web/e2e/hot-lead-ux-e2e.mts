// Hot Lead, "Không quan tâm" and overnight quiet hours — browser QA on an ISOLATED database (migrations 001–025).
// Synthetic users get a session row directly; a synthetic worker drives the real worker API in-process (app.inject),
// so Hot classification and delivery are Codex's backend code, not fixtures. No Muse, no Facebook, no Production.
// 1. From web/: $env:DATABASE_URL='postgres://muse:<pw>@127.0.0.1:55432/muse_bridge_test_hot'; $env:QLEAD_DIST_DIR='.next-hot'
//    npx next dev --webpack -p 3071 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/hot-lead-ux-e2e.mts http://localhost:3071
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';

const BASE = process.argv[2] ?? 'http://localhost:3071';
if (!/muse_bridge_test_hot\b/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_hot.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/hot-lead-ux-20261111/screenshots');
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const RUN = randomBytes(4).toString('hex');
const workerToken = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${workerToken}` };
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0]! }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const tx = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await work(client); await client.query('COMMIT'); return out; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};

type User = { userId: string; token: string; profile: string };
async function newUser(tag: string): Promise<User> {
  const [{ id: userId }] = await q("INSERT INTO users(display_name) VALUES ($1) RETURNING id", [`E2E hot ${RUN} ${tag}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, 'Quán F&B sắp khai trương']);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['phần mềm bán hàng', 'quán cà phê sắp khai trương']), 'Tôi đang bán phần mềm quản lý, tính tiền và muốn tìm các quán F&B sắp khai trương.']);
  await tx(client => enqueueInitialJob(client, profile));
  return { userId, token, profile };
}

type Post = { slug: string; author?: string | null; content: string; minutesAgo: number | null };
const HOT = (i: number, author: string | null = `Quán Mộc ${i}`): Post => ({ slug: `h${i}`, author, minutesAgo: 10 + i * 5,
  content: `Quán cà phê sắp khai trương ở Quận ${i}, đang cần tìm phần mềm bán hàng và máy tính tiền. Ai cung cấp inbox giúp mình.` });
const PLAIN = (i: number): Post => ({ slug: `o${i}`, author: `Nhà hàng Lá ${i}`, minutesAgo: 60 * 30 + i,
  content: `Nhà hàng mình sắp khai trương chi nhánh mới ở Thủ Đức, quán cà phê sắp khai trương tuần sau. Chia sẻ kinh nghiệm phần mềm bán hàng ${i}.` });
const url = (job: any, p: Post) => `https://www.facebook.com/groups/e2ehot${RUN}/posts/${job.job_id.slice(0, 6)}${p.slug}`;
async function deliver(user: User, posts: Post[]) {
  let r = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: user.profile } });
  const job = r.json().jobs?.[0];
  if (!job) throw new Error(`no job to claim: ${r.body}`);
  r = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
    keywords_used: job.search.keywords, sources_used: job.search.sources,
    posts: posts.map(p => ({ url: url(job, p), ...(p.author ? { author: p.author } : {}), content: p.content,
      ...(p.minutesAgo === null ? {} : { published_at: new Date(Date.now() - p.minutesAgo * 60_000).toISOString() }), collected_via: 'controlled_fixture' })),
    stats: { total_found: posts.length }, errors: [] } });
  if (r.statusCode !== 200) throw new Error(`submit ${r.statusCode} ${r.body}`);
}
const leadsOf = (userId: string) => q<{ id: string; author: string | null; hot: boolean; expires: Date | null }>(`SELECT fp.id, fp.author, d.hot_at_discovery AS hot, d.hot_expires_at AS expires
  FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id JOIN profile_lead_deliveries d ON d.post_id = fp.id
  WHERE ac.user_id = $1 AND d.state = 'delivered' ORDER BY fp.published_at DESC NULLS LAST`, [userId]);

let browser: Browser;
async function as(user: User, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', ...opts });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  return { context, page: await context.newPage() };
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
const settle = (page: Page) => page.waitForLoadState('networkidle').catch(() => undefined);
const vnInstant = (hh: number, mm: number) => { const d = new Date(); const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d); return new Date(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`); };

async function main() {
  await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at) VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`E2E hot ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]);
  const one = await newUser('one'), many = await newUser('many'), zero = await newUser('zero'), held = await newUser('held');
  await deliver(one, [HOT(1), PLAIN(1), PLAIN(2)]);
  await deliver(many, [HOT(1), HOT(2), HOT(3), HOT(4, null), PLAIN(1)]);
  await deliver(zero, [PLAIN(1), PLAIN(2), PLAIN(3)]);
  await deliver(held, [HOT(1), PLAIN(1)]);
  const oneLeads = await leadsOf(one.userId), manyLeads = await leadsOf(many.userId), zeroLeads = await leadsOf(zero.userId);
  const oneHot = oneLeads.find(l => l.hot)!;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  await check('Backend: Codex classifier marked only fresh intent posts Hot', async () => {
    assert(oneLeads.filter(l => l.hot).length === 1 && manyLeads.filter(l => l.hot).length === 4 && zeroLeads.every(l => !l.hot), JSON.stringify({ one: oneLeads.map(l => l.hot), many: manyLeads.map(l => l.hot), zero: zeroLeads.map(l => l.hot) }));
    return `one=1 Hot/${oneLeads.length}, many=4 Hot/${manyLeads.length}, zero=0/${zeroLeads.length}`;
  });

  // 1. One Hot Lead: Today band, list tag, detail callout, celebration once.
  await check('S1 one Hot Lead on Today + celebration once', async () => {
    const { context, page } = await as(one);
    await page.goto(`${BASE}/app`); await settle(page);
    const band = page.locator('.hot-band');
    await band.waitFor({ timeout: 15000 });
    assert(/Có 1 Hot Lead nên xem ngay/.test(await band.innerText()), 'band title');
    assert(await page.locator('.hot-band.is-celebrating').count() === 1, 'first visit celebrates');
    assert(await band.getByRole('link', { name: /Xem bài Facebook/ }).count() === 1, 'FB action');
    await shot(page, 'today-one-hot-1440');
    await page.reload(); await settle(page); await band.waitFor();
    await page.waitForTimeout(400);
    assert(await page.locator('.hot-band.is-celebrating').count() === 0, 'no replay on refresh');
    await page.getByRole('link', { name: 'Danh sách lead' }).first().click(); await page.waitForURL(/bai-viet/); await settle(page);
    assert(await page.locator('.hot-band.is-celebrating').count() === 0, 'no replay on route change');
    await context.close();
    return 'celebrated on first view only';
  });

  await check('S1 list tag + detail shows reason, publish time, FB action', async () => {
    const { context, page } = await as(one);
    await page.goto(`${BASE}/app/bai-viet`); await settle(page);
    assert(await page.locator('tr.is-hot').count() === 1, 'one hot row');
    assert(await page.locator('tr:not(.is-hot) .hot-tag').count() === 0, 'ordinary rows untagged');
    await shot(page, 'list-one-hot-1440');
    await page.goto(`${BASE}/app/bai-viet/${oneHot.id}`); await settle(page);
    const callout = page.locator('.hot-callout');
    await callout.waitFor();
    const text = await callout.innerText();
    assert(/Khách hàng đang có nhu cầu rõ ràng/.test(text) && /Bài đăng còn mới/.test(text) && /Đăng \d+ phút trước/.test(text) && /Nên liên hệ trước \d\d:\d\d/.test(text), text);
    assert(await page.getByRole('link', { name: /Xem bài Facebook/ }).count() >= 1, 'FB link');
    assert(await page.getByRole('radio', { name: 'Không quan tâm' }).count() === 1, 'status picker kept');
    await shot(page, 'detail-hot-1440');
    await context.close();
    return text.replace(/\s+/g, ' ').slice(0, 140);
  });

  // 2. Several Hot Leads + 4. limited metadata (no author)
  await check('S2+S4 several Hot Leads: band shows 3 + link, chip filters, no-author Hot renders', async () => {
    const { context, page } = await as(many);
    await page.goto(`${BASE}/app/bai-viet`); await settle(page);
    const band = page.locator('.hot-band'); await band.waitFor();
    assert(/Có 4 Hot Lead/.test(await band.innerText()), 'count 4');
    assert(await band.locator('.hot-row').count() === 3, 'three rows');
    assert(await band.getByRole('link', { name: /Xem cả 4 Hot Lead/ }).count() === 1, 'more link');
    await page.getByRole('button', { name: 'Hot Lead (4)' }).click();
    assert(await page.locator('tbody tr').count() === 4, 'filter shows 4 rows');
    assert(await page.locator('.hot-band').count() === 0, 'band hidden while filtering');
    await page.goto(`${BASE}/app/bai-viet?hot=1`); await settle(page);
    assert(await page.locator('tbody tr').count() === 4, '?hot=1 opens filtered');
    assert(await page.getByText('Bài đăng Facebook').count() >= 1, 'no-author fallback name');
    await shot(page, 'list-many-hot-filter-1440');
    await context.close();
  });

  // 3. Zero Hot Leads: no band, chip, counts or Hot wording anywhere.
  await check('S3 zero Hot Leads: nothing Hot is shown', async () => {
    const { context, page } = await as(zero);
    for (const path of ['/app', '/app/bai-viet']) {
      await page.goto(`${BASE}${path}`); await settle(page);
      const body = await page.locator('main, body').first().innerText();
      assert(!/Hot Lead/.test(body), `${path} mentions Hot`);
    }
    await context.close();
  });

  // 5. Publication time unavailable (forced in DB; the backend never classifies such a post Hot itself).
  await check('S5 Hot Lead without publish time says "Chưa rõ giờ đăng"', async () => {
    await q('UPDATE facebook_posts SET published_at = NULL WHERE id = $1', [oneHot.id]);
    const { context, page } = await as(one);
    await page.goto(`${BASE}/app/bai-viet/${oneHot.id}`); await settle(page);
    const t = await page.locator('.hot-callout, .hot-past').first().innerText().catch(() => '');
    await context.close();
    const [row] = await q("SELECT published_at FROM facebook_posts WHERE id=$1", [oneHot.id]);
    await q("UPDATE facebook_posts SET published_at = now() - interval '15 minutes' WHERE id = $1", [oneHot.id]);
    assert(row.published_at === null, 'reset');
    assert(!t || /Chưa rõ giờ đăng/.test(t) || /Từng là Hot Lead/.test(t), t);
    return t ? t.replace(/\s+/g, ' ').slice(0, 90) : 'server dropped Hot (no publish time)';
  });

  // 6. Expiry: on an open page (client clock passes expiresAt) and after the server window ends.
  await check('S6 Hot label disappears at expiresAt on an open page, then reads as past Hot', async () => {
    const { context, page } = await as(one);
    await page.clock.install({ time: new Date() });
    await page.goto(`${BASE}/app/bai-viet`); await settle(page);
    assert(await page.locator('tr.is-hot').count() === 1, 'hot before');
    await page.clock.fastForward(2 * 60 * 60_000 + 60_000);
    await page.waitForTimeout(300);
    assert(await page.locator('tr.is-hot').count() === 0 && await page.locator('.hot-band').count() === 0, 'still hot after expiry');
    await context.close();
    await q("UPDATE profile_lead_deliveries SET hot_expires_at = now() - interval '1 minute' WHERE post_id = $1", [oneHot.id]);
    const second = await as(one);
    await second.page.goto(`${BASE}/app/bai-viet/${oneHot.id}`); await settle(second.page);
    const past = await second.page.locator('.hot-past').innerText();
    await second.context.close();
    await q("UPDATE profile_lead_deliveries SET hot_expires_at = now() + interval '90 minutes' WHERE post_id = $1", [oneHot.id]);
    return past;
  });

  // 7. Notification click: the SW builds a Hot notification with its own tag and opens /mo → the right lead.
  await check('S7 sw.js shows a distinct Hot notification and its click opens the lead', async () => {
    const shown: any[] = []; const handlers: Record<string, (e: any) => void> = {};
    const self: any = { addEventListener: (t: string, f: any) => { handlers[t] = f; }, location: { origin: BASE },
      registration: { showNotification: async (title: string, o: any) => { shown.push({ title, ...o }); } },
      clients: { matchAll: async () => [] , openWindow: async (u: string) => { shown.push({ opened: u }); } } };
    vm.runInNewContext(readFileSync(resolve('web/public/sw.js'), 'utf8'), { self, URL, btoa, fetch, console });
    const wait: Promise<unknown>[] = [];
    const payload = { v: 1, kind: 'hot_lead', title: 'QLead vừa phát hiện Hot Lead!', body: 'Một khách hàng đang có nhu cầu rõ ràng…', url: `/app/bai-viet/${oneHot.id}`, tag: `hot-lead-${oneHot.id}` };
    handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => wait.push(p) });
    await Promise.all(wait);
    const n = shown[0];
    assert(n.tag === `hot-lead-${oneHot.id}` && n.requireInteraction === true && n.data.kind === 'hot_lead', JSON.stringify(n));
    handlers.notificationclick({ notification: { close() {}, data: n.data }, waitUntil: (p: Promise<unknown>) => wait.push(p) });
    await Promise.all(wait);
    const opened = shown.find(x => x.opened)?.opened as string;
    assert(opened === `/mo?den=${encodeURIComponent(`/app/bai-viet/${oneHot.id}`)}`, opened);
    const { context, page } = await as(one);
    await page.goto(`${BASE}${opened}`); await page.waitForURL(new RegExp(oneHot.id)); await settle(page);
    assert(await page.locator('.hot-callout').count() === 1, 'lands on Hot lead');
    await context.close();
    return opened;
  });

  // 8. Push off/unsupported: Hot still visible in-app (no permission prompt anywhere on load).
  await check('S8 Hot Lead visible with push unavailable; no permission request on load', async () => {
    const { context, page } = await as(one);
    await page.addInitScript(() => { (window as any).__perm = 0; const N = (window as any).Notification; if (N) N.requestPermission = () => { (window as any).__perm++; return Promise.resolve('default'); }; delete (window as any).PushManager; });
    await page.goto(`${BASE}/app`); await settle(page); await page.locator('.hot-band').waitFor();
    assert(await page.evaluate(() => (window as any).__perm) === 0, 'permission requested without a tap');
    await context.close();
  });

  // 9 + 10. Install line: shown in a browser tab, hidden in the installed app; iPhone gets Add to Home Screen steps.
  await check('S9 install line hidden when running as installed app', async () => {
    const { context, page } = await as(many);
    await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
    await page.goto(`${BASE}/app`); await settle(page); await page.locator('.hot-band').waitFor();
    assert(await page.locator('.hot-install').count() === 0, 'install shown in app');
    await context.close();
  });
  await check('S10 iPhone Safari: "Cài QLead" opens Add-to-Home-Screen steps (390px)', async () => {
    const { context, page } = await as(many, { ...devices['iPhone 13'], locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    await page.goto(`${BASE}/app`); await settle(page); await page.locator('.hot-band').waitFor();
    const line = page.locator('.hot-install');
    assert(/Đừng bỏ lỡ Hot Lead/.test(await line.innerText()), 'copy');
    await line.getByRole('button', { name: 'Cài QLead' }).click({ timeout: 8000 }).catch(async e => { await shot(page, 'debug-install-click-390'); throw e; });
    const sheet = page.locator('dialog.install-sheet');
    await sheet.waitFor();
    assert(/Thêm vào MH chính/.test(await sheet.innerText()), 'iOS steps');
    await shot(page, 'today-install-iphone-390');
    await page.getByRole('button', { name: 'Đã hiểu' }).click();
    await sheet.waitFor({ state: 'detached' });
    await line.getByRole('button', { name: 'Để sau' }).click();
    await page.reload(); await settle(page);
    assert(await page.locator('.hot-install').count() === 0, 'dismiss persisted');
    await context.close();
    return 'real iOS install/push NOT verified (desktop emulation only)';
  });

  // 11. Quiet hours boundaries (client clock; the backend enforces the same rule).
  for (const [label, hh, mm, quiet] of [['00:29', 0, 29, false], ['00:30', 0, 30, true], ['06:29', 6, 29, true], ['06:30', 6, 30, false]] as const) {
    await check(`S11 quiet hours at ${label} VN → ${quiet ? 'paused' : 'normal'}`, async () => {
      const { context, page } = await as(zero);
      await page.clock.setFixedTime(vnInstant(hh, mm));
      await page.goto(`${BASE}/app`); await settle(page);
      await page.waitForTimeout(300);
      const panel = await page.locator('.scan-panel').innerText();
      assert(/QLead đang tạm nghỉ ban đêm/.test(panel) === quiet, panel.slice(0, 200));
      assert(!/Quét chậm|gặp lỗi|chậm hơn lịch/.test(panel) || !quiet, 'alarming copy during quiet');
      if (quiet) assert(!/Lượt quét dự kiến tiếp theo/.test(panel), 'countdown shown during quiet');
      await page.goto(`${BASE}/app/bo-loc`); await settle(page); await page.waitForTimeout(300);
      const card = await page.locator('.pf-card').first().innerText();
      assert(/QLead đang tạm nghỉ ban đêm/.test(card) === quiet, card.slice(0, 200));
      if (quiet && label === '00:30') { await shot(page, 'bo-loc-quiet-1440'); await page.goto(`${BASE}/app`); await settle(page); await shot(page, 'today-quiet-1440'); }
      await context.close();
    });
  }

  // 12. Manual scan during quiet hours: backend answer (quietHoursActive) is explained; no workaround offered.
  await check('S12 "Tìm lại" during quiet hours explains the 06:30 hold', async () => {
    const { context, page } = await as(zero);
    await page.clock.setFixedTime(vnInstant(1, 15));
    await page.route('**/api/profiles/*/scan', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const r = await route.fetch(); const body = await r.json();
      await route.fulfill({ response: r, json: { scan: { ...body.scan, outcome: 'queued', quietHoursActive: true, nextAllowedScanAt: vnInstant(6, 30).toISOString() } } });
    });
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    const button = page.getByRole('button', { name: 'Tìm lại lúc 06:30' });
    await button.waitFor({ timeout: 10000 });
    await button.click();
    await page.getByText('Lượt tìm đã được giữ và sẽ bắt đầu từ 06:30').first().waitFor({ timeout: 10000 });
    await context.close();
  });

  // 13. Suspended account: the hold message wins over quiet hours; no rescan button.
  await check('S13 suspended account during quiet hours shows the hold, not quiet copy', async () => {
    await q("UPDATE users SET lead_monitoring_status='suspended' WHERE id=$1", [held.userId]);
    const { context, page } = await as(held);
    await page.clock.setFixedTime(vnInstant(2, 0));
    await page.goto(`${BASE}/app/bo-loc`); await settle(page); await page.waitForTimeout(300);
    const card = await page.locator('main').innerText();
    assert(/tạm dừng/.test(card) && !/tạm nghỉ ban đêm/.test(card), card.slice(0, 300));
    assert(await page.getByRole('button', { name: /Tìm lại/ }).count() === 0, 'rescan offered while suspended');
    await context.close();
    await q("UPDATE users SET lead_monitoring_status='active' WHERE id=$1", [held.userId]);
  });

  // 14–16. "Không quan tâm" vs "Không phù hợp", persistence, filters and counts.
  await check('S14–16 Không quan tâm is separate from Không phù hợp and persists', async () => {
    const [a, b] = zeroLeads;
    const { context, page } = await as(zero);
    await page.goto(`${BASE}/app/bai-viet/${a.id}`); await settle(page);
    await page.getByRole('radio', { name: 'Không quan tâm' }).click();
    await page.getByText('Đúng nhóm khách, nhưng bạn không muốn theo đuổi lúc này.').waitFor();
    await page.waitForTimeout(600);
    await page.goto(`${BASE}/app/bai-viet/${b.id}`); await settle(page);
    await page.getByRole('radio', { name: 'Không phù hợp' }).click();
    await page.getByText('Không đúng nhóm khách bạn cần tìm.').waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'detail-status-not-fit-1440');
    await page.goto(`${BASE}/app/bai-viet/${a.id}`); await settle(page);
    assert(await page.getByRole('radio', { name: 'Không quan tâm' }).getAttribute('aria-checked') === 'true', 'not persisted after reload');
    const [row] = await q("SELECT status FROM lead_states WHERE user_id=$1 AND post_id=$2", [zero.userId, a.id]).catch(async () => q("SELECT status FROM lead_states WHERE post_id=$1", [a.id]));
    assert(row?.status === 'not_interested', `db ${row?.status}`);
    await page.goto(`${BASE}/app/bai-viet`); await settle(page);
    const tabNI = page.getByRole('tab', { name: /Không quan tâm/ }), tabNF = page.getByRole('tab', { name: /Không phù hợp/ });
    assert(/1$/.test((await tabNI.innerText()).trim()) && /1$/.test((await tabNF.innerText()).trim()), `${await tabNI.innerText()} / ${await tabNF.innerText()}`);
    await tabNI.click();
    assert(await page.locator('tbody tr').count() === 1, 'filter rows');
    await shot(page, 'list-filter-not-interested-1440');
    await context.close();
    return 'DB status not_interested; tabs 1 / 1';
  });

  // 17. Search-profile copy.
  await check('S17 profile form uses the "bạn kinh doanh gì" guidance', async () => {
    const { context, page } = await as(zero);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.getByRole('button', { name: /Sửa/ }).first().click();
    const label = page.getByLabel('Bạn kinh doanh gì và muốn tìm khách hàng nào?');
    await label.waitFor();
    assert(/Tôi đang bán phần mềm quản lý, tính tiền/.test(await label.getAttribute('placeholder') ?? ''), 'placeholder');
    assert((await label.inputValue()).startsWith('Tôi đang bán phần mềm quản lý'), 'saved description untouched');
    await shot(page, 'bo-loc-copy-1440');
    await context.close();
  });

  // 18. Reduced motion: greeting text, no animation.
  await check('S18 reduced motion: no animation, greeting kept', async () => {
    const { context, page } = await as(many, { reducedMotion: 'reduce' });
    await page.goto(`${BASE}/app/bai-viet`); await settle(page); await page.locator('.hot-band').waitFor();
    assert(await page.locator('.hot-band.is-celebrating').count() === 0, 'animated');
    await context.close();
  });

  // Responsive: 390 / 768 / 1440, no horizontal scroll on the Hot views.
  for (const width of [390, 768, 1440]) {
    await check(`R ${width}px Today, list, detail without horizontal scroll`, async () => {
      const { context, page } = await as(many, { viewport: { width, height: 900 } });
      for (const [path, name] of [['/app', 'today'], ['/app/bai-viet', 'list'], [`/app/bai-viet/${manyLeads.find(l => l.hot)!.id}`, 'detail']] as const) {
        await page.goto(`${BASE}${path}`); await settle(page);
        if (!(await noHScroll(page))) throw new Error(`${path} scrolls sideways: ` + JSON.stringify(await page.evaluate(() => { const W = window.innerWidth; return [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > W + 1).slice(0, 6).map(e => `${e.tagName}.${(e as HTMLElement).className} ${Math.round(e.getBoundingClientRect().right)}`); })));
        await shot(page, `${name}-many-${width}`);
      }
      await context.close();
    });
  }

  // 19. Navigation: Today → list stays fast (client navigation, dev build so numbers are only indicative).
  await check('S19 Today → list navigation time (dev build, indicative)', async () => {
    const { context, page } = await as(many);
    await page.goto(`${BASE}/app`); await settle(page);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await page.getByRole('link', { name: 'Danh sách lead' }).first().click(); await page.locator('h1', { hasText: 'Danh sách lead' }).waitFor();
      times.push(Date.now() - t0);
      await page.getByRole('link', { name: 'Hôm nay' }).first().click(); await page.locator('h1', { hasText: 'Hôm nay' }).waitFor();
    }
    await context.close();
    return `${times.join(' / ')} ms`;
  });

  // 20. Tenant isolation.
  await check('S20 another account cannot see a Hot Lead', async () => {
    const { context, page } = await as(zero);
    const res = await page.goto(`${BASE}/app/bai-viet/${oneHot.id}`); await settle(page);
    const body = await page.locator('body').innerText();
    assert(res?.status() === 404 || /không tìm thấy|Không tìm thấy/.test(body), `status ${res?.status()}`);
    assert(!/Hot Lead/.test(body), 'Hot leaked');
    const api = await page.request.get(`${BASE}/api/leads`);
    const text = await api.text();
    assert(!text.includes(oneHot.id), 'id leaked via API');
    await context.close();
    return `page ${res?.status()}, API ${api.status()}`;
  });

  await browser.close();
  writeFileSync(resolve(SHOTS, '../e2e-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async error => { console.error(error); await browser?.close().catch(() => undefined); await pool.end().catch(() => undefined); process.exit(1); });
