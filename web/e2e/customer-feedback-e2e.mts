// Browser + API E2E for the one-time customer feedback invitation and /admin/feedback, on an ISOLATED test database
// (muse_bridge_test*), never the live one. It deletes and recreates only its own E2E users. Time thresholds are tested
// with fixture timestamps (first_opened_at in the past), never by changing a clock.
//
// 1. Build and start the web app against the test DB (migrations through 019), from web/:
//    DATABASE_URL=postgres://…/muse_bridge_test_feedback QLEAD_ENVIRONMENT=local QLEAD_DIST_DIR=.next-feedback npm run build
//    … QLEAD_ADMIN_USER_IDS=00000000-0000-4000-8000-0000000000ad npx next start -H 127.0.0.1 -p 3019
// 2. From the repo root with the same DATABASE_URL: npx tsx web/e2e/customer-feedback-e2e.mts http://127.0.0.1:3019
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3019';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at a muse_bridge_test* database.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/customer-feedback/screenshots');
mkdirSync(SHOTS, { recursive: true });

const id = (n: string) => `00000000-0000-4000-8000-0000000f${n.padStart(4, '0')}`;
const ID = {
  admin: '00000000-0000-4000-8000-0000000000ad', fresh: id('1'), leadsOnly: id('2'), two: id('3'), recent: id('4'),
  eligible: id('5'), decliner: id('6'), tabs: id('7'), suspended: id('8'), other: id('9'), voluntary: id('10'),
};
const NAMES: Record<keyof typeof ID, string> = {
  admin: 'E2E Admin', fresh: 'E2E Mới', leadsOnly: 'E2E Có Lead', two: 'E2E Mở Hai', recent: 'E2E Mới Mở', eligible: 'E2E Đủ Điều Kiện',
  decliner: 'E2E Đóng Lời Mời', tabs: 'E2E Nhiều Tab', suspended: 'E2E Tạm Dừng', other: 'E2E Khách Khác', voluntary: 'E2E Tự Góp Ý',
};
const SPECIAL = `<img src=x onerror="window.__xss=1"> & "ngoặc" 'đơn' 😀 \u202Eđảo`;
/** What the server stores and the Admin sees: the same text without the bidi override. */
const SPECIAL_SAVED = SPECIAL.replace('\u202E', '');
/** First wait in components/customer-feedback.tsx plus margin. */
const SETTLE = 12_000;

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
let step = '';
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { const detail = `${(e as Error).message.split('\n')[0]}${step ? ` [bước: ${step}]` : ''}`; results.push({ name, pass: false, detail }); console.log(`FAIL ${name} — ${detail}`); }
  finally { step = ''; }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const posts: Record<string, string[]> = {};

async function resetFixtures() {
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(ID)]);
  for (const key of Object.keys(ID) as Array<keyof typeof ID>) {
    await pool.query(`INSERT INTO users(id, display_name, created_at) VALUES ($1, $2, now() - interval '20 days')`, [ID[key], NAMES[key]]);
    if (key !== 'admin') await pool.query(`INSERT INTO user_accounts(user_id, email, password_hash, onboarding_completed_at) VALUES ($1, $2, 'scrypt$e2e-not-a-real-hash', now() - interval '20 days')`, [ID[key], `${key.toLowerCase()}@e2e.qlead.test`]);
    if (key === 'fresh' || key === 'admin') continue;
    const { rows: [p] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind, created_at) VALUES ($1, 'Quán cafe sắp khai trương', 'search_profile', now() - interval '10 days') RETURNING id", [ID[key]]);
    await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at) VALUES ($1, 1, true, '["e2e"]', '', '["social.search"]', 30, 'Tìm quán cafe', now() - interval '10 days')`, [p.id]);
    posts[key] = [];
    for (let i = 1; i <= 5; i++) {
      const url = `https://facebook.com/groups/e2e-feedback-${key.toLowerCase()}/posts/${i}`;
      const { rows: [post] } = await pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, platform) VALUES ($1, $2, $2, $3, $4, now() - make_interval(hours => $5), 'facebook') RETURNING id`,
        [p.id, url, `Bài viết E2E số ${i}: quán cafe sắp khai trương ở Quận ${i} cần máy POS`, `Chủ quán ${i}`, i]);
      posts[key].push(post.id);
    }
    await pool.query(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) SELECT agent_connection_id, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1`, [p.id]);
    await pool.query(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, $2, 1, now() - interval '20 minutes', 9, 5, 5, 0)`, [p.id, `e2e-feedback-${key}`]);
  }
  // Fixture clock: opens recorded in the past (the app itself only ever writes now()).
  const opens = async (key: keyof typeof ID, count: number, hoursAgo: number) => {
    for (let i = 0; i < count; i++) await pool.query(`INSERT INTO lead_source_opens(user_id, normalized_url, post_id, first_opened_at) SELECT $1, normalized_url, id, now() - make_interval(hours => $3) + make_interval(mins => $4) FROM facebook_posts WHERE id = $2`, [ID[key], posts[key]![i], hoursAgo, i]);
  };
  await opens('two', 2, 72);
  await opens('recent', 3, 5);
  for (const key of ['eligible', 'decliner', 'tabs', 'suspended'] as const) await opens(key, 3, 26);
  await pool.query(`UPDATE users SET lead_monitoring_status = 'suspended', lead_monitoring_changed_at = now(), lead_monitoring_suspended_at = now() WHERE id = $1`, [ID.suspended]);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium', headless: true });
const pageErrors: string[] = [];
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** A real server-side session row and its HttpOnly cookie, as the login route would create (no DEV login needed). */
async function signIn(key: keyof typeof ID, options: { width?: number; height?: number; reducedMotion?: 'reduce' | 'no-preference'; context?: BrowserContext } = {}): Promise<{ context: BrowserContext; page: Page }> {
  let context = options.context;
  if (!context) {
    context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, deviceScaleFactor: 1, reducedMotion: options.reducedMotion ?? 'no-preference', hasTouch: (options.width ?? 1440) < 800, isMobile: (options.width ?? 1440) < 500 });
    const token = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')`, [ID[key], sha(token)]);
    await context.addCookies([{ name: 'qlead_session', value: token, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    // Facebook is never contacted: a stand-in page answers the original-post links.
    await context.route(/https:\/\/(www\.)?facebook\.com\/.*/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Facebook (E2E stand-in)</title>' }));
  }
  const page = await context.newPage();
  page.on('pageerror', e => pageErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/app`);
  return { context, page };
}
const panel = (p: Page) => p.locator('section.fb-panel');
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string, fullPage = false) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial', animations: 'disabled' });
const invitation = async (key: keyof typeof ID) => (await pool.query('SELECT status, shown_at, responded_at FROM customer_feedback_invitations WHERE user_id = $1', [ID[key]])).rows[0] ?? null;
const feedbackRows = async (key: keyof typeof ID) => (await pool.query('SELECT * FROM customer_feedback WHERE user_id = $1 ORDER BY created_at', [ID[key]])).rows;
async function neverShows(key: keyof typeof ID, label: string) {
  const { context, page } = await signIn(key);
  await page.waitForTimeout(SETTLE);
  assert(await panel(page).count() === 0, `${label}: invitation appeared`);
  await context.close();
}

await resetFixtures();

await check('1. Tài khoản mới chưa có lead: không hiện lời mời', () => neverShows('fresh', 'fresh'));
await check('2. Có lead nhưng chưa mở bài Facebook: không hiện', () => neverShows('leadsOnly', 'leads only'));
await check('3. Mới mở 1–2 bài Facebook: không hiện', () => neverShows('two', 'two opens'));
await check('4. Đã mở 3 bài nhưng chưa đủ 24 giờ: không hiện', async () => { await neverShows('recent', 'recent'); assert(!await invitation('recent'), 'a row was stored for an ineligible account'); });
await check('19. Tài khoản bị Admin tạm dừng: không tự mời', async () => { await neverShows('suspended', 'suspended'); assert(!await invitation('suspended'), 'suspended account was invited'); });

await check('20 + 6. "Xem bài Facebook" mở ngay, ghi nhận 1 lần mỗi lead, không đổi trạng thái "Đã xem"', async () => {
  const { context, page } = await signIn('leadsOnly');
  await page.goto(`${BASE}/app/bai-viet`);
  const link = page.locator('.lead-table .fb-link').first();
  await link.waitFor();
  const href = await link.getAttribute('href');
  const t0 = Date.now();
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForURL(href!);
  const openMs = Date.now() - t0;
  await popup.close();
  for (let i = 0; i < 3; i++) { const [again] = await Promise.all([context.waitForEvent('page'), link.click()]); await again.close(); }
  await page.waitForTimeout(800);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM lead_source_opens WHERE user_id = $1', [ID.leadsOnly]);
  assert(rows[0].n === 1, `expected 1 open row, got ${rows[0].n}`);
  const states = await pool.query('SELECT count(*)::int AS n FROM lead_states WHERE user_id = $1', [ID.leadsOnly]);
  assert(states.rows[0].n === 0, 'opening Facebook changed the lead status');
  // Another lead from the mobile card list counts as a second distinct lead.
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator('.lead-cards .fb-link').nth(1);
  const [p2] = await Promise.all([context.waitForEvent('page'), card.click()]);
  await p2.close();
  await page.waitForTimeout(800);
  const after = await pool.query('SELECT count(*)::int AS n FROM lead_source_opens WHERE user_id = $1', [ID.leadsOnly]);
  assert(after.rows[0].n === 2, `expected 2 distinct opens, got ${after.rows[0].n}`);
  await context.close();
  return `Facebook mở sau ${openMs} ms; 4 lần bấm cùng 1 bài → 1 dòng; bài thứ hai → 2 dòng`;
});

await check('5 + 12 + 10 + 13 + 14 + 11. Đủ điều kiện: hiện đúng lúc, lỗi mạng giữ câu trả lời, gửi lại thành công, cảm ơn', async () => {
  const { context, page } = await signIn('eligible');
  await panel(page).waitFor({ timeout: 20_000 });
  assert(await page.locator('[aria-modal="true"]').count() === 0, 'invitation must not be modal');
  await page.waitForTimeout(500);
  await shot(page, 'invite-1440');
  assert((await invitation('eligible'))?.status === 'shown', 'claim not stored');
  await panel(page).getByRole('button', { name: 'Góp ý' }).click();
  const form = panel(page);
  await form.getByRole('radio', { name: '4 sao: Dễ dùng' }).click();
  await form.getByRole('radio', { name: '2 sao: Đáp ứng ít' }).click();
  const reason = form.getByLabel(/Điểm nào QLead chưa đáp ứng tốt/);
  assert(await reason.isVisible(), 'reason field should open for a low rating');
  await form.getByLabel(/Bạn muốn QLead cải tiến/).fill(SPECIAL);
  await page.waitForTimeout(300);
  await shot(page, 'form-1440');
  // Network failure: nothing saved, answers kept, retry possible.
  await page.route('**/api/feedback', route => route.abort('internetdisconnected'));
  step = 'gửi khi mất mạng';
  await form.getByRole('button', { name: 'Gửi góp ý' }).click();
  await form.getByRole('alert').waitFor();
  assert((await feedbackRows('eligible')).length === 0, 'saved during network failure');
  assert(await form.getByLabel(/Bạn muốn QLead cải tiến/).inputValue() === SPECIAL, 'answer lost after network error');
  assert(await form.getByRole('radio', { name: '4 sao: Dễ dùng' }).getAttribute('aria-checked') === 'true', 'rating lost after network error');
  await shot(page, 'form-network-error-1440');
  await page.unroute('**/api/feedback');
  // Slow server: the loading state shows and a double click sends one row.
  let posts = 0;
  await page.route('**/api/feedback', async route => { posts += 1; await new Promise(r => setTimeout(r, 700)); await route.continue(); });
  step = 'gửi lại';
  const send = await form.getByRole('button', { name: 'Thử gửi lại' }).elementHandle();
  await send!.click();
  await send!.click({ force: true, timeout: 1_000 }).catch(() => undefined);
  await form.getByText('Đang gửi…').waitFor();
  step = 'chờ cảm ơn';
  await form.getByText('Cảm ơn bạn đã góp ý!').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(900);
  await shot(page, 'thanks-1440');
  const rows = await feedbackRows('eligible');
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(posts === 1, `double click sent ${posts} requests`);
  assert(rows[0].ease_rating === 4 && rows[0].needs_rating === 2 && rows[0].unmet_reason === null && rows[0].improvement === SPECIAL_SAVED && rows[0].source === 'invitation', `stored ${JSON.stringify(rows[0])}`);
  assert((await invitation('eligible'))?.status === 'submitted', 'invitation not final');
  // Auto-close after the thank-you; refresh shows nothing and sends nothing.
  step = 'tự đóng sau cảm ơn';
  await page.mouse.move(5, 5);
  await panel(page).waitFor({ state: 'detached', timeout: 10_000 });
  await page.reload();
  await page.waitForTimeout(SETTLE);
  assert(await panel(page).count() === 0, 'shown again after refresh');
  assert((await feedbackRows('eligible')).length === 1, 'refresh duplicated feedback');
  await context.close();
});

await check('8 + 9. Đăng xuất/đăng nhập lại và thiết bị khác (390px): không hiện lại', async () => {
  const { context, page } = await signIn('eligible', { width: 390, height: 844 });
  await page.waitForTimeout(SETTLE);
  assert(await panel(page).count() === 0, 'shown on another device');
  await context.close();
});

await check('7. Bấm X (390px): đóng ngay, ghi "đã đóng", không bao giờ hiện lại', async () => {
  const { context, page } = await signIn('decliner', { width: 390, height: 844 });
  await panel(page).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await shot(page, 'invite-390');
  assert(await noOverflow(page), 'horizontal overflow at 390');
  const box = await panel(page).boundingBox();
  const nav = await page.locator('.bottom-nav').boundingBox();
  assert(box && nav && box.y + box.height <= nav.y + 1, 'invitation covers the bottom navigation');
  const t0 = Date.now();
  await panel(page).getByRole('button', { name: /Đóng, QLead sẽ không hỏi lại/ }).click();
  await panel(page).waitFor({ state: 'detached' });
  const closeMs = Date.now() - t0;
  await page.waitForTimeout(600);
  assert((await invitation('decliner'))?.status === 'declined', 'decline not stored');
  assert((await feedbackRows('decliner')).length === 0, 'closing created a rating');
  await page.reload();
  await page.waitForTimeout(SETTLE);
  assert(await panel(page).count() === 0, 'shown after X + refresh');
  await context.close();
  const second = await signIn('decliner', { width: 1440 });
  await second.page.waitForTimeout(SETTLE);
  assert(await panel(second.page).count() === 0, 'shown on another device after X');
  await second.context.close();
  return `đóng sau ${closeMs} ms`;
});

await check('18. Nhiều tab cùng lúc: chỉ một lời mời', async () => {
  const first = await signIn('tabs', { width: 768, height: 1024 });
  const second = await signIn('tabs', { context: first.context });
  await first.page.bringToFront();
  await first.page.waitForTimeout(SETTLE + 3_000);
  const shown = (await panel(first.page).count()) + (await panel(second.page).count());
  assert(shown === 1, `shown in ${shown} tabs`);
  const page = (await panel(first.page).count()) ? first.page : second.page;
  await page.bringToFront();
  await panel(page).getByRole('button', { name: 'Góp ý' }).click();
  await panel(page).getByRole('radio', { name: '5 sao: Rất dễ dùng' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'form-768');
  assert(await noOverflow(page), 'horizontal overflow at 768');
  // Keyboard: arrows move the rating, Escape closes (= declined).
  await page.keyboard.press('ArrowLeft');
  assert(await panel(page).getByRole('radio', { name: '4 sao: Dễ dùng' }).getAttribute('aria-checked') === 'true', 'arrow keys do not change the rating');
  await page.keyboard.press('Escape');
  await panel(page).waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  assert((await invitation('tabs'))?.status === 'declined', 'Escape not stored as declined');
  await first.context.close();
});

await check('Tự góp ý từ "Góp ý cho QLead" (390px + 1440px), bỏ trống câu 1 và 2', async () => {
  const { context, page } = await signIn('voluntary', { width: 390, height: 844 });
  await page.goto(`${BASE}/app/thong-bao`);
  await page.getByRole('button', { name: 'Gửi góp ý' }).click();
  const dialog = page.getByRole('dialog', { name: 'Góp ý cho QLead' });
  await dialog.waitFor();
  await dialog.getByLabel(/Bạn muốn QLead cải tiến/).fill('Cho xuất danh sách lead ra Excel.');
  await page.waitForTimeout(300);
  await shot(page, 'voluntary-390');
  await dialog.getByRole('button', { name: 'Gửi góp ý' }).click();
  await page.getByText('Cảm ơn bạn đã góp ý!').waitFor();
  const rows = await feedbackRows('voluntary');
  assert(rows.length === 1 && rows[0].source === 'voluntary' && rows[0].ease_rating === null && rows[0].needs_rating === null, `stored ${JSON.stringify(rows)}`);
  assert((await invitation('voluntary'))?.status === 'submitted', 'voluntary feedback should end automatic invitations');
  await page.getByRole('button', { name: 'Đóng' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/app`);
  assert(await page.locator('.sidebar').getByRole('button', { name: 'Góp ý cho QLead' }).isVisible(), 'sidebar entry missing');
  await context.close();
});

await check('15 + 16. Khách khác không đọc được góp ý, không vào được Admin, không giả mạo được yêu cầu', async () => {
  const { context, page } = await signIn('other');
  const admin = await page.goto(`${BASE}/admin/feedback`);
  assert(admin?.status() === 404, `customer got ${admin?.status()} on /admin/feedback`);
  assert(!(await page.content()).includes('E2E Đủ Điều Kiện'), 'admin data leaked');
  const reused = await page.evaluate(async submissionId => (await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submissionId, context: 'voluntary', easeRating: 1 }) })).status, (await feedbackRows('eligible'))[0].submission_id);
  assert(reused === 409, `reusing another account's submission id returned ${reused}`);
  const forged = await page.evaluate(async () => {
    const r = await fetch('/api/feedback/invitation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim', userId: '00000000-0000-4000-8000-0000000f0005' }) });
    return r.status;
  });
  assert(forged === 400, `extra fields accepted (${forged})`);
  const csrf = await fetch(`${BASE}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert(csrf.status === 403, `cross-origin POST returned ${csrf.status}`);
  const anon = await fetch(`${BASE}/api/feedback/invitation`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ action: 'claim' }) });
  assert(anon.status === 401, `anonymous claim returned ${anon.status}`);
  const bad = await page.evaluate(async () => (await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submissionId: crypto.randomUUID(), context: 'voluntary', easeRating: 9 }) })).status);
  assert(bad === 400, `invalid rating returned ${bad}`);
  const foreignOpen = await page.evaluate(async postId => (await fetch(`/api/leads/${postId}/source-open`, { method: 'POST' })).status, posts.eligible![4]);
  assert(foreignOpen === 404, `opening another account's lead returned ${foreignOpen}`);
  await context.close();
});

await check('17. Admin xem thống kê và nội dung chính xác (1440/768/390), ký tự đặc biệt hiển thị an toàn', async () => {
  const { context, page } = await signIn('admin');
  await page.goto(`${BASE}/admin/feedback`);
  await page.getByRole('heading', { name: 'Phản hồi khách hàng' }).waitFor();
  const { rows: [expected] } = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE unmet_reason IS NOT NULL OR improvement IS NOT NULL)::int AS text,
    round(avg(ease_rating), 2)::float AS ease, (SELECT count(*)::int FROM customer_feedback_invitations WHERE status = 'declined') AS declined FROM customer_feedback`);
  const stat = async (label: string) => (await page.locator('.fbr-stats > div', { hasText: label }).locator('dd').innerText()).replace(/\s+/g, '');
  assert(await stat('Lượt góp ý') === String(expected.n), `responses ${await stat('Lượt góp ý')} ≠ ${expected.n}`);
  assert(await stat('Có nội dung viết') === String(expected.text), 'text count mismatch');
  assert((await stat('Dễ sử dụng (TB)')).startsWith(expected.ease.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 2 })), `ease avg ${await stat('Dễ sử dụng (TB)')} vs ${expected.ease}`);
  assert((await page.locator('.fbr-invites').innerText()).includes(`${expected.declined} đã đóng`), 'dismissals not shown separately');
  assert(await page.getByText(SPECIAL_SAVED, { exact: true }).count() === 1, 'special characters not rendered as text');
  assert(await page.evaluate(() => !(window as unknown as { __xss?: number }).__xss && !document.querySelector('.fbr-text img')), 'markup from feedback was executed');
  await shot(page, 'admin-feedback-1440', true);
  await page.getByRole('link', { name: /Điểm thấp/ }).click();
  await page.waitForURL(/loc=thap/);
  assert(await page.locator('.fbr-item').count() >= 1, 'low filter empty');
  for (const [w, h] of [[768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}/admin/feedback`);
    assert(await noOverflow(page), `horizontal overflow at ${w}`);
    await shot(page, `admin-feedback-${w}`, true);
  }
  await context.close();
});

await check('21 + 22. Điều hướng không thêm yêu cầu góp ý; GOAT và PWA vẫn hoạt động', async () => {
  const { context, page } = await signIn('eligible');
  const feedbackCalls: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/feedback')) feedbackCalls.push(r.url()); });
  const times: number[] = [];
  for (const href of ['/app/bai-viet', '/app', '/app/lich-su-quet', '/app', '/app/bai-viet', '/app']) {
    const t0 = Date.now();
    await page.locator(`.side-nav a[href="${href}"], .scan-panel a[href="${href}"]`).first().click();
    await page.waitForURL(`${BASE}${href}`);
    await page.locator('main h1').first().waitFor();
    times.push(Date.now() - t0);
  }
  assert(feedbackCalls.length === 0, `navigation sent ${feedbackCalls.length} feedback requests (done hint)`);
  const sw = await fetch(`${BASE}/sw.js`);
  assert(sw.ok && (sw.headers.get('cache-control') ?? '').includes('no-store'), 'service worker not served as before');
  const manifest = await fetch(`${BASE}/manifest.webmanifest`);
  assert(manifest.ok, 'manifest missing');
  await page.goto(`${BASE}/app/thong-bao`);
  await page.locator('.pwa-page').waitFor({ timeout: 10_000 });
  const goat = await fetch(`${BASE}/brand/qlead-goat-full.svg`);
  assert(goat.ok, 'goat asset missing');
  await context.close();
  return `chuyển trang (ms): ${times.join(', ')}`;
});

await check('Giảm chuyển động: lời mời và cảm ơn không có animation', async () => {
  await pool.query(`DELETE FROM customer_feedback_invitations WHERE user_id = $1`, [ID.decliner]); // fixture reset for this check only
  const { context, page } = await signIn('decliner', { reducedMotion: 'reduce' });
  await panel(page).waitFor({ timeout: 20_000 });
  const animation = await panel(page).evaluate(el => getComputedStyle(el).animationName);
  assert(animation === 'none', `panel animates with reduced motion (${animation})`);
  await panel(page).getByRole('button', { name: 'Không, cảm ơn' }).click();
  await panel(page).waitFor({ state: 'detached' });
  await context.close();
});

await check('Không có lỗi JavaScript trên trang', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')); });

await browser.close();
const passed = results.filter(r => r.pass).length;
writeFileSync(resolve(SHOTS, '..', 'customer-feedback-e2e-results.txt'), `${results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')}\n\n${passed}/${results.length} passed\n`);
console.log(`\n${passed}/${results.length} passed`);
await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(ID).filter(v => v !== ID.admin)]).catch(() => undefined);
await pool.end();
process.exit(passed === results.length ? 0 : 1);
