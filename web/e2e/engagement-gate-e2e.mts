// Engagement gate UX (Codex contract docs/lead-engagement-gate-contract.md) — browser QA on an ISOLATED database
// (muse_bridge_test_gate = muse_bridge_test_hot + migration 026). Leads are distributed by Codex's own
// distributeProfileLeads and reviews are recorded by the real API routes; nothing touches Muse, Facebook or Production.
// 1. From web/: $env:DATABASE_URL='postgres://muse:<pw>@127.0.0.1:55432/muse_bridge_test_gate'; $env:QLEAD_DIST_DIR='.next-gate'
//    npx next dev --webpack -p 3081 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/engagement-gate-e2e.mts http://localhost:3081
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { distributeProfileLeads } from '../../src/lead-distribution.js';

const BASE = process.argv[2] ?? 'http://localhost:3081';
if (!/muse_bridge_test_gate\b/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_gate.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/engagement-gate-ux-20261111/screenshots');
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const RUN = randomBytes(4).toString('hex');

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
/** A customer whose need has completed `scans` discovery scans, each distributed by the real pipeline. */
async function customer(tag: string, scans: number): Promise<User> {
  const [{ id: userId }] = await q("INSERT INTO users(display_name) VALUES ($1) RETURNING id", [`E2E gate ${RUN} ${tag}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, 'Quán F&B sắp khai trương']);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['phần mềm bán hàng']), 'Tôi bán phần mềm quản lý bán hàng, muốn tìm các quán F&B sắp khai trương.']);
  for (let i = 0; i < 56; i++) {
    const url = `https://facebook.com/groups/e2egate${RUN}${tag}/posts/${1000 + i}`;
    await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, title, content, author, published_at, collected_via)
      VALUES ($1, $2, $2, $3, $4, $5, now() - make_interval(hours => $6), 'qlead_shared_worker')`,
    [profile, url, `Quán ${i + 1}`, `Quán cà phê số ${i + 1} sắp khai trương ở Quận ${(i % 12) + 1}, đang cần tìm phần mềm bán hàng.`, `Quán Mộc ${i + 1}`, 30 + i]);
    await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, 1)', [profile, url]);
  }
  for (let ordinal = 1; ordinal <= scans; ordinal++) {
    const [{ id: job }] = await q(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind, status, completed_at)
      VALUES ($1, 1, $2, now() - make_interval(mins => $3), '["social.search"]', $4, 'completed', now()) RETURNING id`,
    [profile, `e2e-gate-${RUN}-${tag}-${ordinal}`, 100 - ordinal, ordinal === 1 ? 'initial' : 'scheduled']);
    await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped, status, search_job_id)
      VALUES ($1, $2, 1, now(), 56, 20, 20, 0, 'success', $3)`, [profile, `e2e-gate-${RUN}-${tag}-${ordinal}`, job]);
    await tx(client => distributeProfileLeads(client, userId, profile, `scan:${job}`));
  }
  return { userId, token, profile };
}
const delivered = (profile: string) => q<{ id: string }>(`SELECT d.post_id AS id FROM profile_lead_deliveries d WHERE d.search_profile_id = $1 AND d.state = 'delivered' ORDER BY d.delivered_at, d.post_id`, [profile]);

let browser: Browser;
async function as(user: User, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', ...opts });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  // "Xem bài Facebook" opens a new tab: answer it locally so no request leaves the machine.
  await context.route(/facebook\.com/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>fixture</p>' }));
  return { context, page: await context.newPage() };
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
const settle = (page: Page) => page.waitForLoadState('networkidle').catch(() => undefined);
const text = (page: Page, selector: string) => page.locator(selector).first().innerText().then(t => t.replace(/\s+/g, ' ').trim());

async function main() {
  const gated = await customer('held', 3);
  const early = await customer('early', 2);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  await check('Backend state: 3 scans, 20 delivered, 36 held, gate closed', async () => {
    const res = await fetch(`${BASE}/api/profiles/${gated.profile}/scan`, { headers: { cookie: `qlead_session=${gated.token}` } });
    const { engagement } = await res.json() as { engagement: any };
    assert(engagement.gateState === 'holding_third_scan_results' && engagement.deliveredCount === 20 && engagement.pendingCount === 36
      && engagement.requiredReviewedCount === 16 && !engagement.mayStartNewScan, JSON.stringify(engagement));
    return `${engagement.gateState} ${engagement.reviewedCount}/${engagement.requiredReviewedCount} pending ${engagement.pendingCount}`;
  });

  await check('E1 Nhu cầu card: held panel replaces scan headline, no "Tìm lại ngay"', async () => {
    const { context, page } = await as(gated);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.locator('.eg-panel.is-card').waitFor({ timeout: 20000 });
    const panel = await text(page, '.eg-panel');
    assert(/QLead đang giữ 36 khách hàng mới cho bạn/.test(panel) && /Xử lý thêm 16 khách hàng nữa/.test(panel) && /0\/16/.test(panel), panel);
    assert(await page.getByRole('button', { name: /Tìm lại/ }).count() === 0, 'rescan button hidden');
    assert(await page.locator('.pf-card .pf-stage, .pf-card .pf-status').count() === 0, 'scan headline hidden while held');
    assert(await page.getByRole('link', { name: /Xử lý khách hàng/ }).getAttribute('href') === `/app/bai-viet?nhu-cau=${gated.profile}`, 'CTA');
    await page.locator('.eg-how summary').click();
    assert(/Chỉ mở xem chi tiết thì chưa tính/.test(await text(page, '.eg-how')), 'how it counts');
    await shot(page, 'bo-loc-held-1440');
    await context.close();
    return panel.slice(0, 120);
  });

  await check('E2 manual rescan is refused with a plain note (usage_gated)', async () => {
    const res = await fetch(`${BASE}/api/profiles/${gated.profile}/scan`, { method: 'POST', headers: { cookie: `qlead_session=${gated.token}`, origin: BASE, 'content-type': 'application/json' } });
    const body = await res.json() as { scan?: { outcome?: string } };
    assert(body.scan?.outcome === 'usage_gated', JSON.stringify(body));
    const jobs = await q("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND status IN ('pending','claimed')", [gated.profile]);
    assert(jobs[0].n === 0, `open jobs ${jobs[0].n}`);
    return 'usage_gated, no job created';
  });

  await check('E3 Today: one compact line for the held need', async () => {
    const { context, page } = await as(gated);
    await page.goto(`${BASE}/app`); await settle(page);
    await page.locator('.eg-today li').waitFor({ timeout: 20000 });
    const line = await text(page, '.eg-today li');
    assert(/Quán F&B sắp khai trương/.test(line) && /QLead đang giữ 36 khách hàng mới/.test(line) && /Xử lý thêm 16/.test(line), line);
    assert(await page.locator('.eg-today li').count() === 1 && await page.locator('.eg-panel').count() === 0, 'only one line, no big panel on Today');
    await shot(page, 'today-held-1440');
    await context.close();
    return line;
  });

  const leads = await delivered(gated.profile);
  await check('E4 list: panel progress follows manual statuses; "seen" does not count', async () => {
    const { context, page } = await as(gated);
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${gated.profile}`); await settle(page);
    await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
    assert(/0\/16/.test(await text(page, '.eg-panel')), 'starts at 0/16');
    const statuses = ['contacted', 'interested', 'not_interested', 'not_fit'];
    for (const [i, lead] of leads.slice(0, 15).entries()) {
      const r = await page.request.patch(`${BASE}/api/leads/${lead.id}`, { data: { status: statuses[i % 4] }, headers: { origin: BASE } });
      assert(r.ok(), `PATCH ${r.status()}`);
    }
    const seen = await page.request.patch(`${BASE}/api/leads/${leads[15]!.id}`, { data: { status: 'seen' }, headers: { origin: BASE } });
    assert(seen.ok(), 'seen PATCH');
    await page.reload(); await settle(page);
    await page.locator('.eg-panel.is-list').waitFor();
    const panel = await text(page, '.eg-panel');
    assert(/15\/16/.test(panel) && /Xử lý thêm 1 khách hàng nữa/.test(panel), panel);
    assert(!/QLead giữ thêm \d+ cơ hội khác và sẽ gửi tiếp/.test(await page.locator('main').innerText()), 'no "sẽ gửi tiếp lúc" promise while held');
    await shot(page, 'list-held-15of16-1440');
    await context.close();
    return panel.slice(0, 140);
  });

  await check('E5 "Xem bài Facebook" on the 16th lead releases 10 held leads in place', async () => {
    const { context, page } = await as(gated);
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${gated.profile}`); await settle(page);
    await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
    const before = await page.locator('.lead-table tbody tr, .lead-list > li').count();
    const target = leads[16]!.id;
    // Click the Facebook link of a lead that has no review yet (the 17th delivered lead).
    const [{ url }] = await q<{ url: string }>('SELECT original_url AS url FROM facebook_posts WHERE id = $1', [target]);
    const popup = context.waitForEvent('page');
    await page.locator(`a.fb-link[href="${url}"]:visible`).first().click();
    await (await popup).close().catch(() => undefined);
    await page.locator('.eg-released').waitFor({ timeout: 15000 });
    const released = await text(page, '.eg-released');
    assert(/QLead đã gửi thêm 10 khách hàng/.test(released), released);
    await page.waitForFunction(n => document.querySelectorAll('.lead-table tbody tr, .lead-list > li').length > n, before, { timeout: 15000 });
    // 30 delivered now, 16 reviewed: the server holds again until 24, and the panel says so with fresh numbers.
    await page.waitForFunction(() => /16\/24/.test(document.querySelector('.eg-panel')?.textContent ?? ''), null, { timeout: 15000 });
    await shot(page, 'list-released-1440');
    const after = await page.locator('.lead-table tbody tr, .lead-list > li').count();
    await context.close();
    return `${released} rows ${before}→${after}; panel now 16/24`;
  });

  await check('E6 need in its first two scans: no panel anywhere, rescan offered', async () => {
    const { context, page } = await as(early);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.locator('.pf-card').waitFor();
    await page.waitForTimeout(1500);
    assert(await page.locator('.eg-panel').count() === 0, 'no panel on card');
    assert(await page.getByRole('button', { name: /Tìm lại/ }).count() === 1, 'rescan offered');
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${early.profile}`); await settle(page); await page.waitForTimeout(1500);
    assert(await page.locator('.eg-panel').count() === 0, 'no panel on list');
    await page.goto(`${BASE}/app`); await settle(page); await page.waitForTimeout(1500);
    assert(await page.locator('.eg-today').count() === 0, 'no Today line');
    await context.close();
  });

  await check('E7 390px: card, list and Today fit without horizontal scroll', async () => {
    const { context, page } = await as(gated, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    for (const [path, sel, name] of [['/app/bo-loc', '.eg-panel', 'bo-loc-held-390'], [`/app/bai-viet?nhu-cau=${gated.profile}`, '.eg-panel', 'list-held-390'], ['/app', '.eg-today', 'today-held-390']] as const) {
      await page.goto(`${BASE}${path}`); await settle(page);
      await page.locator(sel).first().waitFor({ timeout: 20000 });
      assert(await noHScroll(page), `${path} scrolls horizontally`);
      await shot(page, name);
    }
    await context.close();
  });

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async error => { console.error(error); await browser?.close().catch(() => undefined); await pool.end().catch(() => undefined); process.exit(1); });
