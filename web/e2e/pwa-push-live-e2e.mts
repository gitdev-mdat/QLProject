// Live integration of the F03 frontend with the real /api/push backend (no API stub), on `next dev` in local mode.
// Covers config, register (encrypted at rest), status, test-send error handling, rate limit, disable, logout cleanup.
//
// Server (from web/, isolated DB muse_bridge_test_nav with migrations through 017):
//   QLEAD_ENVIRONMENT=local QLEAD_PUSH_ALLOW_LOCAL_ENDPOINTS=true DATABASE_URL=… VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=…
//   VAPID_SUBJECT=https://qlead.vercel.app/ QLEAD_WEB_PUSH_ENCRYPTION_KEY=… npm run dev -- -p 3000
// Run: DATABASE_URL=… npx tsx e2e/pwa-push-live-e2e.mts http://localhost:3000 <seed.json>
import { chromium } from 'playwright-core';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';


const [BASE = 'http://localhost:3000', SEED = 'nav-perf-seed.json'] = process.argv.slice(2);
if (!/muse_bridge_test_nav/.test(process.env.DATABASE_URL ?? '')) { console.error('DATABASE_URL must point at muse_bridge_test_nav'); process.exit(2); }
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as Record<'large', { userId: string; token: string }>;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const results: Array<{ name: string; pass: boolean }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const detail = await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  catch (error) { results.push({ name, pass: false }); console.log(`FAIL ${name} — ${(error as Error).message.split('\n')[0]}`); }
}
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

// The browser side of a real subscription: P-256 key pair + auth secret.
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const auth = randomBytes(16);
const endpoint = `http://127.0.0.1:9/ep-${randomBytes(4).toString('hex')}`;
const fakePush = `(() => {
  const data = { endpoint: '${endpoint}', expirationTime: null, keys: { p256dh: '${ecdh.getPublicKey().toString('base64url')}', auth: '${auth.toString('base64url')}' } };
  const read = () => localStorage.getItem('__live') === '1';
  const make = () => ({ endpoint: data.endpoint, options: { applicationServerKey: null }, toJSON: () => data, unsubscribe: async () => { localStorage.removeItem('__live'); return true; } });
  PushManager.prototype.getSubscription = async function () { return read() ? make() : null; };
  PushManager.prototype.subscribe = async function () { localStorage.setItem('__live', '1'); return make(); };
})()`;

// A throwaway session for the same seeded account, so logout at the end does not revoke the shared seed session.
const token = randomBytes(32).toString('base64url');
await db.query("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 day')", [seed.large.userId, createHash('sha256').update(token).digest('hex')]);

const browser = await chromium.launch({ channel: 'chromium', ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 860 }, isMobile: true, hasTouch: true });
await context.grantPermissions(['notifications'], { origin: new URL(BASE).origin });
await context.addInitScript('window.__name = (f) => f');
await context.addInitScript(fakePush);
await context.addCookies([{ name: 'qlead_session', value: token, url: BASE }]);
const page = await context.newPage();
const card = page.locator('#thong-bao');

await check('config from the real API: enabled with the server VAPID key', async () => {
  await page.goto('/app/thong-bao', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bật thông báo' }).waitFor({ timeout: 60000 });
});

await check('enable → real PUT stores an encrypted subscription for this session', async () => {
  await page.getByRole('button', { name: 'Bật thông báo' }).click();
  await card.locator('.pwa-status.is-on').waitFor({ timeout: 30000 });
  const { rows } = await db.query('SELECT subscription_ciphertext, origin, platform, session_id FROM push_subscriptions WHERE user_id = $1', [seed.large.userId]);
  assert(rows.length === 1, `rows ${rows.length}`);
  assert(!String(rows[0].subscription_ciphertext).includes('127.0.0.1'), 'endpoint stored in plain text');
  return `origin ${rows[0].origin}, platform ${rows[0].platform}`;
});

await check('refresh: state read back from the real status API', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await card.locator('.pwa-status.is-on').waitFor({ timeout: 30000 });
});

// web-push only sends over HTTPS and the backend only accepts real push-service hosts, so a local receiver cannot get
// the request; the backend's own tests cover signing/encryption with a fake sender. Here the real API path is checked:
// the send fails at the transport and the UI says so instead of claiming success.
await check('test push with no reachable push service → real 502 shown honestly', async () => {
  await page.getByRole('button', { name: 'Gửi thông báo thử' }).click();
  await card.getByText('Không kết nối được').waitFor({ timeout: 30000 });
  assert(!(await card.getByText('Đã gửi.').count()), 'claimed sent');
});

await check('second test within 30 s → real 429 shown as a wait message', async () => {
  await page.getByRole('button', { name: 'Gửi thông báo thử' }).click();
  await card.getByText('Vừa gửi thử rồi').waitFor({ timeout: 30000 });
});

await check('disable → real DELETE removes the row; re-enable stores it again', async () => {
  await page.getByRole('button', { name: 'Tắt thông báo' }).click();
  await card.locator('.pwa-status:not(.is-on)').waitFor({ timeout: 30000 });
  assert((await db.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [seed.large.userId])).rowCount === 0, 'row kept');
  await page.getByRole('button', { name: 'Bật thông báo' }).click();
  await card.locator('.pwa-status.is-on').waitFor({ timeout: 30000 });
  assert((await db.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [seed.large.userId])).rowCount === 1, 'not stored again');
});

await check('logout → subscription gone server-side and in the browser', async () => {
  await page.locator('.app-topbar').getByRole('button', { name: 'Đăng xuất' }).click();
  await page.waitForURL(url => new URL(url).pathname === '/dang-nhap', { timeout: 30000 });
  assert((await db.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [seed.large.userId])).rowCount === 0, 'row kept after logout');
  assert(await page.evaluate(() => localStorage.getItem('__live') !== '1'), 'browser subscription kept');
});

await browser.close();
await db.end();
const failed = results.filter(result => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
