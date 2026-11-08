// Screenshot helper for the report: opens a page as the newest synthetic E2E user with the given tag (isolated DB only).
//   npx tsx web/e2e/first-search-ux-shot.mts <baseUrl> <tag> <path> <outPrefix>
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../../src/db.js';

const [base, tag, path, out] = process.argv.slice(2);
if (!/muse_bridge_test_firstux/.test(process.env.DATABASE_URL ?? '') || !base || !tag || !path || !out) { console.error('usage / wrong DB'); process.exit(2); }
const { rows: [user] } = await pool.query("SELECT id FROM users WHERE display_name LIKE $1 ORDER BY created_at DESC LIMIT 1", [`E2E first-search % ${tag}`]);
const token = randomBytes(32).toString('base64url');
await pool.query("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '1 hour')", [user.id, createHash('sha256').update(token).digest('hex')]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const width of [390, 768, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'qlead_session', value: token, url: base }]);
  const page = await context.newPage();
  await page.goto(`${base}${path}`); await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${out}-${width}.png`, fullPage: false });
  await context.close();
}
await browser.close(); await pool.end();
