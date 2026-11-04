// Browser E2E for the scan history on "Hôm nay" and the full history page, on the ISOLATED test database (never the live one).
// 1. Start the web app against the test DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; $env:QLEAD_DIST_DIR='.next-scan-history-e2e'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'
//    $env:DEV_QUICK_LOGIN_USERS='h0:E2E Hist 0:00000000-0000-4000-8000-0000005c0a00,h1:E2E Hist 1:00000000-0000-4000-8000-0000005c0a01,h5:E2E Hist 5:00000000-0000-4000-8000-0000005c0a05,h20:E2E Hist 20:00000000-0000-4000-8000-0000005c0a20,h200:E2E Hist 200:00000000-0000-4000-8000-0000005c0a99'
//    npm run dev -- -p 3009
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/scan-history-e2e.mts http://127.0.0.1:3009 [shots-only]
//    "shots-only" seeds and captures /app screenshots without assertions (used for before/after comparisons).
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3009';
const SHOTS_ONLY = process.argv[3] === 'shots-only';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/scan-history-results-20261103/screenshots');
mkdirSync(SHOTS, { recursive: true });

const U = { h0: '00000000-0000-4000-8000-0000005c0a00', h1: '00000000-0000-4000-8000-0000005c0a01', h5: '00000000-0000-4000-8000-0000005c0a05', h20: '00000000-0000-4000-8000-0000005c0a20', h200: '00000000-0000-4000-8000-0000005c0a99' };
const LONG = 'Quán ăn, quán cà phê và nhà hàng sắp khai trương ở Thủ Đức, Dĩ An, Thuận An, Biên Hòa cần phần mềm bán hàng và máy POS';
const P = { long: '', hotel: '', spa: '', paused: '' };

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

async function profile(user: string, name: string, enabled = true, frequency = 30) {
  const [{ id }] = await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [user, name]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at)
    VALUES ($1, 1, true, '["quán ăn sắp khai trương"]', '', '["social.search"]', $2, $3, now() - interval '30 days')`, [id, frequency, name]);
  if (!enabled) await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at)
    VALUES ($1, 2, false, '["quán ăn sắp khai trương"]', '', '["social.search"]', $2, $3, now() - interval '1 day')`, [id, frequency, name]);
  return id;
}
/**
 * `count` scans every `every` minutes, the newest `startMinutes` ago. Every `hitEvery`-th scan finds new posts,
 * every `failEvery`-th fails and every `partialEvery`-th is partial (0 disables), so most rows are "success, 0 new".
 */
async function scans(id: string, count: number, opts: { startMinutes?: number; every?: number; hitEvery?: number; failEvery?: number; partialEvery?: number; seen?: number } = {}) {
  const { startMinutes = 5, every = 30, hitEvery = 0, failEvery = 0, partialEvery = 0, seen = 60 } = opts;
  await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status)
    SELECT $1::uuid, 'e2e-hist-' || $1::text || '-' || n, 1, now() - make_interval(mins => $2::int + n * $3::int), now() - make_interval(mins => $2::int + n * $3::int),
      CASE WHEN $6::int > 0 AND n % $6::int = 3 THEN 0 ELSE $8::int - (n % 7) END,
      CASE WHEN $4::int > 0 AND n % $4::int = 1 THEN 1 + n % 3 ELSE 0 END,
      CASE WHEN $6::int > 0 AND n % $6::int = 3 THEN 0 WHEN $4::int > 0 AND n % $4::int = 1 THEN 1 + n % 3 ELSE 0 END, 0,
      CASE WHEN $6::int > 0 AND n % $6::int = 3 THEN 'failed' WHEN $7::int > 0 AND n % $7::int = 5 THEN 'partial' ELSE 'success' END
    FROM generate_series(0, $5::int - 1) AS n`, [id, startMinutes, every, hitEvery, count, failEvery, partialEvery, seen]);
  // Each new post is stored like the worker API does it: in the scan's transaction, so first_seen_at = received_at.
  await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    SELECT sr.agent_connection_id, u.url, u.url, 'Bài đăng thử số ' || k || ' cần tư vấn phần mềm bán hàng.', 'E2E Chủ quán', sr.received_at - interval '1 hour', sr.received_at, 'qlead_shared_worker'
    FROM scan_runs sr CROSS JOIN LATERAL generate_series(1, sr.new_posts) AS k CROSS JOIN LATERAL (SELECT 'https://facebook.com/e2e-hist/' || sr.external_scan_id || '-' || k AS url) u
    WHERE sr.agent_connection_id = $1`, [id]);
  await q(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version)
    SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1 ON CONFLICT DO NOTHING`, [id]);
}
/**
 * One scan whose stored rows include some that are not new leads: `complete` new leads, `incomplete` rows the lead
 * list hides (no author) and `duplicates` (URLs of posts the customer already has from another search).
 * scan_runs.new_posts counts all of them, as the backend does.
 */
async function mixedScan(id: string, minutesAgo: number, rows: { complete: number; incomplete?: number; duplicates?: string[] }) {
  const { incomplete = 0, duplicates = [] } = rows;
  const [{ ext }] = await q<{ ext: string }>(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status)
    VALUES ($1, 'e2e-mixed-' || gen_random_uuid(), 1, now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int), 70, $3, $3, 0, 'success') RETURNING external_scan_id AS ext`, [id, minutesAgo, rows.complete + incomplete + duplicates.length]);
  const urls = [...Array.from({ length: rows.complete }, (_, i) => [`https://facebook.com/e2e-hist/${ext}-c${i}`, 'E2E Chủ quán']), ...Array.from({ length: incomplete }, (_, i) => [`https://facebook.com/e2e-hist/${ext}-i${i}`, null]), ...duplicates.map(url => [url, 'E2E Chủ quán'])];
  for (const [url, author] of urls) {
    await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
      SELECT $1, $2, $2, 'Bài đăng thử cần máy POS cho cửa hàng mới.', $3, received_at - interval '1 hour', received_at, 'qlead_shared_worker'
      FROM scan_runs WHERE agent_connection_id = $1 AND external_scan_id = $4`, [id, url, author, ext]);
    await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, 1)', [id, url]);
  }
}
async function post(id: string, slug: string, content: string, minutesAgo: number) {
  const url = `https://facebook.com/e2e-hist/${slug}`;
  await q(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    VALUES ($1, $2, $2, $3, 'E2E Chủ quán', now() - make_interval(mins => $4::int) - interval '1 hour', now() - make_interval(mins => $4::int), 'qlead_shared_worker')`, [id, url, content, minutesAgo]);
  await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, 1)', [id, url]);
}

async function seed() {
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  for (const [key, id] of Object.entries(U)) await q('INSERT INTO users(id, display_name) VALUES ($1, $2)', [id, `E2E Hist ${key.slice(1)}`]);
  // h0: a paused requirement that never ran (no first-scan screen, no history).
  await profile(U.h0, 'Spa và thẩm mỹ viện Đà Nẵng', false);
  // h1: one successful scan without new posts.
  const one = await profile(U.h1, 'Cửa hàng tạp hóa Cần Thơ'); await scans(one, 1, { seen: 58 });
  // h5: five scans, one with new posts.
  const five = await profile(U.h5, 'Quán cà phê Quận 7'); await scans(five, 5, { hitEvery: 4, seen: 62 });
  await post(five, 'h5-a', 'Mình sắp mở quán cà phê ở Quận 7, cần tư vấn phần mềm order và máy in bill.', 40);
  // h20: two requirements, 20 scans in total, a failure and a partial.
  const a20 = await profile(U.h20, 'Nhà hàng lẩu nướng Bình Dương'); await scans(a20, 12, { hitEvery: 5, failEvery: 9, seen: 64 });
  const b20 = await profile(U.h20, 'Khách sạn mini Hà Nội'); await scans(b20, 8, { startMinutes: 12, partialEvery: 6, seen: 41 });
  await post(a20, 'h20-a', 'Nhà hàng lẩu nướng bên mình ở Thuận An cần đổi phần mềm quản lý bàn.', 35);
  await post(b20, 'h20-b', 'Khách sạn mini ở Cầu Giấy cần phần mềm quản lý phòng, ai có kinh nghiệm tư vấn giúp.', 70);
  // The two newest scans: 10 stored rows of which 8 are new leads (one incomplete, one already found by the hotel search), and exactly 1 new lead.
  await mixedScan(a20, 2, { complete: 8, incomplete: 1, duplicates: ['https://facebook.com/e2e-hist/h20-b'] });
  await mixedScan(b20, 4, { complete: 1 });
  // h200: four requirements, 200+ scans over several days, a long name, failures, partials and a delayed requirement.
  P.long = await profile(U.h200, LONG); await scans(P.long, 140, { hitEvery: 17, failEvery: 23, partialEvery: 31, seen: 66 });
  P.hotel = await profile(U.h200, 'Khách sạn mini Hà Nội'); await scans(P.hotel, 48, { startMinutes: 14, hitEvery: 20, seen: 38 });
  P.spa = await profile(U.h200, 'Spa Đà Nẵng'); await scans(P.spa, 20, { startMinutes: 300, seen: 25 });
  P.paused = await profile(U.h200, 'Cửa hàng điện thoại Biên Hòa', false); await scans(P.paused, 10, { startMinutes: 2000, every: 60, seen: 30 });
  await post(P.long, 'h200-a', 'Quán cà phê sân vườn ở Dĩ An sắp khai trương, cần máy POS và phần mềm bán hàng.', 20);
  await post(P.hotel, 'h200-b', 'Khách sạn 20 phòng ở Hoàn Kiếm cần phần mềm quản lý đặt phòng.', 90);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  await page.waitForLoadState('networkidle');
  return { context, page };
}
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string, fullPage = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial' });
const box = (p: Page, selector: string) => p.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, height: r.height }; });

const USERS = [['h0', 'E2E Hist 0'], ['h1', 'E2E Hist 1'], ['h5', 'E2E Hist 5'], ['h20', 'E2E Hist 20'], ['h200', 'E2E Hist 200']] as const;
const WIDTHS = [320, 360, 390, 440, 768, 1024, 1280, 1440];

try {
  await seed();
  const prefix = process.env.SHOT_PREFIX ?? (SHOTS_ONLY ? 'before' : 'after');
  if (SHOTS_ONLY) {
    for (const [key, label] of USERS) {
      const { context, page } = await login(label);
      await shot(page, `${prefix}-${key}-1440`);
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForLoadState('networkidle');
      await shot(page, `${prefix}-${key}-390`);
      await context.close();
    }
  } else {
    await check('history page and dashboard are tenant-scoped', async () => {
      const { context, page } = await login('E2E Hist 5');
      await page.goto(`${BASE}/app/lich-su-quet`); await page.waitForLoadState('networkidle');
      const text = await page.locator('main').innerText();
      assert(!text.includes('Khách sạn mini Hà Nội') && !text.includes('Spa Đà Nẵng'), 'another user\'s requirement is visible');
      await page.goto(`${BASE}/app/lich-su-quet?nhu-cau=${P.long}`); await page.waitForLoadState('networkidle');
      assert(!(await page.locator('main').innerText()).includes('Dĩ An'), 'foreign profile filter leaked rows');
      await context.close();
    });

    for (const [key, label] of USERS) {
      await check(`dashboard ${key}: balanced columns, no overflow at every width`, async () => {
        const { context, page } = await login(label);
        const notes: string[] = [];
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 }); await page.reload(); await page.waitForLoadState('networkidle');
          assert(await noOverflow(page), `horizontal overflow at ${width}px`);
          if (await page.locator('.today-grid').count()) {
            const panel = await box(page, '.scan-panel');
            // The scan panel must not grow with the history: bounded whatever the scan count (it is taller only when narrow, where it stacks).
            assert(panel.height < (width >= 1024 ? 800 : 900), `scan panel ${Math.round(panel.height)}px tall at ${width}px`);
            notes.push(`${width}:${Math.round(panel.height)}`);
          }
          if ([320, 390, 768, 1024, 1440].includes(width)) await shot(page, `after-${key}-${width}`);
        }
        await context.close();
        return notes.join(' ');
      });
    }

    const totalScans = async (user: string, extra = '') => Number((await q<{ n: string }>(`SELECT count(*) n FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id WHERE ac.user_id = $1 ${extra}`, [user]))[0].n);
    const sumNewPosts = async (user: string, extra = '') => Number((await q<{ n: string }>(`SELECT coalesce(sum(sr.new_posts), 0) n FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id WHERE ac.user_id = $1 ${extra}`, [user]))[0].n);
    const POSTS_EXAMINED = /đã (xem|quét|kiểm tra) \d+|bài đăng đã/i;

    await check('dashboard h20: new leads counted like the lead list (8 of 10 stored rows), 1 lead, failure, 24h summary', async () => {
      const { context, page } = await login('E2E Hist 20');
      const rows = await page.locator('.scan-recent > li').allInnerTexts();
      assert(/Tìm thấy\s*8\s*lead mới/.test(rows[0]), `newest row reads: ${rows[0]?.replace(/\n/g, ' | ')}`);
      assert(/Tìm thấy\s*1\s*lead mới/.test(rows[1]), `second row reads: ${rows[1]?.replace(/\n/g, ' | ')}`);
      assert(!rows.join(' ').includes('10 lead'), 'raw stored-row count shown as leads');
      const panel = await page.locator('.scan-panel').innerText();
      assert(!POSTS_EXAMINED.test(panel), 'posts-examined count still shown');
      assert(!panel.includes('Thành công'), 'repeated success badge still shown');
      // Every hit in the last 24h is a new lead except the incomplete row and the duplicate URL of the 8-lead scan.
      const expected = await sumNewPosts(U.h20, "AND sr.scanned_at > now() - interval '24 hours'") - 2;
      const scans24 = await totalScans(U.h20, "AND sr.scanned_at > now() - interval '24 hours'");
      assert(panel.includes(`24 giờ qua · ${scans24} lượt tìm · ${expected} lead mới`), `summary: ${panel.match(/24 giờ qua[^\n]*/)?.[0]}, expected ${scans24} lượt / ${expected} lead`);
      // Two searches: rows name the search they belong to.
      assert(await page.locator('.scan-recent .scan-row-source').count() >= 2, 'search names missing with two searches');
      await page.goto(`${BASE}/app/lich-su-quet`); await page.waitForLoadState('networkidle');
      const history = await page.locator('main').innerText();
      assert(/Không nhận được kết quả/.test(history) && /Lỗi/.test(history), 'failed scan not shown as an error in history');
      assert(/Đã tìm xong · Chưa có lead mới/.test(history), 'zero-lead wording missing in history');
      assert(!POSTS_EXAMINED.test(history), 'posts-examined count in history');
      await context.close();
      return `24h: ${scans24} lượt, ${expected} lead`;
    });

    await check('dashboard h5: single search shows no repeated search name', async () => {
      const { context, page } = await login('E2E Hist 5');
      assert(await page.locator('.scan-recent .scan-row-source:not(.is-muted)').count() === 0, 'search name repeated for a single search');
      const text = await page.locator('.scan-panel').innerText();
      assert(/Tìm thấy\s*\d+\s*lead mới/.test(text) || /Chưa có lead mới/.test(text), 'no result wording');
      await context.close();
    });

    await check('dashboard h200: bounded preview, folded zero-lead scans, link to full history', async () => {
      const { context, page } = await login('E2E Hist 200');
      const count = await page.locator('.scan-recent > li').count();
      assert(count >= 1 && count <= 7 && await page.locator('.scan-recent > li:not(.is-folded)').count() <= 3, `${count} recent rows`);
      const text = await page.locator('.scan-panel').innerText();
      assert(/Đã tìm xong( \d+ lượt)? · Chưa có lead mới/.test(text), 'folded zero-lead row missing');
      assert(!POSTS_EXAMINED.test(text), 'posts-examined count still shown');
      const link = page.getByRole('link', { name: /Xem toàn bộ lịch sử/ });
      const total = await totalScans(U.h200);
      assert((await link.innerText()).includes(String(total)), `link does not show total ${total}`);
      await context.close();
      return `${count} rows, total ${total}`;
    });

    await check('full history: grouped by day, paginated, every row reachable, day totals match', async () => {
      const { context, page } = await login('E2E Hist 200');
      await page.goto(`${BASE}/app/lich-su-quet`); await page.waitForLoadState('networkidle');
      await shot(page, 'after-history-h200-1440');
      const total = await totalScans(U.h200);
      assert(await page.locator('.history-day').count() >= 1, 'no day groups');
      const pages = Number((await page.locator('.history-pager').innerText()).match(/Trang 1\/(\d+)/)?.[1]);
      assert(pages === Math.ceil(total / 50), `pager shows ${pages} pages for ${total} rows`);
      let seen = await page.locator('.history-runs > li').count();
      for (let n = 2; n <= pages; n += 1) {
        await page.goto(`${BASE}/app/lich-su-quet?trang=${n}`); await page.waitForLoadState('networkidle');
        assert(await page.locator('.history-pager').innerText().then(t => t.includes(`Trang ${n}/${pages}`)), `page ${n} not shown`);
        seen += await page.locator('.history-runs > li').count();
      }
      await page.goto(`${BASE}/app/lich-su-quet`); await page.getByRole('link', { name: 'Trang sau' }).click();
      await page.waitForURL(/trang=2/);
      assert(seen === total, `rendered ${seen} of ${total} rows across ${pages} pages`);
      // Today's header carries whole-day totals (every generated post of this user is a complete, unique lead).
      await page.goto(`${BASE}/app/lich-su-quet`); await page.waitForLoadState('networkidle');
      const todayHead = await page.locator('.history-day-head').first().innerText();
      const day = "AND (sr.scanned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
      const want = `${await totalScans(U.h200, day)} lượt tìm · ${await sumNewPosts(U.h200, day)} lead mới`;
      assert(todayHead.includes(want), `day header "${todayHead.replace(/\n/g, ' ')}" lacks "${want}"`);
      await page.goto(`${BASE}/app/lich-su-quet?nhu-cau=${P.spa}`); await page.waitForLoadState('networkidle');
      const first = await page.locator('.history-runs > li').first().innerText();
      assert(first.includes('Đã tìm xong · Chưa có lead mới') && !first.includes('Lỗi') && !POSTS_EXAMINED.test(first), `zero-lead row reads: ${first.replace(/\n/g, ' | ')}`);
      await context.close();
      return `${total} rows on ${pages} pages`;
    });

    await check('full history: requirement filter and "only new leads" filter', async () => {
      const { context, page } = await login('E2E Hist 200');
      await page.goto(`${BASE}/app/lich-su-quet?nhu-cau=${P.hotel}`); await page.waitForLoadState('networkidle');
      const filtered = await page.locator('.history-panel').innerText();
      assert(await page.locator('.history-runs > li').count() > 0 && !filtered.includes('Spa Đà Nẵng') && !filtered.includes('Thủ Đức'), 'profile filter shows other requirements');
      await page.goto(`${BASE}/app/lich-su-quet?bai-moi=1`); await page.waitForLoadState('networkidle');
      const results = await page.locator('.history-runs .scan-row-result').allInnerTexts();
      assert(results.length > 0 && results.every(r => /Tìm thấy\s*\d+\s*lead mới/.test(r)), 'new-only filter shows rows without leads');
      const expected = await totalScans(U.h200, 'AND sr.new_posts > 0');
      assert(results.length === Math.min(expected, 50), `new-only shows ${results.length}, expected ${expected}`);
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 900 }); await page.reload(); await page.waitForLoadState('networkidle');
        assert(await noOverflow(page), `history overflow at ${width}px`);
      }
      await page.goto(`${BASE}/app/lich-su-quet`); await page.waitForLoadState('networkidle');
      await shot(page, 'after-history-h200-390');
      await page.setViewportSize({ width: 768, height: 1000 }); await page.reload(); await page.waitForLoadState('networkidle');
      await shot(page, 'after-history-h200-768');
      await context.close();
    });

    await check('no console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
  }
} finally {
  writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  // KEEP_FIXTURES=1 leaves the seeded users in the test DB for manual inspection.
  if (!process.env.KEEP_FIXTURES) await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]);
  await pool.end();
}
const failed = results.filter(r => !r.pass).length;
if (!SHOTS_ONLY) console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
