// Engagement gate UX (Codex contract docs/lead-engagement-gate-contract.md) — browser QA on an ISOLATED database
// (muse_bridge_test_gate = muse_bridge_test_hot + migration 026). Leads are distributed by Codex's own
// distributeProfileLeads and reviews are recorded by the real API routes; nothing touches Muse, Facebook or Production.
// 1. From web/: $env:DATABASE_URL='postgres://muse:<pw>@127.0.0.1:55432/muse_bridge_test_gate'; $env:QLEAD_DIST_DIR='.next-gate'
//    $env:QLEAD_ADMIN_USER_IDS='00000000-0000-4000-8000-0000000ad026'; npx next dev --webpack -p 3081 -H localhost
//    (or `next build` + `next start` with the same env for the production-build run)
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
const ADMIN_ID = '00000000-0000-4000-8000-0000000ad026';
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

type User = { userId: string; token: string; name: string; profile: string };
async function account(tag: string, userId?: string): Promise<{ userId: string; token: string; name: string }> {
  const name = `E2E gate ${RUN} ${tag}`;
  if (userId) await q('INSERT INTO users(id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, name]);
  else userId = (await q<{ id: string }>('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name]))[0]!.id;
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [userId, createHash('sha256').update(token).digest('hex')]);
  return { userId, token, name };
}
/** One need with `scans` completed discovery scans, each distributed by the real pipeline (56 source-linked posts). */
async function need(userId: string, tag: string, label: string, scans: number): Promise<string> {
  const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, label]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [profile, JSON.stringify(['phần mềm bán hàng']), `Tôi bán phần mềm quản lý bán hàng, muốn tìm ${label.toLowerCase()}.`]);
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
  return profile;
}
async function customer(tag: string, scans: number, label = 'Quán F&B sắp khai trương'): Promise<User> {
  const a = await account(tag);
  return { ...a, profile: await need(a.userId, tag, label, scans) };
}
const delivered = (profile: string) => q<{ id: string; url: string }>(`SELECT d.post_id AS id, fp.original_url AS url FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id = d.post_id
  WHERE d.search_profile_id = $1 AND d.state = 'delivered' ORDER BY d.delivered_at, d.post_id`, [profile]);
const engagementOf = async (user: { token: string }, profile: string) => {
  const res = await fetch(`${BASE}/api/profiles/${profile}/scan`, { headers: { cookie: `qlead_session=${user.token}` } });
  return (await res.json() as { engagement: any }).engagement;
};

let browser: Browser;
async function as(user: { token: string }, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', ...opts });
  await context.addCookies([{ name: 'qlead_session', value: user.token, url: BASE }]);
  // "Xem bài Facebook" opens a new tab: answer it locally so no request leaves the machine.
  await context.route(/facebook\.com/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>fixture</p>' }));
  return { context, page: await context.newPage() };
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
const shotView = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
const settle = (page: Page) => page.waitForLoadState('networkidle').catch(() => undefined);
const text = (page: Page, selector: string) => page.locator(selector).first().innerText().then(t => t.replace(/\s+/g, ' ').trim());
const rows = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.lead-table tbody tr, .lead-cards > li')].filter(el => (el as HTMLElement).offsetParent !== null).length);
async function openSource(page: Page, context: BrowserContext, url: string) {
  const popup = context.waitForEvent('page');
  await page.locator(`a.fb-link[href="${url}"]:visible`).first().click();
  await (await popup).close().catch(() => undefined);
}

async function main() {
  const held = await customer('held', 3);
  const early = await customer('early', 2);
  const empty = await customer('empty', 0);
  const multi = await customer('multiA', 3, 'Quán F&B sắp khai trương');
  await need(multi.userId, 'multiB', 'Shop thời trang mở chi nhánh', 2);
  const paused = await customer('paused', 3);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    SELECT agent_connection_id, 2, false, keywords, keywords_source, location, sources, frequency_minutes, description FROM scan_configs WHERE agent_connection_id = $1 AND version = 1`, [paused.profile]);
  const suspended = await customer('suspended', 3);
  await q("UPDATE users SET lead_monitoring_status = 'suspended' WHERE id = $1", [suspended.userId]);
  const admin = await account('admin', ADMIN_ID);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  await check('Backend: 3 scans → 20 delivered, 36 held, 0/16', async () => {
    const e = await engagementOf(held, held.profile);
    assert(e.gateState === 'holding_third_scan_results' && e.deliveredCount === 20 && e.pendingCount === 36 && e.requiredReviewedCount === 16 && !e.mayStartNewScan, JSON.stringify(e));
    return `${e.gateState} ${e.reviewedCount}/${e.deliveredCount}, need ${e.requiredReviewedCount}, pending ${e.pendingCount}`;
  });

  for (const [w, h] of [[1440, 1000], [768, 1024], [390, 844]] as const) {
    await check(`E1 Nhu cầu card @${w}: compact progress replaces the held scan headline`, async () => {
      const { context, page } = await as(held, { viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      await page.goto(`${BASE}/app/bo-loc`); await settle(page);
      await page.locator('.eg-panel.is-card').waitFor({ timeout: 20000 });
      const panel = await text(page, '.eg-panel');
      assert(/QLead đã lưu thêm cơ hội cho bạn/.test(panel) && /36 cơ hội đang chờ gửi/.test(panel) && /Bạn đã khám phá 0\/20 khách hàng/.test(panel)
        && /Khám phá thêm 16 khách hàng để nhận lượt tiếp theo/.test(panel) && /0% \/ mục tiêu 80%/.test(panel), panel);
      assert(!/khóa|không đủ điều kiện|bắt buộc/i.test(panel), 'no punitive wording');
      assert(await text(page, '.pf-monitor') === 'Có cơ hội đang chờ', 'pill');
      assert(await page.getByRole('button', { name: /Tìm lại/ }).count() === 0, 'no rescan button');
      assert(await page.locator('.pf-card .pf-stage, .pf-card .pf-status').count() === 0, 'no "Tìm thấy N khách hàng mới" while held');
      assert(await page.getByRole('link', { name: /Xem khách hàng chưa xem/ }).getAttribute('href') === `/app/bai-viet?nhu-cau=${held.profile}&chua-xem=1`, 'CTA href');
      assert(await noHScroll(page), 'horizontal scroll');
      await shot(page, `bo-loc-held-${w}`);
      if (w !== 1440) {
        await page.goto(`${BASE}/app/bai-viet?nhu-cau=${held.profile}`); await settle(page);
        await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
        assert(await noHScroll(page), 'list horizontal scroll');
        await shotView(page, `list-held-${w}`);
        await page.goto(`${BASE}/app`); await settle(page);
        await page.locator('.eg-today').waitFor({ timeout: 20000 });
        assert(await noHScroll(page), 'Today horizontal scroll');
        await shotView(page, `today-held-${w}`);
      }
      await context.close();
      return w === 1440 ? panel : undefined;
    });
  }

  await check('E2 manual rescan refused (usage_gated), no job created', async () => {
    const res = await fetch(`${BASE}/api/profiles/${held.profile}/scan`, { method: 'POST', headers: { cookie: `qlead_session=${held.token}`, origin: BASE, 'content-type': 'application/json' } });
    const body = await res.json() as { scan?: { outcome?: string } };
    assert(body.scan?.outcome === 'usage_gated', JSON.stringify(body));
    const [{ n }] = await q("SELECT count(*)::int AS n FROM search_jobs WHERE search_profile_id = $1 AND status IN ('pending','claimed')", [held.profile]);
    assert(n === 0, `open jobs ${n}`);
  });

  await check('E3 Today: one short line, no countdown/late note for a need that is not searched', async () => {
    const { context, page } = await as(held);
    await page.goto(`${BASE}/app`); await settle(page);
    await page.locator('.eg-today li').waitFor({ timeout: 20000 });
    const line = await text(page, '.eg-today li');
    assert(/QLead đã lưu thêm cơ hội\. Khám phá thêm 16 khách hàng để nhận lượt tiếp theo/.test(line), line);
    assert(await page.locator('.eg-panel').count() === 0 && await page.locator('.scan-next').count() === 0, 'no big panel, no countdown');
    assert(await page.locator('.eg-today a').getAttribute('href') === `/app/bai-viet?nhu-cau=${held.profile}&chua-xem=1`, 'link');
    await shot(page, 'today-held-1440');
    await context.close();
    return line;
  });

  const leads = await delivered(held.profile);
  await check('E4 CTA lands on exactly this need, unread view; URL survives refresh', async () => {
    const { context, page } = await as(held);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.getByRole('link', { name: /Xem khách hàng chưa xem/ }).click();
    await page.waitForURL(/chua-xem=1/); await settle(page);
    assert(new URL(page.url()).searchParams.get('nhu-cau') === held.profile, page.url());
    assert(await page.locator('select[aria-label="Lọc theo nhu cầu"]').inputValue() === held.profile, 'need preselected');
    assert(/Chưa xem/.test(await page.locator('.status-tabs [aria-selected="true"]').innerText()), 'unread tab selected');
    await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
    await page.reload(); await settle(page);
    assert(new URL(page.url()).searchParams.get('nhu-cau') === held.profile && /Chưa xem/.test(await page.locator('.status-tabs [aria-selected="true"]').innerText()), 'survives refresh');
    await context.close();
  });

  await check('E5 statuses count, "Đã xem" does not; Facebook re-open counts once', async () => {
    const { context, page } = await as(held);
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${held.profile}`); await settle(page);
    await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
    const statuses = ['contacted', 'interested', 'not_interested', 'not_fit'];
    for (const [i, lead] of leads.slice(0, 14).entries()) {
      const r = await page.request.patch(`${BASE}/api/leads/${lead.id}`, { data: { status: statuses[i % 4] }, headers: { origin: BASE } });
      assert(r.ok(), `PATCH ${r.status()}`);
    }
    assert((await page.request.patch(`${BASE}/api/leads/${leads[14]!.id}`, { data: { status: 'seen' }, headers: { origin: BASE } })).ok(), 'seen');
    await page.reload(); await settle(page);
    await page.waitForFunction(() => /14\/20/.test(document.querySelector('.eg-panel')?.textContent ?? ''), null, { timeout: 15000 });
    // Same source opened twice: progress moves by one, in place, without a reload.
    await openSource(page, context, leads[15]!.url);
    await page.waitForFunction(() => /15\/20/.test(document.querySelector('.eg-panel')?.textContent ?? ''), null, { timeout: 15000 });
    await page.reload(); await settle(page); await page.locator('.eg-panel').waitFor();
    await openSource(page, context, leads[15]!.url);
    await page.waitForTimeout(2500);
    const e = await engagementOf(held, held.profile);
    assert(e.reviewedCount === 15 && /15\/20/.test(await text(page, '.eg-panel')), `reviewed ${e.reviewedCount}`);
    assert(/Khám phá thêm 1 khách hàng/.test(await text(page, '.eg-panel')), 'one more');
    assert(!/QLead giữ thêm \d+ cơ hội khác và sẽ gửi tiếp/.test(await page.locator('main').innerText()), 'no "sẽ gửi tiếp lúc" promise while held');
    assert(await page.locator('.latest-delivery').count() === 0, 'no second band stacked while held');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotView(page, 'list-held-15of20-1440');
    await context.close();
    return `server reviewed=${e.reviewedCount}, percent=${Math.floor(e.reviewedPercent)}`;
  });

  await check('E6 reaching 80% (16/20) releases a real batch in place, thanks once, no replay on refresh', async () => {
    const { context, page } = await as(held);
    await page.goto(`${BASE}/app/bai-viet?nhu-cau=${held.profile}`); await settle(page);
    await page.locator('.eg-panel.is-list').waitFor({ timeout: 20000 });
    const before = await rows(page);
    await openSource(page, context, leads[16]!.url);
    await page.locator('.eg-released').waitFor({ timeout: 15000 });
    const released = await text(page, '.eg-released');
    const e = await engagementOf(held, held.profile);
    const added = e.deliveredCount - 20;
    assert(added > 0 && new RegExp(`QLead đã gửi thêm ${added} khách hàng cho bạn`).test(released), `${released} (server added ${added})`);
    await page.waitForFunction(n => [...document.querySelectorAll('.lead-table tbody tr, .lead-cards > li')].filter(el => (el as HTMLElement).offsetParent !== null).length > n, before, { timeout: 15000 });
    // The larger cohort lowers the percentage: the panel follows the server instead of celebrating forever.
    await page.waitForFunction(t => (document.querySelector('.eg-panel')?.textContent ?? '').includes(t), `16/${e.deliveredCount}`, { timeout: 15000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotView(page, 'list-released-1440');
    const after = await rows(page);
    await page.reload(); await settle(page); await page.locator('.eg-panel').waitFor();
    await page.waitForTimeout(1500);
    assert(await page.locator('.eg-released').count() === 0, 'no replay after refresh');
    assert(await rows(page) === after, 'counts stable after refresh');
    await context.close();
    return `${released} rows ${before}→${after}; then ${e.reviewedCount}/${e.deliveredCount} (need ${e.requiredReviewedCount})`;
  });

  await check('E7 first two scans / zero leads: nothing shown, rescan offered', async () => {
    for (const user of [early, empty]) {
      const { context, page } = await as(user);
      await page.goto(`${BASE}/app/bo-loc`); await settle(page);
      await page.locator('.pf-card').waitFor(); await page.waitForTimeout(1200);
      assert(await page.locator('.eg-panel').count() === 0 && await text(page, '.pf-monitor') === 'Đang theo dõi', `${user.name} card`);
      await page.goto(`${BASE}/app/bai-viet?nhu-cau=${user.profile}`); await settle(page); await page.waitForTimeout(1200);
      assert(await page.locator('.eg-panel').count() === 0, 'list');
      if (user === early) assert(await page.locator('.latest-delivery').count() === 1, 'normal delivery band kept outside the gate');
      await page.goto(`${BASE}/app`); await settle(page); await page.waitForTimeout(1200);
      assert(await page.locator('.eg-today').count() === 0, 'Today');
      await context.close();
    }
  });

  await check('E8 several needs keep independent progress', async () => {
    const { context, page } = await as(multi);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.locator('.eg-panel').waitFor({ timeout: 20000 }); await page.waitForTimeout(1000);
    const cards = page.locator('.pf-card');
    assert(await cards.count() === 2, 'two cards');
    const a = cards.filter({ hasText: 'Quán F&B sắp khai trương' }), b = cards.filter({ hasText: 'Shop thời trang mở chi nhánh' });
    assert(await a.locator('.eg-panel').count() === 1 && await b.locator('.eg-panel').count() === 0, 'only the third-scan need waits');
    assert(await b.locator('.pf-monitor').innerText() === 'Đang theo dõi', 'other need normal');
    await page.goto(`${BASE}/app`); await settle(page); await page.locator('.eg-today li').waitFor();
    assert(await page.locator('.eg-today li').count() === 1 && await page.locator('.scan-next').count() === 1, 'Today: one line, countdown kept for the searching need');
    await shot(page, 'today-multi-1440');
    await context.close();
  });

  await check('E9 user pause and Admin suspension win over the engagement state', async () => {
    for (const [user, pill] of [[paused, 'Tạm dừng'], [suspended, 'Đang bật']] as const) {
      const { context, page } = await as(user);
      await page.goto(`${BASE}/app/bo-loc`); await settle(page);
      await page.locator('.pf-card').waitFor(); await page.waitForTimeout(1500);
      assert(await page.locator('.eg-panel').count() === 0 && await text(page, '.pf-monitor') === pill, `${user.name}: ${await text(page, '.pf-monitor')}`);
      await page.goto(`${BASE}/app`); await settle(page); await page.waitForTimeout(1500);
      assert(await page.locator('.eg-today').count() === 0, 'Today');
      await context.close();
    }
  });

  await check('E10 keyboard: disclosure and CTA reachable; progressbar named', async () => {
    const { context, page } = await as(held);
    await page.goto(`${BASE}/app/bo-loc`); await settle(page);
    await page.locator('.eg-panel').waitFor({ timeout: 20000 });
    await page.locator('.eg-how summary').focus(); await page.keyboard.press('Enter');
    assert(await page.locator('.eg-how').evaluate(el => (el as HTMLDetailsElement).open), 'details opens with Enter');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement?.textContent?.includes('Xem khách hàng chưa xem')), 'CTA next in tab order');
    const valuetext = await page.locator('.eg-bar[role="progressbar"]').getAttribute('aria-valuetext');
    assert(/^\d+%, mục tiêu 80%$/.test(valuetext ?? ''), valuetext ?? '');
    await context.close();
    return valuetext ?? '';
  });

  await check('E11 Admin detail: historical vs new-policy numbers match the API', async () => {
    const api = await fetch(`${BASE}/api/admin/users/${held.userId}`, { headers: { cookie: `qlead_session=${admin.token}` } });
    assert(api.ok, `admin API ${api.status}`);
    const detail = await api.json() as any;
    const p = (detail.user ?? detail).profiles[0];
    const { context, page } = await as(admin);
    await page.goto(`${BASE}/admin/users?q=${encodeURIComponent(held.name)}`); await settle(page);
    await page.getByRole('button', { name: /Xem chi tiết/ }).first().click();
    await page.locator('.admin-engagement').waitFor({ timeout: 15000 });
    const block = await text(page, '.admin-engagement');
    assert(block.includes(`Đã giao theo chính sách ${p.deliveredCount}`) && block.includes(`Đã khám phá ${p.reviewedCount} (${Math.floor(p.reviewedPercent)}%)`)
      && block.includes(`Đang chờ gửi ${p.pendingCount}`) && /không phải chất lượng lead/.test(block), block);
    const meta = await page.locator('.user-profiles li').first().innerText();
    assert(meta.includes(`đã khám phá ${p.reviewedCount}/${p.deliveredCount} lead`), meta);
    await shotView(page, 'admin-detail-1440');
    await context.close();
    return `${p.reviewedCount}/${p.deliveredCount} (${Math.floor(p.reviewedPercent)}%), pending ${p.pendingCount}, all-time ${p.allTimeLeadCount}`;
  });

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async error => { console.error(error); await browser?.close().catch(() => undefined); await pool.end().catch(() => undefined); process.exit(1); });
