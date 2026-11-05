// Onboarding "who are you, whom do you look for" E2E on an ISOLATED database (muse_bridge_test_goat).
// A synthetic registered account (user_accounts row, onboarding not completed) gets a session row directly.
// 1. From web/: $env:DATABASE_URL=<…/muse_bridge_test_goat>; $env:QLEAD_DIST_DIR='.next-goat'; npx next dev --webpack -p 3041 -H localhost
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/onboarding-intent-e2e.mts http://localhost:3041
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://localhost:3041';
if (!/muse_bridge_test_goat/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_goat.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/onboarding-intent-20261105/screenshots');
mkdirSync(SHOTS, { recursive: true });
const RUN = randomBytes(4).toString('hex');
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

async function newAccount(tag: string) {
  const [{ id }] = await q('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [`Lan ${tag}`]);
  await q("INSERT INTO user_accounts(user_id, email, password_hash) VALUES ($1, $2, 'scrypt$e2e$unused')", [id, `e2e-onboarding-${RUN}-${tag}@example.test`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [id, createHash('sha256').update(token).digest('hex')]);
  return { id, token };
}
const KIOTVIET = 'Tôi là sale bán phần mềm của KiotViet, tôi đang tìm các quán F&B sắp khai trương.';
const DINING = 'Tôi là đại lý bán chén, đũa và các dụng cụ ăn uống cho quán ăn, nhà hàng. Tôi đang tìm các quán ăn, nhà hàng F&B sắp khai trương.';
const CUSTOM = 'Tôi bán máy lọc nước cho văn phòng. Tôi đang tìm các công ty mới thành lập hoặc vừa chuyển văn phòng.';
const area = (p: Page) => p.locator('#ob-description');
const option = (p: Page, name: RegExp) => p.getByRole('button', { name });
async function noOverflow(p: Page) {
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
try {
  const acc = await newAccount('a');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'qlead_session', value: acc.token, url: BASE }]);
  const p = await context.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await check('O1 a new account lands on step 1 with three intent choices, no industry categories', async () => {
    await p.goto(`${BASE}/app`); await p.waitForURL('**/bat-dau');
    await p.waitForLoadState('networkidle');
    const body = (await p.locator('main').innerText()).replace(/\s+/g, ' ');
    assert(body.includes('Bạn là ai và muốn tìm khách hàng nào?'), body.slice(0, 200));
    assert(await p.locator('.intent-option').count() === 3, 'three options');
    assert(!/Phần mềm bán lẻ|Phần mềm khách sạn|Thiết bị & thi công quán/.test(body), 'old categories still shown');
    for (const w of [390, 768, 1440]) { await p.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(p); await p.screenshot({ path: `${SHOTS}/o1-step1-${w}.png`, fullPage: true }); }
  });
  await check('O2 KiotViet example fills an editable description; the edit is kept', async () => {
    await p.setViewportSize({ width: 1440, height: 1000 });
    await option(p, /sale bán phần mềm KiotViet/).click();
    assert(await area(p).inputValue() === KIOTVIET, await area(p).inputValue());
    await area(p).fill(`${KIOTVIET} Ưu tiên quán cà phê.`);
    return 'edited';
  });
  await check('O3 switching to the dining-supplies example and back never loses the KiotViet edit', async () => {
    await option(p, /đại lý bán chén, đũa/).click();
    assert(await area(p).inputValue() === DINING, 'dining text');
    await option(p, /sale bán phần mềm KiotViet/).click();
    assert(await area(p).inputValue() === `${KIOTVIET} Ưu tiên quán cà phê.`, `lost edit: ${await area(p).inputValue()}`);
  });
  await check('O4 "Ngành khác" starts empty and focused; custom text survives switching and a reload', async () => {
    await option(p, /Ngành khác\? Tự mô tả khách hàng/).click();
    assert(await area(p).inputValue() === '', 'custom should start empty');
    assert(await p.evaluate(() => document.activeElement?.id) === 'ob-description', 'textarea not focused');
    await area(p).fill(CUSTOM);
    await option(p, /đại lý bán chén, đũa/).click();
    await option(p, /Ngành khác\? Tự mô tả khách hàng/).click();
    assert(await area(p).inputValue() === CUSTOM, 'custom lost after switching');
    await p.reload(); await p.waitForLoadState('networkidle');
    assert(await area(p).inputValue() === CUSTOM, 'custom lost after reload');
    assert(await option(p, /Ngành khác/).getAttribute('aria-pressed') === 'true', 'custom selection lost');
    for (const w of [390, 768, 1440]) { await p.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(p); await p.screenshot({ path: `${SHOTS}/o4-custom-${w}.png`, fullPage: true }); }
    await p.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('O5 step 2 has no region selector, explains the search honestly, shows phrases from the description', async () => {
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    const body = (await p.locator('main').innerText()).replace(/\s+/g, ' ');
    assert(await p.locator('select[aria-label="Khu vực"]').count() === 0 && !body.includes('Khu vực'), 'region still present');
    assert(body.includes('QLead hiểu mô tả của bạn như sau') && body.includes('Đây chỉ là điểm bắt đầu'), 'preview copy');
    const chips = await p.locator('.keyword-chips li').allInnerTexts();
    assert(chips.length > 0 && chips.some(c => /lọc nước|văn phòng|công ty/i.test(c)), `chips ${chips.join(' | ')}`);
    assert(body.includes(CUSTOM), 'original description shown');
    for (const w of [390, 768, 1440]) { await p.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 }); await noOverflow(p); await p.screenshot({ path: `${SHOTS}/o5-step2-${w}.png`, fullPage: true }); }
    await p.setViewportSize({ width: 1440, height: 1000 });
    return chips.join(' | ');
  });
  await check('O6 back to step 1 keeps the text; saving stores the description and NO region', async () => {
    await p.getByRole('button', { name: /Quay lại/ }).click();
    assert(await area(p).inputValue() === CUSTOM, 'lost on back');
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    await p.getByRole('button', { name: /Tiếp tục/ }).click();
    const summary = (await p.locator('.onboarding-summary').innerText()).replace(/\s+/g, ' ');
    assert(!summary.includes('Khu vực') && summary.includes(CUSTOM), summary);
    await p.screenshot({ path: `${SHOTS}/o6-step3-1440.png`, fullPage: true });
    await p.getByRole('button', { name: /Lưu và vào QLead/ }).click();
    await p.waitForURL(url => !url.pathname.startsWith('/bat-dau'), { timeout: 20000 });
    const [row] = await q(`SELECT sc.location, sc.description, sc.keywords_source FROM scan_configs sc JOIN agent_connections ac ON ac.id = sc.agent_connection_id
      WHERE ac.user_id = $1 ORDER BY sc.version DESC LIMIT 1`, [acc.id]);
    assert(row && row.location === '' && row.description === CUSTOM && row.keywords_source === 'description', JSON.stringify(row));
    return `${new URL(p.url()).pathname} · location '' · description kept`;
  });
  await check('O7 dashboard navigation works after onboarding (Today → Lead list → Nhu cầu)', async () => {
    for (const path of ['/app', '/app/bai-viet', '/app/bo-loc']) {
      await p.goto(`${BASE}${path}`); await p.waitForLoadState('networkidle');
      assert(new URL(p.url()).pathname === path, `${path} → ${p.url()}`);
      await noOverflow(p);
    }
  });
  await check('O8 an existing profile with a saved region keeps it (onboarding never touches it)', async () => {
    const other = await newAccount('b');
    await q("UPDATE user_accounts SET onboarding_completed_at = now() WHERE user_id = $1", [other.id]);
    const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Khách sạn Đà Lạt', 'search_profile') RETURNING id", [other.id]);
    await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
      VALUES ($1, 1, true, '["khách sạn mới khai trương"]', 'description', 'Đà Lạt', '["social.search"]', 30, 'Khách sạn mới ở Đà Lạt')`, [profile]);
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await c2.addCookies([{ name: 'qlead_session', value: other.token, url: BASE }]);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/app/bo-loc`); await p2.waitForLoadState('networkidle');
    await c2.close();
    const [row] = await q('SELECT location FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [profile]);
    assert(row.location === 'Đà Lạt', row.location);
  });
  await context.close();
} finally {
  await browser.close();
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
  writeFileSync(resolve(SHOTS, '..', 'results.json'), JSON.stringify({ base: BASE, results, errors }, null, 2));
  await pool.end();
}
