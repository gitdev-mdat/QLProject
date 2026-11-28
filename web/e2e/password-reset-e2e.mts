// Forgot-password E2E on the ISOLATED test database, against a production build, with a local mock of Resend's API
// (no real email is sent). Every scenario uses its own browser context.
// 1. Build and start the web app against the test DB (from web/):
//    DATABASE_URL=postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test QLEAD_ENVIRONMENT=local npm run build
//    DATABASE_URL=<same> QLEAD_ENVIRONMENT=local RESEND_API_KEY=e2e MAIL_FROM='QLead <no-reply@qlead.test>' \
//      RESEND_API_URL=http://127.0.0.1:3099/emails QLEAD_PUBLIC_URL=http://127.0.0.1:3010 npm start -- -H 127.0.0.1 -p 3010
// 2. From the repo root: DATABASE_URL=<same> npx tsx web/e2e/password-reset-e2e.mts http://127.0.0.1:3010 3099
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3010';
const MAIL_PORT = Number(process.argv[3] ?? 3099);
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/password-reset/screenshots');
mkdirSync(SHOTS, { recursive: true });

const RUN = randomBytes(4).toString('hex');
const EMAIL = `e2e-reset-${RUN}@qlead.test`;
const EMAIL_B = `e2e-reset-${RUN}-b@qlead.test`;
const OLD_PASSWORD = `Old-${randomBytes(6).toString('hex')}`;
const NEW_PASSWORD = `New-${randomBytes(6).toString('hex')}`;

type Mail = { from: string; to: string[]; subject: string; html: string; text: string; auth: string };
const outbox: Mail[] = [];
const mailServer = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    outbox.push({ ...JSON.parse(body), auth: req.headers.authorization ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `mock-${outbox.length}` }));
  });
});
await new Promise<void>(done => mailServer.listen(MAIL_PORT, '127.0.0.1', done));

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const consoleErrors: string[] = [];
async function fresh(browser: Browser, width = 1440, height = 1000): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return { context, page };
}
const shot = (p: Page, name: string, fullPage = false) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial', animations: 'disabled' });
const post = (path: string, body: unknown, origin = BASE) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
async function waitForMail(count: number, ms = 5000) { const end = Date.now() + ms; while (outbox.length < count && Date.now() < end) await sleep(100); return outbox.length >= count; }
const linkOf = (mail: Mail) => { const m = /(http:\/\/\S+\/dat-lai-mat-khau\?ma=[A-Za-z0-9_-]{43})/.exec(mail.text); assert(m, 'no reset link in email'); return m![1]; };
async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByLabel('Email công việc').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: /Đăng nhập/ }).click();
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let userId = '';
let userB = '';
let firstLink = '';
try {
  await check('setup: register a customer through the API', async () => {
    const response = await post('/api/auth/register', { name: 'Chị Reset E2E', email: EMAIL, password: OLD_PASSWORD });
    assert(response.status === 201, `register ${response.status}`);
    userId = (await pool.query('SELECT user_id FROM user_accounts WHERE email = $1', [EMAIL])).rows[0].user_id;
    await pool.query('UPDATE user_accounts SET onboarding_completed_at = now() WHERE user_id = $1', [userId]);
  });

  await check('login page links to "Quên mật khẩu?" (1440 and 390)', async () => {
    for (const width of [1440, 390]) {
      const { context, page } = await fresh(browser, width, width === 390 ? 844 : 900);
      await page.goto(`${BASE}/dang-nhap`);
      await page.getByRole('link', { name: 'Quên mật khẩu?' }).waitFor();
      await shot(page, `login-forgot-link-${width}`);
      await page.getByRole('link', { name: 'Quên mật khẩu?' }).click();
      await page.waitForURL(/\/quen-mat-khau$/);
      await page.getByRole('heading', { name: 'Quên mật khẩu?' }).waitFor();
      await shot(page, `forgot-${width}`);
      await context.close();
    }
  });

  await check('unknown email: same answer as a real one, no email sent', async () => {
    const before = outbox.length;
    const unknown = await post('/api/auth/forgot-password', { email: `nobody-${RUN}@qlead.test` });
    const unknownBody = await unknown.text();
    await sleep(1500);
    assert(outbox.length === before, 'an email was sent for an unknown address');
    const known = await post('/api/auth/forgot-password', { email: EMAIL.toUpperCase() });
    const knownBody = await known.text();
    assert(unknown.status === 202 && known.status === 202, `status ${unknown.status}/${known.status}`);
    assert(unknownBody === knownBody, 'bodies differ');
    assert(await waitForMail(before + 1), 'no email for the registered address');
    return `both 202 ${knownBody}`;
  });

  await check('email: sent to the account through the provider, Vietnamese, link to the public URL', async () => {
    const mail = outbox.at(-1)!;
    assert(mail.to.length === 1 && mail.to[0] === EMAIL, `to ${mail.to}`);
    assert(mail.from === 'QLead <no-reply@qlead.test>', `from ${mail.from}`);
    assert(mail.auth === 'Bearer e2e', 'no API key header');
    assert(mail.subject === 'Đặt lại mật khẩu QLead', mail.subject);
    assert(mail.text.includes('Chị Reset E2E') && mail.text.includes('30 phút'), 'text content');
    assert(mail.html.includes('Đặt mật khẩu mới'), 'html button');
    firstLink = linkOf(mail);
    assert(firstLink.startsWith(`${BASE}/dat-lai-mat-khau?ma=`), firstLink);
    const { context, page } = await fresh(browser, 720, 900);
    await page.setContent(mail.html);
    await shot(page, 'email-preview', true);
    await context.close();
  });

  await check('UI: request a link and see the neutral confirmation (1440 and 390)', async () => {
    for (const width of [1440, 390]) {
      const before = outbox.length;
      const { context, page } = await fresh(browser, width, width === 390 ? 844 : 900);
      await page.goto(`${BASE}/quen-mat-khau`);
      await page.getByLabel('Email đã đăng ký').fill(EMAIL);
      await page.getByRole('button', { name: /Gửi link đặt lại mật khẩu/ }).click();
      await page.getByRole('heading', { name: 'Kiểm tra hộp thư của bạn' }).waitFor();
      const text = await page.locator('.auth-sent').innerText();
      assert(text.includes(`Nếu ${EMAIL} có tài khoản QLead`), 'neutral wording');
      assert(await page.getByRole('button', { name: /Gửi lại sau \d+ giây/ }).isDisabled(), 'resend cooldown');
      await shot(page, `forgot-sent-${width}`);
      assert(await waitForMail(before + 1), 'no email');
      await context.close();
    }
    return `${outbox.length} emails so far`;
  });

  await check('a newer link replaces older ones', async () => {
    const response = await fetch(firstLink);
    const html = await response.text();
    assert(html.includes('Link không còn dùng được'), 'old link still usable');
  });

  await check('reset page: token leaves the address bar, no referrer, validation, then success (1440 and 390)', async () => {
    const link = linkOf(outbox.at(-1)!);
    const signedIn = await fresh(browser);
    await login(signedIn.page, EMAIL, OLD_PASSWORD);
    await signedIn.page.waitForURL(/\/app/);

    const { context: mobile, page: m } = await fresh(browser, 390, 844);
    await m.goto(link);
    await m.getByRole('heading', { name: 'Đặt mật khẩu mới' }).waitFor();
    await shot(m, 'reset-390');
    await mobile.close();

    const { context, page } = await fresh(browser, 1440, 900);
    await page.goto(link);
    await page.getByRole('heading', { name: 'Đặt mật khẩu mới' }).waitFor();
    await page.waitForFunction(() => !location.search.includes('ma='));
    assert(await page.locator('meta[name="referrer"][content="no-referrer"]').count() === 1, 'referrer meta');
    await page.getByLabel('Mật khẩu mới', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Nhập lại mật khẩu mới').fill(`${NEW_PASSWORD}x`);
    await page.getByText('Hai mật khẩu chưa khớp nhau.').first().waitFor();
    await shot(page, 'reset-mismatch-1440');
    await page.getByLabel('Nhập lại mật khẩu mới').fill(NEW_PASSWORD);
    await shot(page, 'reset-1440');
    await page.getByRole('button', { name: /Lưu mật khẩu mới/ }).click();
    await page.waitForURL(/\/dang-nhap\?doi-mat-khau=1$/);
    await page.getByText('Đã đổi mật khẩu. Hãy đăng nhập bằng mật khẩu mới.').waitFor();
    await shot(page, 'login-password-changed-1440');

    await signedIn.page.goto(`${BASE}/app`);
    await signedIn.page.waitForURL(/\/dang-nhap/);
    await signedIn.context.close();

    await page.goto(link);
    await page.getByRole('heading', { name: 'Link không còn dùng được' }).waitFor();
    await shot(page, 'reset-link-used-1440');
    await context.close();
    return 'older session signed out; used link rejected';
  });

  await check('used link page at 390', async () => {
    const { context, page } = await fresh(browser, 390, 844);
    await page.goto(`${BASE}/dat-lai-mat-khau?ma=${'a'.repeat(43)}`);
    await page.getByRole('heading', { name: 'Link không còn dùng được' }).waitFor();
    await shot(page, 'reset-link-invalid-390');
    await context.close();
  });

  await check('old password no longer works, new one does', async () => {
    const old = await post('/api/auth/login', { email: EMAIL, password: OLD_PASSWORD });
    assert(old.status === 401, `old ${old.status}`);
    const fresh = await post('/api/auth/login', { email: EMAIL, password: NEW_PASSWORD });
    assert(fresh.status === 200, `new ${fresh.status}`);
  });

  await check('API: used, garbage and expired links are refused with 410; short passwords with 400', async () => {
    const used = await post('/api/auth/reset-password', { token: new URL(firstLink).searchParams.get('ma'), password: 'whatever-123' });
    assert(used.status === 410, `used ${used.status}`);
    const garbage = await post('/api/auth/reset-password', { token: 'nope', password: 'whatever-123' });
    assert(garbage.status === 410, `garbage ${garbage.status}`);
    const before = outbox.length;
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]); // reset the per-hour cap for this check
    await post('/api/auth/forgot-password', { email: EMAIL });
    assert(await waitForMail(before + 1), 'no email');
    const token = new URL(linkOf(outbox.at(-1)!)).searchParams.get('ma')!;
    await pool.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 second', created_at = now() - interval '31 minutes' WHERE user_id = $1 AND used_at IS NULL", [userId]);
    const expired = await post('/api/auth/reset-password', { token, password: 'whatever-123' });
    assert(expired.status === 410, `expired ${expired.status}`);
    const short = await post('/api/auth/reset-password', { token, password: 'short' });
    assert(short.status === 400, `short ${short.status}`);
  });

  await check('per-account cap: a 4th request in an hour sends nothing but answers the same', async () => {
    const response = await post('/api/auth/register', { name: 'Anh Cap E2E', email: EMAIL_B, password: OLD_PASSWORD });
    assert(response.status === 201, `register ${response.status}`);
    userB = (await pool.query('SELECT user_id FROM user_accounts WHERE email = $1', [EMAIL_B])).rows[0].user_id;
    const before = outbox.length;
    const answers = [];
    for (let i = 0; i < 4; i++) { answers.push((await post('/api/auth/forgot-password', { email: EMAIL_B })).status); await sleep(300); }
    await sleep(1500);
    assert(answers.every(s => s === 202), `answers ${answers}`);
    assert(outbox.length === before + 3, `sent ${outbox.length - before}`);
    return `answers ${answers.join(',')}, emails ${outbox.length - before}`;
  });

  await check('cross-origin requests are refused', async () => {
    const a = await post('/api/auth/forgot-password', { email: EMAIL }, 'https://evil.example');
    const b = await post('/api/auth/reset-password', { token: 'x'.repeat(43), password: 'whatever-123' }, 'https://evil.example');
    assert(a.status === 403 && b.status === 403, `${a.status}/${b.status}`);
  });

  await check('no console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.join(' | ')); });
} finally {
  await browser.close();
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, userB].filter(Boolean)]);
  await pool.end();
  mailServer.close();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed\n${results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')}\n`;
  writeFileSync(resolve(SHOTS, '..', 'password-reset-e2e-results.txt'), summary);
  console.log(summary);
  process.exit(passed === results.length ? 0 : 1);
}
