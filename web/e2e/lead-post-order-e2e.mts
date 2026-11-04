import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3015';
const userId = '00000000-0000-4000-8000-00000000a501';
const profileId = '00000000-0000-4000-8000-00000000a502';
const secondProfileId = '00000000-0000-4000-8000-00000000a503';
const token = randomBytes(36).toString('base64url');
const post = async (slug: string, hoursAgo: number | null, discoveredMinutesAgo: number) => pool.query(`
  INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,author,content,published_at,first_seen_at,collected_via)
  VALUES ($1,$2,$2,'E2E Page',$3,$4,now()-make_interval(mins => $5),'lead-post-order-e2e')`, [
    profileId, `https://facebook.com/e2e/lead-order/${slug}`, `Bài thử ${slug}: quán sắp khai trương cần phần mềm bán hàng.`,
    hoursAgo === null ? null : new Date(Date.now() - hoursAgo * 3_600_000), discoveredMinutesAgo,
  ]);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await pool.query('INSERT INTO users(id,display_name) VALUES ($1,$2)', [userId, 'E2E Lead Order']);
  await pool.query("INSERT INTO agent_connections(id,user_id,name,kind) VALUES ($1,$2,'Lead Order Fixture','search_profile')", [profileId, userId]);
  await pool.query("INSERT INTO agent_connections(id,user_id,name,kind) VALUES ($1,$2,'Second Lead Order Fixture','search_profile')", [secondProfileId, userId]);
  await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes)
    VALUES ($1,1,true,'["synthetic lead ordering"]','', '["social.search"]',30),
      ($2,1,true,'["synthetic duplicate ordering"]','', '["social.search"]',30)`, [profileId, secondProfileId]);
  await post('beta-newest', 1, 180);
  await post('alpha-older', 30, 6);
  for (let index = 0; index < 55; index++) await post(`page-${index}`, 100 + index, 0);
  await post('unknown-time', null, 0);
  await pool.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,author,content,published_at,first_seen_at,collected_via)
    VALUES ($1,$2,$2,'E2E Page','Bài thử page-0: quán sắp khai trương cần phần mềm bán hàng.',NULL,now()-interval '1 minute','lead-post-order-e2e')`,
  [secondProfileId, 'https://facebook.com/e2e/lead-order/page-0']);
  await pool.query(`INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at)
    VALUES ($1,$2,'password',now()+interval '1 hour')`, [userId, createHash('sha256').update(token).digest('hex')]);

  const context = await browser.newContext();
  await context.addCookies([{ name: 'qlead_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/app/bai-viet`);
  await page.getByRole('heading', { name: 'Danh sách lead', level: 1 }).waitFor();

  const rows = page.locator('.lead-table tbody tr');
  assert.equal(await rows.count(), 50, 'first chronological page has 50 rows');
  const getRows = () => rows.evaluateAll(items => items.map(row => ({
    text: row.querySelector('.lead-cell p')?.textContent ?? '',
    postedAt: row.querySelector('td:nth-child(5) time')?.getAttribute('datetime') ?? null,
    unknown: row.querySelector('td:nth-child(5) .muted-text')?.textContent?.includes('Chưa rõ giờ đăng') ?? false,
  })));
  const newestFirst = await getRows();
  assert.match(newestFirst[0]?.text ?? '', /beta-newest/);
  assert.match(newestFirst[1]?.text ?? '', /alpha-older/);
  const duplicateWithUnknownCopy = rows.filter({ hasText: 'page-0' }).first();
  assert.ok(await duplicateWithUnknownCopy.locator('td:nth-child(5) time').getAttribute('datetime'), 'a repeated URL uses the known original post time when one copy has it');
  await page.getByRole('button', { name: /Tải thêm/ }).click();
  assert.equal(await rows.count(), 58, 'load more appends the remaining 8 rows');
  const completeNewest = await getRows();
  const datedNewest = completeNewest.filter(row => row.postedAt).map(row => Date.parse(row.postedAt!));
  assert.ok(datedNewest.every((time, index) => index === 0 || datedNewest[index - 1]! >= time), 'newest order follows original post timestamps');
  assert.equal(completeNewest.at(-1)?.unknown, true, 'missing posted_at is visible at the end');

  await page.getByLabel('Tìm lead').fill('alpha-older');
  assert.equal(await rows.count(), 1, 'search filtering retains a single correctly sorted match');
  assert.match((await rows.first().innerText()), /alpha-older/);
  await page.getByRole('button', { name: /Xóa lọc/ }).click();

  await page.getByRole('combobox', { name: 'Sắp xếp lead' }).selectOption('oldest');
  await page.getByRole('button', { name: /Tải thêm/ }).click();
  assert.equal(await rows.count(), 58);
  const completeOldest = await getRows();
  const datedOldest = completeOldest.filter(row => row.postedAt).map(row => Date.parse(row.postedAt!));
  assert.ok(datedOldest.every((time, index) => index === 0 || datedOldest[index - 1]! <= time), 'oldest order follows original post timestamps');
  assert.match(completeOldest[0]?.text ?? '', /page-54/);
  assert.equal(completeOldest.at(-1)?.unknown, true, 'missing posted_at remains last in oldest mode');
  console.log('PASS: newest/oldest, missing timestamps, search, page boundary, and load more render in posted_at order (58 synthetic leads).');
  await context.close();
} finally {
  await browser.close();
  await pool.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
  await pool.end();
}
