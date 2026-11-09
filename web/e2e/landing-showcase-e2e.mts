// Landing showcase (pinned demo leads), end to end on the ISOLATED copy muse_bridge_landing (migrations up to 023).
// Runs the same ops functions the admin runs on production (start → Muse result via the real worker API → pin), then
// checks the landing API of a running web server that has NO catalog configured.
// 1. Web app (from web/): DATABASE_URL=…/muse_bridge_landing QLEAD_ENVIRONMENT=local QLEAD_LANDING_CATALOG_USER_IDS= next start -p 3073
// 2. From the repo root: DATABASE_URL=<same> npx tsx web/e2e/landing-showcase-e2e.mts http://127.0.0.1:3073
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { app } from '../../src/server.js';
import { landingShowcasePin, landingShowcaseStart, landingShowcaseStatus } from '../../ops/landing-showcase.ts';
import { DEFAULT_LANDING_REQUEST } from '../lib/landing-search.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3073';
if (!/\/muse_bridge_landing(\?|$)/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing: DATABASE_URL must point at muse_bridge_landing.'); process.exit(2); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let passed = 0, failed = 0;
const check = async (name: string, fn: () => Promise<string | void>) => {
  try { const note = await fn(); passed++; console.log(`PASS ${name}${note ? ` — ${note}` : ''}`); }
  catch (error) { failed++; console.log(`FAIL ${name} — ${(error as Error).message}`); }
};
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const search = async (query: string) => {
  const response = await fetch(`${BASE}/api/landing/search`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ query }) });
  assert(response.ok, `search ${response.status}`);
  return response.json() as Promise<{ outcome: string; nearest?: boolean; leads: Array<{ match: string; excerpt: string; url: string | null }> }>;
};

// Isolation: earlier demo rows and pins in this copy are removed, other pending jobs are parked.
await db.query("DELETE FROM landing_showcase_pins");
await db.query("DELETE FROM users WHERE display_name = 'QLead Demo (landing)'");
await db.query("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");

let profileId = '';
await check('S1 start creates the demo account + search and queues one initial job', async () => {
  const log = console.log; let out = ''; console.log = (text: string) => { out += text; };
  try { await landingShowcaseStart(db); } finally { console.log = log; }
  const created = JSON.parse(out);
  profileId = created.profile_id;
  const { rows } = await db.query("SELECT kind, status FROM search_jobs WHERE search_profile_id = $1", [profileId]);
  const { rows: [config] } = await db.query('SELECT description, enabled, frequency_minutes FROM scan_configs WHERE agent_connection_id = $1', [profileId]);
  assert(rows.length === 1 && rows[0].kind === 'initial' && rows[0].status === 'pending', JSON.stringify(rows));
  assert(config.description === DEFAULT_LANDING_REQUEST && config.enabled, 'config');
  const again = await landingShowcaseStart(db).then(() => db.query("SELECT count(*)::int n FROM users WHERE display_name = 'QLead Demo (landing)'"));
  assert(again.rows[0].n === 1, 'second start must not duplicate');
  return `profile ${profileId.slice(0, 8)}, keywords ${(created.keywords as string[]).length}`;
});

await check('S2 Muse returns the demo results through the real worker API', async () => {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at)
    VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`showcase-e2e ${token.slice(0, 6)}`, createHash('sha256').update(token).digest('hex')]);
  const auth = { authorization: `Bearer ${token}` };
  const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profileId } });
  const job = claim.json().jobs[0];
  assert(job, `claim ${claim.statusCode} ${claim.body}`);
  const run = randomBytes(3).toString('hex');
  const texts = [
    'Quán cà phê sân vườn sắp khai trương ở Thủ Đức, đang tuyển 5 nhân viên pha chế và phục vụ, cần tìm phần mềm quản lý bán hàng.',
    'Nhà hàng lẩu nướng chuẩn bị mở chi nhánh thứ 2 tại Quận 7, tuyển gấp quản lý ca và thu ngân.',
    'Trà sữa mới khai trương tháng này, cần máy POS và máy in bill.',
    'Bán xe máy cũ giá rẻ.',
  ];
  const result = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
    keywords_used: job.search.keywords, sources_used: job.search.sources,
    posts: texts.map((content, i) => ({ url: `https://www.facebook.com/groups/showcase${run}/posts/9000${i}`, author: `Chủ quán ${i}`, content,
      published_at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(), collected_via: 'controlled_fixture' })),
    stats: { total_found: texts.length }, errors: [] } });
  assert(result.statusCode === 200, `results ${result.statusCode} ${result.body}`);
  return `${texts.length} posts`;
});

await check('S3 status shows the finished job and the posts', async () => {
  const log = console.log; let out = ''; console.log = (text: string) => { out += `${text}\n`; };
  try { await landingShowcaseStatus(db); } finally { console.log = log; }
  assert(/"posts": 4/.test(out) && /"status": "completed"/.test(out), out.slice(0, 300));
});

await check('S4 pin picks the two best F&B leads (never the unrelated post) and pauses the demo search', async () => {
  const log = console.log; console.log = () => undefined;
  try { await landingShowcasePin(db, []); } finally { console.log = log; }
  const { rows } = await db.query('SELECT sp.position, fp.content FROM landing_showcase_pins sp JOIN facebook_posts fp ON fp.id = sp.post_id ORDER BY sp.position');
  assert(rows.length === 2 && rows.every(row => !/xe máy/.test(row.content)), JSON.stringify(rows));
  const { rows: [config] } = await db.query('SELECT enabled FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [profileId]);
  assert(config.enabled === false, 'demo search should be paused');
  return rows.map(row => String(row.content).slice(0, 40)).join(' | ');
});

await new Promise(resolve => setTimeout(resolve, 61_000)); // the server caches pins for a minute

await check('S5 landing default request shows the pinned leads (no catalog configured)', async () => {
  const body = await search(DEFAULT_LANDING_REQUEST);
  assert(body.outcome === 'found' && !body.nearest && body.leads.length === 2, JSON.stringify(body).slice(0, 300));
  return body.leads.map(lead => lead.match).join(' | ');
});

await check('S6 unmatched request is never empty: pinned leads labelled honestly', async () => {
  const body = await search('Tôi bán máy lọc nước công nghiệp, muốn tìm nhà máy dệt may ở Lào Cai cần thay hệ thống lọc.');
  assert(body.outcome === 'found' && body.nearest === true && body.leads.length === 2 && body.leads.every(lead => lead.match === 'Lead thật QLead đã tìm thấy'), JSON.stringify(body).slice(0, 300));
});

await check('S7 pinning forever: the pins survive their posts getting old', async () => {
  await db.query("UPDATE facebook_posts SET published_at = now() - interval '200 days', first_seen_at = now() - interval '200 days' WHERE id IN (SELECT post_id FROM landing_showcase_pins)");
  await new Promise(resolve => setTimeout(resolve, 61_000));
  const body = await search("Tôi bán dịch vụ vệ sinh công nghiệp, muốn tìm kho xưởng ở Bình Dương cần vệ sinh định kỳ.");
  assert(body.leads.length === 2, JSON.stringify(body).slice(0, 300));
});

await check('S8 re-pin works when every demo post is months old (Muse often returns older posts)', async () => {
  await db.query("UPDATE facebook_posts SET published_at = now() - interval '90 days', first_seen_at = now() - interval '90 days' WHERE agent_connection_id = $1", [profileId]);
  const log = console.log; console.log = () => undefined;
  try { await landingShowcasePin(db, []); } finally { console.log = log; }
  const { rows } = await db.query('SELECT fp.content FROM landing_showcase_pins sp JOIN facebook_posts fp ON fp.id = sp.post_id ORDER BY sp.position');
  assert(rows.length === 2 && rows.every(row => !/xe máy/.test(row.content)), JSON.stringify(rows));
});

await db.end();
await app.close();
console.log(`${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
