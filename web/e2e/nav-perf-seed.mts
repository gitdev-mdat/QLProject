// Seeds the ISOLATED navigation-performance database (muse_bridge_test_nav, template muse_bridge_test_goat):
// a "large" customer with 260 source-linked leads, an "empty" customer with a search profile and no leads, and an admin.
// Sessions are inserted directly; leads go through the real worker API in-process (app.inject). No production data.
// From the repo root: $env:DATABASE_URL=<…/muse_bridge_test_nav>; npx tsx web/e2e/nav-perf-seed.mts
// Prints JSON {large, empty, admin} with session tokens for web/e2e/nav-perf.mts.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';

if (!/muse_bridge_test_nav/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run: DATABASE_URL must point at muse_bridge_test_nav.'); process.exit(2); }
const RUN = randomBytes(3).toString('hex');
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const workerToken = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${workerToken}` };

async function user(tag: string) {
  const [{ id }] = await q('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [`Nav ${tag} ${RUN}`]);
  const token = randomBytes(32).toString('base64url');
  await q("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '2 days')", [id, createHash('sha256').update(token).digest('hex')]);
  return { userId: id as string, token };
}
async function profile(userId: string, name: string) {
  const [{ id }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
  await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
    VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 30, $3)`, [id, JSON.stringify(['quán cà phê sắp khai trương']), 'Tôi bán phần mềm bán hàng, tìm quán F&B sắp khai trương']);
  return id as string;
}

// A worker that may claim jobs for these profiles.
await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at)
  VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`Nav worker ${RUN}`, createHash('sha256').update(workerToken).digest('hex')]);

const large = await user('large');
const largeProfile = await profile(large.userId, 'Quán F&B sắp mở');
const empty = await user('empty');
await profile(empty.userId, 'Khách sạn Hà Nội');
const admin = await user('admin');

const client = await pool.connect();
try { await client.query('BEGIN'); await enqueueInitialJob(client, largeProfile); await client.query('COMMIT'); } finally { client.release(); }
const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: largeProfile } });
const job = claim.json().jobs?.[0];
if (!job) throw new Error(`claim failed: ${claim.body}`);
const posts = Array.from({ length: 260 }, (_, i) => ({
  url: `https://www.facebook.com/groups/nav-perf/posts/${RUN}${i}`,
  author: `Quán số ${i + 1}`,
  content: `Quán cà phê số ${i + 1} ở Quận ${(i % 12) + 1} sắp khai trương, cần tìm phần mềm bán hàng và máy POS. Liên hệ 09${String(10000000 + i).slice(0, 8)}.`,
  summary_vi: i % 3 === 0 ? `Quán cà phê số ${i + 1} sắp khai trương, đang tìm phần mềm bán hàng.` : null,
  published_at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
  collected_via: 'controlled_fixture',
}));
const submit = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
  event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
  keywords_used: job.search.keywords, sources_used: job.search.sources, posts, stats: { total_found: posts.length }, errors: [] } });
if (submit.statusCode !== 200) throw new Error(`submit ${submit.statusCode} ${submit.body}`);

const out = { large, empty, admin };
writeFileSync(process.env.SEED_OUT ?? 'nav-perf-seed.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ large: large.userId, empty: empty.userId, admin: admin.userId }));
await app.close();
await pool.end();
