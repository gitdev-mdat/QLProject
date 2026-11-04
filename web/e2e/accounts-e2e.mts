// Registration, onboarding and session isolation E2E on the ISOLATED test database (never the live one).
// Every scenario uses its own browser context (no shared cookies).
// 1. Start the web app against the test DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; $env:QLEAD_DIST_DIR='.next-profiles-e2e'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'; $env:DEV_QUICK_LOGIN_USERS='seller:E2E Seller A:00000000-0000-4000-8000-00000000acc1'
//    npm run dev -- -p 3005
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/accounts-e2e.mts http://127.0.0.1:3005 [prodUrl]
//    prodUrl (optional): a `next start` build of the same app with ENABLE_DEV_QUICK_LOGIN=true, to prove it is ignored.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
const PROD = process.argv[3];
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/account-screenshots');
mkdirSync(SHOTS, { recursive: true });

const SELLER = '00000000-0000-4000-8000-00000000acc1';
const RUN = randomBytes(4).toString('hex');
const email = (tag: string) => `e2e-acct-${RUN}-${tag}@qlead.test`;
const PASSWORD = `E2e-${randomBytes(6).toString('hex')}`;
const DESCRIPTION = 'Tôi bán phần mềm quản lý, muốn tìm quán cafe và nhà hàng sắp khai trương tại miền Nam.';
const seller = { profile: '', post: '' };

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

/** Removes only rows this run created: the seeded DEV seller and accounts whose email carries this run's tag. */
async function cleanup() {
  const own = await q<{ user_id: string }>("SELECT user_id FROM user_accounts WHERE email LIKE $1", [`e2e-acct-${RUN}-%@qlead.test`]);
  await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [[SELLER, ...own.map(row => row.user_id)]]);
}
async function seed() {
  await q('DELETE FROM users WHERE id = $1', [SELLER]);
  await q("INSERT INTO users(id, display_name) VALUES ($1, 'E2E Seller A')", [SELLER]);
  seller.profile = (await q<{ id: string }>("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'F&B của Seller A', 'search_profile') RETURNING id", [SELLER]))[0].id;
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description) VALUES ($1, 1, true, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 30, 'Mô tả riêng của Seller A')`, [seller.profile]);
  await q("INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) VALUES ($1, $2, 1, now() - interval '10 minutes', 10, 1, 1, 0)", [seller.profile, `e2e-acct-${RUN}`]);
  seller.post = (await q<{ id: string }>(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    VALUES ($1, $2, $2, 'Quán ăn Seller A sắp khai trương ở Quận 9', 'Trang Seller A', now() - interval '2 hours', now() - interval '10 minutes', 'qlead_shared_worker') RETURNING id`, [seller.profile, `https://facebook.com/e2e-acct/${RUN}`]))[0].id;
  await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, 1)', [seller.profile, `https://facebook.com/e2e-acct/${RUN}`]);
}

const consoleErrors: string[] = [];
async function fresh(browser: Browser, width = 1440, height = 1000): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return { context, page };
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: 'initial' });
const api = (p: Page, url: string, method: string, body?: unknown) => p.evaluate(async ([u, m, b]) =>
  (await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })).status, [url, method, body] as const);
const sessionToken = async (c: BrowserContext) => (await c.cookies()).find(cookie => cookie.name === 'qlead_session')?.value ?? null;
async function register(p: Page, name: string, address: string) {
  await p.goto(`${BASE}/dang-ky`);
  await p.getByLabel('Tên của bạn').fill(name);
  await p.getByLabel('Email công việc').fill(address);
  await p.getByLabel('Mật khẩu', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await p.waitForURL(`${BASE}/bat-dau`);
}
async function login(p: Page, address: string, password = PASSWORD) {
  await p.goto(`${BASE}/dang-nhap`);
  await p.getByLabel('Email công việc').fill(address);
  await p.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await p.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let newUserId = '';
let newProfileId = '';
try {
  await seed();

  // ---------- Scenario A: new customer ----------
  const a = await fresh(browser);
  await check('A1 register through the UI creates a user, an account and a password session', async () => {
    await a.page.goto(`${BASE}/dang-ky`);
    await shot(a.page, 'register-1440');
    await register(a.page, 'E2E Khách Mới', email('new'));
    const [acct] = await q<{ user_id: string; display_name: string }>('SELECT ua.user_id, u.display_name FROM user_accounts ua JOIN users u ON u.id = ua.user_id WHERE ua.email = $1', [email('new')]);
    assert(acct && acct.display_name === 'E2E Khách Mới', 'account row');
    newUserId = acct.user_id;
    const sessions = await q<{ created_via: string }>('SELECT created_via FROM web_sessions WHERE user_id = $1 AND revoked_at IS NULL', [newUserId]);
    assert(sessions.length === 1 && sessions[0].created_via === 'password', JSON.stringify(sessions));
    const [hash] = await q<{ password_hash: string }>('SELECT password_hash FROM user_accounts WHERE user_id = $1', [newUserId]);
    assert(hash.password_hash.startsWith('scrypt$') && !hash.password_hash.includes(PASSWORD), 'password stored hashed');
    return `user ${newUserId.slice(0, 8)}`;
  });

  await check('A2 "Ngành khác" opens a description box inside onboarding', async () => {
    const p = a.page;
    await p.getByRole('button', { name: /Ngành khác\? Tự mô tả khách hàng/ }).click();
    const box = p.getByLabel('Mô tả khách hàng bạn muốn tìm');
    await box.waitFor();
    assert(p.url() === `${BASE}/bat-dau`, `left onboarding: ${p.url()}`);
    assert(!(await p.locator('body').innerText()).includes('Test User'), 'test user shown');
    await box.fill(DESCRIPTION);
    await shot(p, 'onboarding-step1-1440');
  });

  await check('A3 back and forth keeps the description and edited conditions', async () => {
    const p = a.page;
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    await p.getByRole('heading', { name: 'Kiểm tra trước khi lưu' }).waitFor();
    assert(await p.getByLabel('Khu vực', { exact: true }).inputValue() === 'Miền Nam', 'location suggested');
    await p.getByLabel('Tên nhu cầu').fill('Quán cafe nhà hàng miền Nam');
    await p.getByLabel('Khu vực', { exact: true }).selectOption('TP.HCM');
    await shot(p, 'onboarding-step2-1440');
    await p.getByRole('button', { name: /Quay lại/ }).click();
    assert(await p.getByLabel('Mô tả khách hàng bạn muốn tìm').inputValue() === DESCRIPTION, 'description lost');
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    assert(await p.getByLabel('Tên nhu cầu').inputValue() === 'Quán cafe nhà hàng miền Nam', 'name lost');
    assert(await p.getByLabel('Khu vực', { exact: true }).inputValue() === 'TP.HCM', 'edited area lost');
    assert(await p.locator('.search-preview .keyword-chips li').count() > 0, 'search phrases previewed');
  });

  await check('A4 finishing onboarding saves the first profile under the new user only', async () => {
    const p = a.page;
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    await shot(p, 'onboarding-step3-1440');
    await p.getByRole('button', { name: /Lưu và vào QLead/ }).click();
    await p.waitForURL(`${BASE}/app/lan-tim-dau`);
    await p.goto(`${BASE}/app`);
    const profiles = await q<{ id: string; user_id: string; name: string; description: string; enabled: boolean }>(`SELECT ac.id, ac.user_id, ac.name, sc.description, sc.enabled FROM agent_connections ac JOIN scan_configs sc ON sc.agent_connection_id = ac.id WHERE ac.user_id = $1`, [newUserId]);
    assert(profiles.length === 1 && profiles[0].name === 'Quán cafe nhà hàng miền Nam' && profiles[0].description === DESCRIPTION && profiles[0].enabled, JSON.stringify(profiles));
    newProfileId = profiles[0].id;
    const [acct] = await q<{ done: boolean }>('SELECT onboarding_completed_at IS NOT NULL AS done FROM user_accounts WHERE user_id = $1', [newUserId]);
    assert(acct.done, 'onboarding not marked complete');
    const [{ posts }] = await q<{ posts: number }>('SELECT count(*)::int AS posts FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1', [newUserId]);
    assert(posts === 0, 'leads were created or copied');
    return `profile ${newProfileId.slice(0, 8)}, 0 posts`;
  });

  await check('A5 the new dashboard is empty and never shows the DEV seller or a DEV banner', async () => {
    const p = a.page;
    const text = await p.locator('body').innerText();
    assert(!text.includes('Seller A') && !text.includes('Phiên đăng nhập nhanh DEV'), 'foreign or DEV content');
    // Since the first-scan view, Today leads with it for a profile that was never scanned.
    assert(text.includes('Đang chờ bắt đầu lượt tìm đầu tiên') || text.includes('Chờ lượt quét đầu'), 'pending first scan not shown');
    await shot(p, 'new-today-1440');
    await p.goto(`${BASE}/app/bai-viet`);
    assert(await p.locator('.lead-table tbody tr').count() === 0, 'leads visible');
    await p.goto(`${BASE}/app/bo-loc`);
    const names = await p.locator('.profile-card h2').allInnerTexts();
    assert(JSON.stringify(names) === JSON.stringify(['Quán cafe nhà hàng miền Nam']), names.join('|'));
    assert(await p.getByText(`“${DESCRIPTION}”`).isVisible(), 'description not visible');
    await shot(p, 'new-profiles-1440');
  });

  await check('A6 profile and onboarding persist after refresh, logout and password login', async () => {
    const p = a.page;
    await p.reload();
    assert(await p.locator('.profile-card').count() === 1, 'lost after refresh');
    const before = await sessionToken(a.context);
    await p.getByRole('button', { name: /Đăng xuất/ }).first().click();
    await p.waitForURL(`${BASE}/dang-nhap`);
    const [revoked] = await q<{ n: number }>('SELECT count(*)::int AS n FROM web_sessions WHERE user_id = $1 AND revoked_at IS NULL', [newUserId]);
    assert(revoked.n === 0, 'session still active after logout');
    await login(p, email('new'), 'wrong-password');
    await p.getByText('Email hoặc mật khẩu không đúng.').waitFor();
    await login(p, email('new'));
    await p.waitForURL(`${BASE}/app`);
    assert(await sessionToken(a.context) !== before, 'cookie not rotated');
    await p.goto(`${BASE}/app/bo-loc`);
    assert(await p.locator('.profile-card').count() === 1, 'profile missing after re-login');
  });

  // ---------- Scenario B: DEV seller, separate context ----------
  const b = await fresh(browser);
  await check('B explicit DEV quick login shows only the seller\'s own data', async () => {
    const p = b.page;
    await p.goto(`${BASE}/dang-nhap`);
    await p.getByRole('button', { name: 'E2E Seller A', exact: true }).click();
    await p.waitForURL(`${BASE}/app`);
    await p.goto(`${BASE}/app/bo-loc`);
    const names = await p.locator('.profile-card h2').allInnerTexts();
    assert(JSON.stringify(names) === JSON.stringify(['F&B của Seller A']), names.join('|'));
    await p.goto(`${BASE}/app/bai-viet`);
    assert(await p.locator('.lead-table tbody tr').count() === 1, 'seller lead count');
    assert(!(await p.locator('body').innerText()).includes('Quán cafe nhà hàng miền Nam'), 'new customer data visible to seller');
  });

  // ---------- Scenario C: authorization ----------
  await check('C1 new customer cannot reach the seller\'s lead or profile (URL and API)', async () => {
    const p = a.page;
    await p.goto(`${BASE}/app/bai-viet/${seller.post}`);
    await p.getByRole('heading', { name: 'Không tìm thấy lead' }).waitFor({ timeout: 30000 });
    assert(!(await p.locator('body').innerText()).includes('Seller A'), 'seller content leaked');
    assert(await api(p, `/api/profiles/${seller.profile}`, 'PATCH', { action: 'pause' }) === 404, 'pause foreign');
    assert(await api(p, `/api/leads/${seller.post}`, 'PATCH', { status: 'contacted' }) === 404, 'status foreign');
    const [cfg] = await q<{ n: number }>('SELECT count(*)::int AS n FROM scan_configs WHERE agent_connection_id = $1', [seller.profile]);
    assert(cfg.n === 1, 'seller profile changed');
  });

  await check('C2 registering from a browser that holds a DEV session revokes that session', async () => {
    const p = b.page;
    const devToken = await sessionToken(b.context);
    await p.goto(`${BASE}/dang-ky`);
    await p.locator('.auth-signed-in b', { hasText: 'E2E Seller A' }).waitFor();
    await shot(p, 'register-signed-in-1440');
    await register(p, 'E2E Khách Hai', email('second'));
    const [dev] = await q<{ revoked: boolean }>("SELECT revoked_at IS NOT NULL AS revoked FROM web_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [SELLER]);
    assert(dev.revoked, 'DEV session still valid');
    const replay = await fetch(`${BASE}/app`, { headers: { cookie: `qlead_session=${devToken}` }, redirect: 'manual' });
    assert(replay.status >= 300 && replay.status < 400 && (replay.headers.get('location') ?? '').includes('/dang-nhap'), `replay ${replay.status}`);
    assert(!(await p.locator('body').innerText()).includes('Seller A'), 'seller visible in onboarding');
  });

  // ---------- Scenario D: returning and resuming ----------
  await check('D1 unfinished onboarding resumes with the typed description; /app sends back to onboarding', async () => {
    const p = b.page;
    await p.getByRole('button', { name: /Ngành khác/ }).click();
    await p.getByLabel('Mô tả khách hàng bạn muốn tìm').fill('Spa và thẩm mỹ viện sắp khai trương ở Hà Nội');
    await p.waitForTimeout(300);
    await p.goto(`${BASE}/app`);
    await p.waitForURL(`${BASE}/bat-dau`);
    assert(await p.getByLabel('Mô tả khách hàng bạn muốn tìm').inputValue() === 'Spa và thẩm mỹ viện sắp khai trương ở Hà Nội', 'draft not restored');
  });

  await check('D2 repeated onboarding submits never create a duplicate profile', async () => {
    const p = b.page;
    const body = { profile: { name: 'Spa Hà Nội', description: 'Spa và thẩm mỹ viện sắp khai trương ở Hà Nội', keywords: ['spa sắp khai trương'], location: 'Hà Nội', frequency_minutes: 30 }, enabled: false };
    const first = await p.evaluate(async b => (await (await fetch('/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()), body);
    const second = await p.evaluate(async b => (await (await fetch('/api/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()), body);
    const [{ user_id }] = await q<{ user_id: string }>('SELECT user_id FROM user_accounts WHERE email = $1', [email('second')]);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM agent_connections WHERE user_id = $1 AND kind = 'search_profile'", [user_id]);
    assert(first.created === true && second.created === false && n === 1, `${JSON.stringify(first)} ${JSON.stringify(second)} n=${n}`);
    await p.goto(`${BASE}/app/bo-loc`);
    assert((await p.locator('.profile-state').first().innerText()).includes('Bản nháp'), 'draft state');
  });

  await check('D3 returning customer lands on their dashboard; /bat-dau does not reopen onboarding', async () => {
    const r = await fresh(browser);
    await login(r.page, email('new'));
    await r.page.waitForURL(`${BASE}/app`);
    await r.page.goto(`${BASE}/bat-dau`);
    await r.page.waitForURL(`${BASE}/app`);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM agent_connections WHERE user_id = $1", [newUserId]);
    assert(n === 1, `profiles ${n}`);
    await r.context.close();
  });

  // ---------- Scenario E: unauthenticated and production ----------
  await check('E1 signed-out visitors cannot enter the app or its APIs', async () => {
    const e = await fresh(browser);
    for (const [path, target] of [['/app', '/dang-nhap'], ['/app/bo-loc', '/dang-nhap'], ['/app/bai-viet', '/dang-nhap'], ['/bat-dau', '/dang-ky']]) {
      await e.page.goto(`${BASE}${path}`);
      assert(e.page.url() === `${BASE}${target}`, `${path} → ${e.page.url()}`);
    }
    await e.page.goto(`${BASE}/dang-nhap`);
    assert(await api(e.page, '/api/profiles', 'POST', { profile: { name: 'x', description: '', keywords: ['abc'], location: 'TP.HCM', frequency_minutes: 30 }, enabled: true }) === 401, 'profiles API');
    assert(await api(e.page, '/api/onboarding', 'POST', { profile: { name: 'x', description: '', keywords: ['abc'], location: 'TP.HCM', frequency_minutes: 30 }, enabled: true }) === 401, 'onboarding API');
    assert(await e.page.locator('.auth-signed-in').count() === 0, 'phantom session notice');
    await e.context.close();
  });

  await check('E2 cross-origin register/login is rejected', async () => {
    const r1 = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x', email: email('evil'), password: PASSWORD }) });
    const r2 = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ email: email('new'), password: PASSWORD }) });
    assert(r1.status === 403 && r2.status === 403, `${r1.status} ${r2.status}`);
    const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM user_accounts WHERE email = $1', [email('evil')]);
    assert(n === 0, 'account created cross-origin');
  });

  if (PROD) await check('E3 production build ignores ENABLE_DEV_QUICK_LOGIN', async () => {
    const e = await fresh(browser);
    await e.page.goto(`${PROD}/dang-nhap`);
    assert(await e.page.getByText('Đăng nhập nhanh').count() === 0, 'DEV box rendered in production');
    const status = await e.page.evaluate(async () => (await fetch('/api/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-dev-login': '1' }, body: JSON.stringify({ user: 'seller' }) })).status);
    assert(status === 404, `dev-login ${status}`);
    await e.context.close();
  });

  for (const [w, h] of [[390, 844]]) {
    await check(`Screens at ${w}px`, async () => {
      const m = await fresh(browser, w, h);
      await m.page.goto(`${BASE}/dang-ky`); await shot(m.page, `register-${w}`);
      await register(m.page, 'E2E Khách Ba', email('third'));
      await m.page.getByRole('button', { name: /Ngành khác/ }).click();
      await m.page.getByLabel('Mô tả khách hàng bạn muốn tìm').fill(DESCRIPTION);
      await shot(m.page, `onboarding-step1-${w}`);
      await m.page.getByRole('button', { name: /Tiếp tục/ }).click(); await shot(m.page, `onboarding-step2-${w}`);
      await m.page.getByRole('button', { name: /Tiếp tục/ }).click(); await shot(m.page, `onboarding-step3-${w}`);
      await m.page.getByRole('button', { name: /Lưu và vào QLead/ }).click();
      await m.page.waitForURL(`${BASE}/app/lan-tim-dau`);
      await m.page.goto(`${BASE}/app`); await shot(m.page, `new-today-${w}`);
      const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert(!overflow, 'horizontal overflow');
      await m.context.close();
    });
  }

  await check('No browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
  await a.context.close(); await b.context.close();
} finally {
  await cleanup().catch(error => console.error('cleanup failed', error));
  await browser.close();
  await pool.end();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed, ${results.length - passed} failed`;
  console.log(summary);
  writeFileSync(resolve(SHOTS, 'results.json'), JSON.stringify({ summary, results }, null, 2));
}
