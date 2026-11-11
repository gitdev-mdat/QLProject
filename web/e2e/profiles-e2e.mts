// Browser + API E2E for saved search profiles and lead provenance, on the ISOLATED test database (never the live one).
// 1. Start the web app against the test DB (from web/):
//    $env:DATABASE_URL='postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test'; $env:QLEAD_DIST_DIR='.next-profiles-e2e'
//    $env:ENABLE_DEV_QUICK_LOGIN='true'
//    $env:DEV_QUICK_LOGIN_USERS='lan:E2E Lan:00000000-0000-4000-8000-00000000e2a1,minh:E2E Minh:00000000-0000-4000-8000-00000000e2b1,moi:E2E Moi:00000000-0000-4000-8000-00000000e2c1,cu:E2E Cu:00000000-0000-4000-8000-00000000e2d1,tre:E2E Tre:00000000-0000-4000-8000-00000000e2e1'
//    npm run dev -- -p 3005
// 2. From the repo root: $env:DATABASE_URL=<same>; npx tsx web/e2e/profiles-e2e.mts http://127.0.0.1:3005
import { chromium, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../src/db.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3005';
if (!/muse_bridge_test/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test.'); process.exit(2); }
const SHOTS = resolve(process.env.SHOT_DIR ?? 'docs/profile-screenshots');
mkdirSync(SHOTS, { recursive: true });

const U = { lan: '00000000-0000-4000-8000-00000000e2a1', minh: '00000000-0000-4000-8000-00000000e2b1', moi: '00000000-0000-4000-8000-00000000e2c1', cu: '00000000-0000-4000-8000-00000000e2d1', tre: '00000000-0000-4000-8000-00000000e2e1' };
const P = { fnb: '', hotel: '', spa: '', draft: '', legacyLan: '', minhActive: '', minhPending: '', legacyCu: '', late: '' };
const POST = { shared: '', v1: '', spaOld: '', legacy: '', minh: '' };

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d ?? '' }); console.log(`PASS ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message.split('\n')[0] }); console.log(`FAIL ${name} — ${(e as Error).message.split('\n')[0]}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

async function profile(user: string, name: string, kind: 'search_profile' | 'legacy_agent' = 'search_profile') {
  const hash = kind === 'legacy_agent' ? createHash('sha256').update(randomBytes(16)).digest('hex') : null;
  return (await q<{ id: string }>('INSERT INTO agent_connections(user_id, name, kind, credential_hash) VALUES ($1, $2, $3, $4) RETURNING id', [user, name, kind, hash]))[0].id;
}
async function config(id: string, version: number, keywords: string[], location: string, enabled: boolean, ago: string, description: string | null = null) {
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes, description, updated_at)
    VALUES ($1, $2, $3, $4, $5, '["social.search"]', 30, $6, now() - $7::interval)`, [id, version, enabled, JSON.stringify(keywords), location, description, ago]);
}
async function scan(id: string, version: number, ago: string, found: number, added: number, status = 'success') {
  await q(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, received_at, total_found, received_posts, new_posts, duplicates_skipped, status)
    VALUES ($1, $2, $3, now() - $4::interval, now() - $4::interval, $5, $6, $6, 0, $7)`, [id, `e2e-${randomBytes(6).toString('hex')}`, version, ago, found, added, status]);
}
async function post(id: string, slug: string, content: string, ago: string, versions: number[]) {
  const url = `https://facebook.com/e2e-profiles/${slug}`;
  const [row] = await q<{ id: string }>(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, content, author, published_at, first_seen_at, collected_via)
    VALUES ($1, $2, $2, $3, 'E2E Trang', now() - $4::interval - interval '1 hour', now() - $4::interval, 'qlead_shared_worker') RETURNING id`, [id, url, content, ago]);
  for (const v of versions) await q('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1, $2, $3)', [id, url, v]);
  return row.id;
}

async function removeFixtures() { await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(U)]); }
async function seed() {
  await removeFixtures();
  for (const [key, id] of Object.entries(U)) await q('INSERT INTO users(id, display_name) VALUES ($1, $2)', [id, `E2E ${key[0].toUpperCase()}${key.slice(1)}`]);
  // Lan: G (two active), F (leads), E (no results), H (paused with history), C (draft), K (edited), L (shared post), J (legacy)
  P.fnb = await profile(U.lan, 'Quán F&B sắp khai trương');
  await config(P.fnb, 1, ['quán ăn sắp khai trương'], 'Miền Nam', true, '3 days', 'Quán ăn sắp khai trương ở miền Nam');
  await config(P.fnb, 2, ['quán ăn sắp khai trương', 'nhà hàng sắp khai trương'], 'Miền Nam', true, '1 day', 'Quán ăn, nhà hàng sắp khai trương ở miền Nam');
  await scan(P.fnb, 1, '2 days', 40, 1); await scan(P.fnb, 2, '10 minutes', 25, 1);
  POST.v1 = await post(P.fnb, 'fnb-v1', 'Quán ăn Hương Quê sắp khai trương ở Thủ Đức, đang tuyển nhân viên phục vụ.', '2 days', [1]);
  POST.shared = await post(P.fnb, 'shared', 'Nhà hàng Sen Vàng chuẩn bị khai trương chi nhánh mới tại Quận 7.', '10 minutes', [2]);
  P.hotel = await profile(U.lan, 'Khách sạn mới ở Đà Nẵng');
  await config(P.hotel, 1, ['khách sạn sắp khai trương'], 'Đà Nẵng', true, '2 days');
  await scan(P.hotel, 1, '15 minutes', 12, 0);
  P.spa = await profile(U.lan, 'Spa sắp khai trương');
  await config(P.spa, 1, ['spa sắp khai trương', 'nhà hàng chi nhánh mới'], 'TP.HCM', true, '5 days');
  await config(P.spa, 2, ['spa sắp khai trương', 'nhà hàng chi nhánh mới'], 'TP.HCM', false, '1 day');
  await scan(P.spa, 1, '3 days', 30, 2);
  POST.spaOld = await post(P.spa, 'spa-old', 'Spa Mộc An sắp khai trương ở Gò Vấp, đang tìm mặt bằng thứ hai.', '3 days', [1]);
  await post(P.spa, 'shared', 'Nhà hàng Sen Vàng chuẩn bị khai trương chi nhánh mới tại Quận 7.', '5 minutes', [1]);
  await q("INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources) VALUES ($1, 2, 'job-e2e-pending', date_trunc('hour', now()) - interval '1 day', '[\"social.search\"]')", [P.fnb]);
  P.draft = await profile(U.lan, 'Tiệm bánh (nháp)');
  await config(P.draft, 1, ['tiệm bánh sắp khai trương'], 'Hà Nội', false, '1 hour');
  P.legacyLan = await profile(U.lan, 'Muse Lan', 'legacy_agent');
  await config(P.legacyLan, 1, ['quán cafe sắp khai trương'], 'TP.HCM', true, '10 days');
  await scan(P.legacyLan, 1, '9 days', 20, 1);
  POST.legacy = await post(P.legacyLan, 'legacy', 'Quán cafe Gió Nam sắp khai trương, cần tư vấn máy tính tiền.', '9 days', []);
  await q("INSERT INTO lead_states(user_id, post_id, status) VALUES ($1, $2, 'contacted')", [U.lan, POST.v1]);
  await q("INSERT INTO lead_notes(user_id, post_id, body) VALUES ($1, $2, 'E2E: đã gọi lần 1')", [U.lan, POST.v1]);
  // Minh: D (first scan pending) and an active profile with a lead
  P.minhActive = await profile(U.minh, 'Đại lý mỹ phẩm Hà Nội');
  await config(P.minhActive, 1, ['đại lý mỹ phẩm tuyển'], 'Hà Nội', true, '1 day');
  await scan(P.minhActive, 1, '20 minutes', 9, 1);
  POST.minh = await post(P.minhActive, 'minh', 'Đại lý mỹ phẩm Hoa Mai mở thêm chi nhánh ở Cầu Giấy, tuyển nhân viên bán hàng.', '20 minutes', [1]);
  P.minhPending = await profile(U.minh, 'Nhà thuốc mới');
  await config(P.minhPending, 1, ['nhà thuốc sắp khai trương'], 'Hà Nội', true, '5 minutes');
  // Moi: A (nothing). Cu: B (legacy only). Tre: I (delayed)
  P.legacyCu = await profile(U.cu, 'Muse Cu', 'legacy_agent');
  await config(P.legacyCu, 1, ['quán nhậu sắp khai trương'], 'Cần Thơ', true, '20 days');
  await scan(P.legacyCu, 1, '15 days', 10, 1);
  await post(P.legacyCu, 'cu', 'Quán nhậu Bến Ninh Kiều sắp khai trương, cần mua bàn ghế.', '15 days', []);
  P.late = await profile(U.tre, 'Cửa hàng điện thoại');
  await config(P.late, 1, ['cửa hàng điện thoại khai trương'], 'TP.HCM', true, '2 days');
  await scan(P.late, 1, '3 hours', 15, 0);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors: string[] = [];
async function login(label: string, width = 1440, height = 1000) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  // HTTP 4xx from the deliberate rejection checks below are logged by the browser as resource errors; they are not app errors.
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
const card = (p: Page, name: string) => p.locator('.profile-card', { has: p.getByRole('heading', { name, exact: true }) });
const api = (p: Page, url: string, method: string, body: unknown) => p.evaluate(async ([u, m, b]) =>
  (await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [url, method, body] as const);

try {
  await seed();
  const lan = await login('E2E Lan');
  const pa = lan.page;

  await check('G/F/E/H/C profiles list with real states and lead counts', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    const expected: Array<[string, string, number]> = [['Quán F&B sắp khai trương', 'Đang theo dõi', 2], ['Khách sạn mới ở Đà Nẵng', 'Đang theo dõi', 0], ['Spa sắp khai trương', 'Tạm dừng', 2], ['Tiệm bánh (nháp)', 'Bản nháp', 0]];
    for (const [name, state, leads] of expected) {
      const c = card(pa, name);
      assert(await c.count() === 1, `card ${name} missing`);
      assert((await c.locator('.profile-state').innerText()).includes(state), `${name} state ${await c.locator('.profile-state').innerText()}`);
      assert((await c.getByRole('link', { name: /Xem lead/ }).innerText()).includes(`(${leads})`), `${name} lead count`);
    }
    assert(await pa.getByText('Đang theo dõi 2/4 nhu cầu.').isVisible(), 'summary count');
    assert(await card(pa, 'Khách sạn mới ở Đà Nẵng').getByText(/chưa tìm thấy bài phù hợp/).isVisible(), 'E no-results message');
    assert(await pa.locator('.legacy-card').getByText(/1 lead từ các lượt quét không gắn/).isVisible(), 'legacy summary');
    assert(!(await pa.locator('body').innerText()).match(/Muse|worker/i), 'internal wording leaked');
    await shot(pa, 'profiles-1440');
    return '4 profiles + legacy summary';
  });

  await check('Today shows monitored profiles, estimated next slot and attributed scans', async () => {
    await pa.goto(`${BASE}/app`);
    assert(await pa.getByText('Đang theo dõi 2 nhu cầu').isVisible(), 'monitor summary');
    await pa.locator('.scan-next-label').waitFor();
    assert(await pa.locator('.scan-next-label').innerText() === 'Lượt quét dự kiến tiếp theo', 'next label');
    const sources = await pa.locator('.scan-run-source').allInnerTexts();
    assert(sources.includes('Quán F&B sắp khai trương') && sources.includes('Lượt quét trước'), sources.join('|'));
    const [{ unseen }] = await q<{ unseen: number }>(`SELECT count(DISTINCT fp.normalized_url)::int AS unseen FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id
      WHERE ac.user_id = $1 AND fp.normalized_url NOT IN (SELECT p2.normalized_url FROM lead_states s JOIN facebook_posts p2 ON p2.id = s.post_id WHERE s.user_id = $1 AND s.status <> 'new')`, [U.lan]);
    const shown = Number(await pa.locator('.summary-row div').first().locator('dd').innerText());
    assert(shown === unseen, `unseen shown ${shown} vs db ${unseen}`);
    assert(!(await pa.locator('body').innerText()).match(/Muse|worker/i), 'internal wording on Today');
    await shot(pa, 'today-1440');
    return `unseen ${shown} = DB`;
  });

  await check('L: a post found by two profiles is one lead with both sources', async () => {
    await pa.goto(`${BASE}/app/bai-viet`);
    const rows = pa.locator('.lead-table tbody tr', { hasText: 'Sen Vàng' });
    assert(await rows.count() === 1, `shared post rows ${await rows.count()}`);
    assert((await rows.locator('.lead-source').innerText()).includes('+1 nhu cầu'), 'multi badge');
    await rows.click();
    const prov = pa.locator('.lead-drawer .lead-provenance');
    await prov.waitFor();
    const text = await prov.innerText();
    assert(text.includes('Quán F&B sắp khai trương') && text.includes('Spa sắp khai trương'), text);
    await pa.keyboard.press('Escape');
    return 'one row, two attributions';
  });

  await check('J: legacy lead is labelled, never given a specific request', async () => {
    await pa.goto(`${BASE}/app/bai-viet/${POST.legacy}`);
    const text = await pa.locator('.lead-provenance').innerText();
    assert(text.includes('Dữ liệu từ lượt quét trước') && !text.includes('Quán F&B'), text);
    return 'legacy label';
  });

  await check('Filter by profile, from the profile card and via the select', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await card(pa, 'Spa sắp khai trương').getByRole('link', { name: /Xem lead/ }).click();
    await pa.waitForURL(/nhu-cau=/);
    await pa.locator('.lead-table').waitFor();
    const authors = await pa.locator('.lead-table tbody tr .lead-cell p').allInnerTexts();
    assert(authors.length === 2 && authors.some(t => t.includes('Mộc An')), authors.join('|'));
    await pa.getByLabel('Lọc theo nhu cầu').selectOption({ label: 'Dữ liệu từ lượt quét trước' });
    const legacyRows = await pa.locator('.lead-table tbody tr').count();
    assert(legacyRows === 1, `legacy rows ${legacyRows}`);
    await shot(pa, 'leads-filtered-1440');
    return 'spa 2, legacy 1';
  });

  const before = await q<{ n: number; s: string }>("SELECT (SELECT count(*)::int FROM lead_notes WHERE user_id = $1) AS n, (SELECT string_agg(post_id::text || status, ',' ORDER BY post_id) FROM lead_states WHERE user_id = $1) AS s", [U.lan]);

  await check('K: editing a profile adds a version and keeps historical attribution', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await card(pa, 'Quán F&B sắp khai trương').getByRole('button', { name: 'Sửa' }).click();
    const form = pa.locator('.profile-form');
    await form.getByLabel('Tên nhu cầu').fill('Quán F&B miền Nam');
    await form.getByText('Tùy chọn nâng cao').click();
    await form.getByLabel('Tự đặt cụm tìm kiếm thay cho gợi ý của QLead').check();
    await form.getByLabel('Cụm tìm kiếm riêng').fill('quán ăn chuẩn bị khai trương\nquán bún sắp khai trương');
    await form.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await card(pa, 'Quán F&B miền Nam').waitFor();
    const versions = await q<{ version: number; keywords: string[] }>('SELECT version, keywords FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version', [P.fnb]);
    assert(versions.length === 3 && versions[2].keywords.includes('quán bún sắp khai trương'), JSON.stringify(versions));
    const assoc = await q('SELECT configuration_version FROM facebook_post_search_configs WHERE agent_connection_id = $1 ORDER BY normalized_url', [P.fnb]);
    assert(JSON.stringify(assoc.map(a => a.configuration_version)) === '[1,2]', JSON.stringify(assoc));
    await pa.goto(`${BASE}/app/bai-viet/${POST.v1}`);
    const text = await pa.locator('.lead-provenance').innerText();
    assert(text.includes('Quán F&B miền Nam') && text.includes('Điều kiện lúc tìm thấy: quán ăn sắp khai trương · Miền Nam') && !text.includes('quán bún'), text);
    return 'v3 saved, post still shows v1 conditions';
  });

  await check('Pausing keeps leads, cancels the queued scan; resume re-enables', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await card(pa, 'Quán F&B miền Nam').getByRole('button', { name: 'Tạm dừng' }).click();
    await card(pa, 'Quán F&B miền Nam').locator('.profile-state', { hasText: 'Tạm dừng' }).waitFor();
    const [latest] = await q<{ enabled: boolean }>('SELECT enabled FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [P.fnb]);
    const [job] = await q<{ status: string }>("SELECT status FROM search_jobs WHERE scan_id = 'job-e2e-pending'");
    assert(!latest.enabled && job.status === 'cancelled', `enabled ${latest.enabled} job ${job.status}`);
    assert((await card(pa, 'Quán F&B miền Nam').getByRole('link', { name: /Xem lead/ }).innerText()).includes('(2)'), 'leads kept after pause');
    await shot(pa, 'profiles-paused-1440');
    await card(pa, 'Quán F&B miền Nam').getByRole('button', { name: 'Bật lại' }).click();
    await card(pa, 'Quán F&B miền Nam').getByRole('button', { name: 'Tạm dừng' }).waitFor();
    return 'paused → resumed';
  });

  await check('Lead states and notes unchanged by edits and pausing', async () => {
    const after = await q<{ n: number; s: string }>("SELECT (SELECT count(*)::int FROM lead_notes WHERE user_id = $1) AS n, (SELECT string_agg(post_id::text || status, ',' ORDER BY post_id) FROM lead_states WHERE user_id = $1) AS s", [U.lan]);
    assert(JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });

  await check('Create a profile, then it persists after refresh', async () => {
    await pa.goto(`${BASE}/app/bo-loc`);
    await pa.getByRole('button', { name: 'Tạo nhu cầu mới' }).click();
    const form = pa.locator('.profile-form');
    await form.getByLabel('Bạn kinh doanh gì và muốn tìm khách hàng nào?').fill('Quán cafe, trà sữa sắp khai trương ở TP.HCM');
    assert((await form.getByLabel('Khu vực', { exact: true }).inputValue()) === 'TP.HCM', 'location taken from the description');
    assert(await form.locator('.search-preview .keyword-chips li').count() > 0, 'search phrases previewed');
    await form.getByLabel('Tên nhu cầu').fill('Cafe trà sữa TP.HCM');
    await shot(pa, 'profile-create-1440');
    await form.getByRole('button', { name: 'Lưu và bật theo dõi' }).click();
    await card(pa, 'Cafe trà sữa TP.HCM').waitFor();
    await pa.reload();
    const c = card(pa, 'Cafe trà sữa TP.HCM');
    assert((await c.locator('.profile-state').innerText()).includes('Chờ lượt quét đầu'), 'D state for new profile');
    const [row] = await q<{ description: string; created_by_user_id: string; enabled: boolean }>("SELECT sc.description, sc.created_by_user_id, sc.enabled FROM scan_configs sc JOIN agent_connections ac ON ac.id = sc.agent_connection_id WHERE ac.user_id = $1 AND ac.name = 'Cafe trà sữa TP.HCM'", [U.lan]);
    assert(row.description === 'Quán cafe, trà sữa sắp khai trương ở TP.HCM' && row.created_by_user_id === U.lan && row.enabled, JSON.stringify(row));
    return 'saved with original description';
  });

  await check('API rejects cross-origin, invalid input and foreign profiles', async () => {
    const bad = await api(pa, '/api/profiles', 'POST', { profile: { name: 'x', description: '', keywords: ['ab'], location: 'TP.HCM', frequency_minutes: 7 }, enabled: true });
    assert(bad === 400, `invalid frequency ${bad}`);
    const foreign = await api(pa, `/api/profiles/${P.minhActive}`, 'PATCH', { action: 'pause' });
    assert(foreign === 404, `foreign pause ${foreign}`);
    const cross = await fetch(`${BASE}/api/profiles/${P.fnb}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: (await lan.context.cookies()).map(c => `${c.name}=${c.value}`).join('; ') }, body: JSON.stringify({ action: 'pause' }) });
    assert(cross.status === 403, `cross-origin ${cross.status}`);
    const [m] = await q<{ enabled: boolean }>('SELECT enabled FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [P.minhActive]);
    assert(m.enabled, 'Minh profile changed');
    return '400 / 404 / 403';
  });

  for (const [w, h] of [[768, 1024], [390, 844]]) {
    await check(`Responsive ${w}px: profiles, today, leads, detail`, async () => {
      await pa.setViewportSize({ width: w, height: h });
      for (const [path, name] of [['/app/bo-loc', 'profiles'], ['/app', 'today'], ['/app/bai-viet', 'leads'], [`/app/bai-viet/${POST.shared}`, 'detail']]) {
        await pa.goto(`${BASE}${path}`); await pa.waitForLoadState('networkidle');
        assert(await noOverflow(pa), `${path} overflows at ${w}`);
        await shot(pa, `${name}-${w}`);
      }
    });
  }
  await pa.setViewportSize({ width: 1440, height: 1000 });
  await shot(pa, 'detail-1440');
  await lan.context.close();

  const minh = await login('E2E Minh');
  await check('Isolation: Minh sees only his profiles and leads; D pending first scan', async () => {
    const p = minh.page;
    await p.goto(`${BASE}/app/bo-loc`);
    const names = await p.locator('.profile-card h2').allInnerTexts();
    assert(JSON.stringify(names) === JSON.stringify(['Đại lý mỹ phẩm Hà Nội', 'Nhà thuốc mới']), names.join('|'));
    assert((await card(p, 'Nhà thuốc mới').locator('.profile-state').innerText()).includes('Chờ lượt quét đầu'), 'D state');
    await p.goto(`${BASE}/app/bai-viet`);
    const rows = await p.locator('.lead-table tbody tr').count();
    assert(rows === 1, `Minh rows ${rows}`);
    await p.goto(`${BASE}/app/bai-viet/${POST.shared}`);
    assert(await p.getByRole('heading', { name: 'Không tìm thấy lead' }).isVisible(), 'foreign lead visible');
    const status = await api(p, `/api/profiles/${P.fnb}`, 'PATCH', { profile: { name: 'Hijack', description: 'Hijack attempt description', location: 'TP.HCM', frequency_minutes: 30 } });
    assert(status === 404, `edit foreign ${status}`);
    await shot(p, 'profiles-minh-1440');
  });
  await minh.context.close();

  const moi = await login('E2E Moi');
  await check('A: new account sees a genuine onboarding state', async () => {
    const p = moi.page;
    assert(await p.getByRole('heading', { name: 'QLead chưa biết bạn muốn tìm khách hàng nào.' }).isVisible(), 'today empty');
    await p.goto(`${BASE}/app/bo-loc`);
    assert(await p.getByRole('heading', { name: 'QLead chưa biết bạn muốn tìm khách hàng nào.' }).isVisible(), 'profiles empty');
    assert(await p.locator('.legacy-card').count() === 0, 'no legacy card');
    await shot(p, 'profiles-empty-1440');
  });
  await moi.context.close();

  const cu = await login('E2E Cu');
  await check('B: legacy leads without profiles are not presented as empty', async () => {
    const p = cu.page;
    await p.goto(`${BASE}/app/bo-loc`);
    assert(await p.getByRole('heading', { name: 'Chưa có nhu cầu nào đang được theo dõi.' }).isVisible(), 'legacy empty heading');
    assert(await p.locator('.legacy-card').getByText(/1 lead/).isVisible(), 'legacy count');
    await p.goto(`${BASE}/app`);
    assert(await p.getByText('Chưa có nhu cầu nào đang bật.').isVisible(), 'today no monitoring');
    assert(await p.locator('.scan-run-source', { hasText: 'Lượt quét trước' }).count() === 1, 'legacy scan row');
    await shot(p, 'profiles-legacy-1440');
  });
  await cu.context.close();

  const tre = await login('E2E Tre');
  await check('I: delayed monitoring shows an honest warning instead of a countdown', async () => {
    const p = tre.page;
    await p.locator('.scan-next.is-late').waitFor();
    assert(await p.locator('.scan-countdown').count() === 0, 'countdown shown while delayed');
    assert(await p.locator('.scan-next.is-late').getByText(/Lượt quét đang chậm hơn lịch/).isVisible(), 'late warning');
    await p.goto(`${BASE}/app/bo-loc`);
    assert((await card(p, 'Cửa hàng điện thoại').locator('.profile-state').innerText()).includes('Đang chậm'), 'delayed state');
    await shot(p, 'today-delayed-1440');
  });
  await tre.context.close();

  await check('No browser console errors', async () => { assert(consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ')); });
} finally {
  await removeFixtures().catch(() => undefined);
  await browser.close();
  await pool.end();
  const passed = results.filter(r => r.pass).length;
  const summary = `${passed}/${results.length} passed, ${results.length - passed} failed`;
  console.log(summary);
  writeFileSync(resolve(SHOTS, 'results.json'), JSON.stringify({ summary, results }, null, 2));
}
