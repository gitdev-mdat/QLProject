// Browser E2E for the customer cleanup, Facebook group suggestions and lead filter changes, on the ISOLATED
// test database. Start the web app exactly as described in admin-workers-e2e.mts (port 3005, same env), then:
//   $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; npx tsx web/e2e/customer-groups-e2e.mts http://127.0.0.1:3005
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/group-request-screenshots');
mkdirSync(SHOTS, { recursive: true });
const ID = { admin: '00000000-0000-4000-8000-0000000000ad', a: '00000000-0000-4000-8000-0000000000a1', b: '00000000-0000-4000-8000-0000000000b1' };
const W = { pa: '', pb: '', worker: '' };
const workerToken = randomBytes(32).toString('base64url');
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function removeFixtures() {
  await pool.query('DELETE FROM worker_handoffs');
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ID.admin, ID.a, ID.b]]);
  await pool.query("DELETE FROM muse_workers WHERE name LIKE 'E2E %'");
}
async function seed() {
  await removeFixtures();
  for (const [id, name] of [[ID.admin, 'E2E Admin'], [ID.a, 'E2E User A'], [ID.b, 'E2E User B']]) await pool.query('INSERT INTO users(id, display_name) VALUES ($1, $2)', [id, name]);
  W.pa = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [ID.a])).rows[0].id;
  W.pb = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [ID.b])).rows[0].id;
  await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES ($1, 1, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 30), ($2, 1, '["khách sạn sắp khai trương"]', 'Hà Nội', '["social.search"]', 30)`, [W.pa, W.pb]);
  // Discovery order differs from publish order on purpose; one post has no publish time (must still be listed, never invented).
  const posts = [
    { owner: W.pa, slug: 'a1', content: 'Quán ăn Alpha sắp khai trương tại Thủ Đức', published: '-30 hours', seen: '-3 hours' },
    { owner: W.pa, slug: 'a2', content: 'Nhà hàng Beta chuẩn bị mở, cần phần mềm bán hàng', published: '-1 hours', seen: '-2 hours' },
    { owner: W.pa, slug: 'a3', content: 'Quán cafe Gamma sắp khai trương, chưa rõ khu vực', published: null, seen: '-1 hours' },
    { owner: W.pb, slug: 'b1', content: 'Khách sạn Delta Hà Nội sắp khai trương', published: '-5 hours', seen: '-4 hours' },
  ];
  for (const p of posts) {
    await pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
      VALUES ($1, $2, $2, $3, 'E2E Page', CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END, now() + $5::interval, 'qlead_shared_worker')`, [p.owner, `https://facebook.com/e2e/${p.slug}`, p.content, p.published, p.seen]);
  }
  for (let index = 0; index < 55; index++) {
    await pool.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
      VALUES ($1,$2,$2,$3,'E2E Page',now()-make_interval(hours => $4),now(),'qlead_shared_worker')`,
    [W.pa, `https://facebook.com/e2e/load-more-${index}`, `Lead phân trang ${index} cần phần mềm bán hàng.`, 100 + index]);
  }
  // Missing original post times remain visible and are sorted after dated leads.
  W.worker = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status) VALUES ('E2E Muse 01', $1, 'active') RETURNING id", [createHash('sha256').update(workerToken).digest('hex')])).rows[0].id;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${page.url()} :: ${m.text()} @ ${m.location().url}`); });
  page.on('pageerror', e => consoleErrors.push(`${page.url()} :: ${e.message}`));
  await page.goto(`${BASE}/dang-nhap`);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForURL(`${BASE}/app`);
  return { context, page };
}
const noOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = (p: Page, name: string, fullPage = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage, caret: 'initial' });
const submitGroup = async (p: Page, url: string, note = '') => {
  await p.getByLabel('Đường dẫn nhóm Facebook').fill(url);
  await p.getByLabel(/Vì sao nên thêm nhóm này/).fill(note);
  await p.getByRole('button', { name: 'Gửi đề xuất' }).click();
};

try {
  await seed();
  const a = await login('E2E User A');
  const pa = a.page;

  await check('1 sidebar shows the four customer items with "Đề xuất nhóm"', async () => {
    const items = await pa.locator('.side-nav a').allInnerTexts();
    assert(JSON.stringify(items.map(t => t.trim())) === JSON.stringify(['Hôm nay', 'Danh sách lead', 'Nhu cầu theo dõi', 'Đề xuất nhóm']), items.join(' | '));
  });
  await check('2 no Muse / agent / connection wording on customer pages; /app/ket-noi redirects', async () => {
    for (const path of ['/app', '/app/bai-viet', '/app/bo-loc', '/app/de-xuat-nhom', '/bat-dau']) {
      await pa.goto(`${BASE}${path}`);
      const text = (await pa.locator('body').innerText()).toLowerCase();
      for (const word of ['muse', 'agent', 'worker', 'credential', 'qlead_shared_worker', 'kết nối nguồn']) assert(!text.includes(word), `${path} shows "${word}"`);
    }
    await pa.goto(`${BASE}/app/ket-noi`);
    assert(pa.url() === `${BASE}/app/de-xuat-nhom`, `landed on ${pa.url()}`);
    await pa.getByRole('heading', { name: 'Đề xuất nhóm Facebook', level: 1 }).waitFor();
    await shot(pa, 'today-1440-before-submit', false);
  });

  await check('3 valid group URL is submitted and listed with status "Chờ xem xét"', async () => {
    await submitGroup(pa, 'https://m.facebook.com/groups/ChuQuanCafeSG/posts/123?ref=share', 'Nhóm có nhiều chủ quán cafe, nhà hàng chuẩn bị khai trương. <script>alert(1)</script>');
    await pa.getByRole('status').getByText('Đã gửi đề xuất').waitFor();
    const item = pa.locator('.request-items li').first();
    assert((await item.locator('.request-url').innerText()).includes('facebook.com/groups/chuquancafesg'), 'canonical URL shown');
    assert(await item.getByText('Chờ xem xét').isVisible(), 'status label');
    assert((await item.locator('.request-note').innerText()).includes('<script>alert(1)</script>'), 'note rendered as plain text');
    assert(await pa.evaluate(() => !document.querySelector('.request-note script')), 'no script element injected');
    const { rows } = await pool.query('SELECT user_id, group_url, status FROM facebook_group_requests');
    assert(rows.length === 1 && rows[0].user_id === ID.a && rows[0].group_url === 'https://www.facebook.com/groups/chuquancafesg' && rows[0].status === 'pending', JSON.stringify(rows));
  });
  await check('4 invalid URLs are rejected with a clear message and nothing stored', async () => {
    for (const [url, text] of [['https://www.facebook.com/somepage', 'không phải đường dẫn một nhóm'], ['https://evil.example/groups/x', 'Chỉ nhận đường dẫn facebook.com'], ['javascript:alert(1)', 'không hợp lệ']]) {
      await submitGroup(pa, url);
      await pa.getByRole('alert').getByText(text).waitFor();
    }
    assert((await pool.query('SELECT count(*)::int AS n FROM facebook_group_requests')).rows[0].n === 1, 'invalid stored');
  });
  await check('5 an equivalent URL variant from the same user is reported as a duplicate', async () => {
    await submitGroup(pa, 'facebook.com/groups/chuquancafesg/');
    await pa.getByRole('alert').getByText('Bạn đã đề xuất nhóm này rồi').waitFor();
    assert((await pool.query('SELECT count(*)::int AS n FROM facebook_group_requests')).rows[0].n === 1, 'duplicate stored');
    await shot(pa, 'group-requests-1440');
  });

  const b = await login('E2E User B');
  const pb = b.page;
  await check('6 User B cannot see User A requests (page and API)', async () => {
    await pb.goto(`${BASE}/app/de-xuat-nhom`);
    assert(await pb.getByText('Bạn chưa đề xuất nhóm nào.').isVisible(), 'B sees a request');
    const api = await pb.evaluate(async () => (await fetch('/api/group-requests')).json());
    assert(Array.isArray(api.requests) && api.requests.length === 0, 'API leaked');
    await submitGroup(pb, 'https://www.facebook.com/groups/chuquancafesg', 'Cùng nhóm, khách khác');
    await pb.getByRole('status').getByText('Đã gửi đề xuất').waitFor();
    const aApi = await pa.evaluate(async () => (await fetch('/api/group-requests')).json());
    assert(aApi.requests.length === 1 && !aApi.requests.some((r: any) => r.note === 'Cùng nhóm, khách khác'), 'A sees B request');
  });
  await check('6 customers cannot open Admin pages or change review status', async () => {
    const r = await pb.goto(`${BASE}/admin/group-requests`);
    assert(r?.status() === 404, `admin page ${r?.status()}`);
    await pb.goto(`${BASE}/app/de-xuat-nhom`); // call the APIs from a normal customer page
    const { rows: [req] } = await pool.query('SELECT id FROM facebook_group_requests WHERE user_id = $1', [ID.b]);
    const status = await pb.evaluate(async id => (await fetch(`/api/admin/group-requests/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ status: 'added' }) })).status, req.id);
    assert(status === 404, `admin API ${status}`);
    const worker = await pb.evaluate(async id => (await fetch(`/api/admin/workers/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ action: 'pause' }) })).status, W.worker);
    assert(worker === 404, `worker API ${worker}`);
    assert((await pool.query('SELECT status FROM facebook_group_requests WHERE id = $1', [req.id])).rows[0].status === 'pending', 'status changed');
    assert((await pool.query('SELECT status FROM muse_workers WHERE id = $1', [W.worker])).rows[0].status === 'active', 'worker changed');
    consoleErrors.length = 0; // intentional 404s above
  });

  const admin = await login('E2E Admin');
  const pAdmin = admin.page;
  await check('7 Admin reviews: ADDED is refused before APPROVED, then approved and added', async () => {
    await pAdmin.goto(`${BASE}/admin/group-requests`);
    await pAdmin.getByRole('heading', { name: 'Đề xuất nhóm Facebook', level: 1 }).waitFor();
    const row = pAdmin.getByRole('listitem', { name: 'Đề xuất https://www.facebook.com/groups/chuquancafesg' }).filter({ hasText: 'E2E User A' });
    assert(await row.getByText('Số khách đề xuất nhóm này').isVisible(), 'facts');
    assert((await row.locator('select option').allInnerTexts()).every(t => t !== 'Đã bổ sung và xác minh nguồn'), 'ADDED offered from pending');
    // Server also refuses the jump, whatever the UI offers.
    const { rows: [req] } = await pool.query('SELECT id FROM facebook_group_requests WHERE user_id = $1', [ID.a]);
    const jump = await pAdmin.evaluate(async id => (await fetch(`/api/admin/group-requests/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qlead-admin': '1' }, body: JSON.stringify({ status: 'added' }) })).status, req.id);
    assert(jump === 409, `jump ${jump}`);
    consoleErrors.length = 0;
    await row.locator('select').selectOption('approved');
    await row.locator('textarea').fill('Đã gửi yêu cầu tham gia nhóm');
    await row.getByRole('button', { name: 'Lưu quyết định' }).click();
    await row.getByText('Khách hàng thấy: "Đã chấp thuận"').waitFor();
    await shot(pAdmin, 'admin-group-requests-1440');
    await row.locator('select').selectOption('added');
    await row.locator('textarea').fill('Đã tham gia và xác minh tìm được bài trong nhóm');
    await row.getByRole('button', { name: 'Lưu quyết định' }).click();
    await row.getByText('Khách hàng thấy: "Đã bổ sung vào nguồn tìm kiếm"').waitFor();
    const rowB = pAdmin.getByRole('listitem', { name: 'Đề xuất https://www.facebook.com/groups/chuquancafesg' }).filter({ hasText: 'E2E User B' });
    await rowB.locator('select').selectOption('rejected');
    await rowB.locator('textarea').fill('Nhóm riêng tư, chưa thể hỗ trợ');
    await rowB.getByRole('button', { name: 'Lưu quyết định' }).click();
    await rowB.getByText('Khách hàng thấy: "Không thể hỗ trợ"').waitFor();
  });
  await check('8 customers see updated status and the Admin reply after refresh', async () => {
    await pa.reload();
    const item = pa.locator('.request-items li').first();
    await item.getByText('Đã bổ sung vào nguồn tìm kiếm').waitFor();
    assert(await item.getByText('Đã tham gia và xác minh tìm được bài trong nhóm').isVisible(), 'reply');
    await pb.reload();
    await pb.locator('.request-items li').first().getByText('Không thể hỗ trợ').waitFor();
    assert(await pb.getByText('Nhóm riêng tư, chưa thể hỗ trợ').isVisible(), 'rejection reason');
  });
  await check('9 review records a decision only: no worker, job or connector changes', async () => {
    const { rows: [w] } = await pool.query('SELECT status, authorized_sources, last_seen_at FROM muse_workers WHERE id = $1', [W.worker]);
    assert(w.status === 'active' && JSON.stringify(w.authorized_sources) === '["social.search"]' && w.last_seen_at === null, JSON.stringify(w));
    assert((await pool.query('SELECT count(*)::int AS n FROM search_jobs')).rows[0].n === 0, 'jobs created');
    return 'authorized_sources unchanged, no jobs, worker never contacted; the server code never fetches the URL';
  });

  await check('10/11 lead list has date sorting and no region dropdown', async () => {
    await pa.goto(`${BASE}/app/bai-viet`);
    await pa.getByRole('heading', { name: 'Danh sách lead', level: 1 }).waitFor();
    const options = await pa.locator('.filter-bar select option').allInnerTexts();
    assert(!options.includes('Mọi khu vực') && options.includes('Mới nhất') && options.includes('Cũ nhất'), options.join(' | '));
    assert(await pa.locator('.filter-bar select').count() === 3, 'source, posted-time range and sort selects expected');
    assert(await pa.locator('.lead-table tbody tr').count() === 50, 'first page should show 50 chronological rows');
    await pa.getByRole('button', { name: /Tải thêm/ }).click();
    assert(await pa.locator('.lead-table tbody tr').count() === 58, 'load more should append the remaining 8 rows');
  });
  await check('12 default order follows original post time and puts missing time last', async () => {
    const authors = await pa.locator('.lead-table tbody tr .lead-cell p').allInnerTexts();
    assert(authors[0].includes('Beta') && authors[1].includes('Alpha'), authors.slice(0, 3).join(' | '));
    assert(await pa.locator('.lead-table tbody tr').last().getByText('Chưa rõ giờ đăng').isVisible(), 'unknown publication time should be visible last');
    await pa.getByRole('combobox', { name: 'Sắp xếp lead' }).selectOption('oldest');
    await pa.getByRole('button', { name: /Tải thêm/ }).click();
    const oldest = await pa.locator('.lead-table tbody tr .lead-cell p').allInnerTexts();
    assert(oldest[0].includes('Lead phân trang 54') && oldest.at(-2)?.includes('Beta') && oldest.at(-1)?.includes('Gamma'), oldest.slice(0, 2).join(' | ') + ' ... ' + oldest.slice(-2).join(' | '));
    await pa.getByRole('combobox', { name: 'Sắp xếp lead' }).selectOption('newest');
    return '58 rows; newest/oldest order verified across load-more pages; unknown time last';
  });
  await check('13 "Chưa xem" tab, search, status change and notes still work', async () => {
    const tab = pa.getByRole('tab', { name: /Chưa xem/ });
    assert(/58/.test(await tab.innerText()), await tab.innerText());
    assert(!(await pa.getByRole('tab', { name: /^Mới/ }).count()), 'old "Mới" tab');
    await pa.fill('input[aria-label="Tìm lead"]', 'Alpha');
    assert(await pa.locator('.lead-table tbody tr').count() === 1, 'search');
    await pa.getByRole('button', { name: /Xóa lọc/ }).click();
    await pa.locator('.lead-table tbody tr').first().click();
    const drawer = pa.getByRole('dialog', { name: 'Chi tiết lead' });
    await drawer.getByRole('radio', { name: 'Đã liên hệ' }).click();
    await drawer.locator('textarea').fill('E2E: đã gọi, hẹn tuần sau');
    await drawer.getByRole('button', { name: 'Thêm ghi chú' }).click();
    await drawer.getByText('E2E: đã gọi, hẹn tuần sau').waitFor();
    assert(!(await drawer.innerText()).toLowerCase().includes('qlead_shared_worker'), 'internal source label shown');
    await pa.keyboard.press('Escape');
    await pa.getByRole('tab', { name: /Đã liên hệ/ }).click();
    assert(await pa.locator('.lead-table tbody tr').count() === 1, 'status filter');
    let stored = false;
    for (let i = 0; i < 20 && !stored; i++) {
      stored = (await pool.query("SELECT 1 FROM lead_states WHERE user_id = $1 AND status = 'contacted'", [ID.a])).rowCount === 1;
      if (!stored) await pa.waitForTimeout(250);
    }
    assert(stored, 'state not stored');
    assert((await pool.query('SELECT count(*)::int AS n FROM lead_notes WHERE user_id = $1', [ID.a])).rows[0].n === 1, 'note not stored');
    await shot(pa, 'leads-1440');
  });
  await check('14 worker API and Admin worker page still work', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/worker/status', headers: { authorization: `Bearer ${workerToken}` } });
    assert(status.statusCode === 200 && status.json().status === 'active', status.body);
    const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: { authorization: `Bearer ${workerToken}` }, payload: { max_jobs: 2 } });
    assert(claim.statusCode === 200 && claim.json().jobs.length === 2, claim.body);
    await pAdmin.goto(`${BASE}/admin/workers`);
    await pAdmin.getByRole('article', { name: 'E2E Muse 01' }).getByText('Tài khoản đang hoạt động').waitFor();
  });

  for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]] as const) {
    await check(`15 layout ${w}px: group page, lead list and admin review fit without horizontal overflow`, async () => {
      const v = await login('E2E User A', w, h);
      for (const [path, name] of [['/app/de-xuat-nhom', 'group-requests'], ['/app/bai-viet', 'leads']]) {
        await v.page.goto(`${BASE}${path}`);
        await v.page.locator('h1').waitFor();
        assert(await noOverflow(v.page), `${path} overflow`);
        await shot(v.page, `${name}-${w}`);
      }
      await v.context.close();
      const ad = await login('E2E Admin', w, h);
      await ad.page.goto(`${BASE}/admin/group-requests`);
      await ad.page.getByRole('tab', { name: /Tất cả/ }).click();
      assert(await noOverflow(ad.page), 'admin overflow');
      await shot(ad.page, `admin-group-requests-${w}`);
      await ad.context.close();
    });
  }
  await check('no browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ')); });
} finally {
  await browser.close();
  writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (!process.env.KEEP_FIXTURES) await removeFixtures();
  await app.close(); await pool.end();
  process.exitCode = failed ? 1 : 0;
}
