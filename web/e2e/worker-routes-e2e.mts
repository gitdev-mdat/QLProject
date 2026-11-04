/**
 * Muse worker API contract through the Next.js Route Handlers (production shape: no Fastify process).
 * Synthetic data only, on an ISOLATED test database. Refuses any database whose name lacks "test".
 *
 *   DATABASE_URL=postgres://…@127.0.0.1:55432/muse_bridge_envtest_fresh npx tsx web/e2e/worker-routes-e2e.mts http://127.0.0.1:3031
 * (the Next server must run with the same DATABASE_URL.)
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const base = (process.argv[2] ?? 'http://127.0.0.1:3031').replace(/\/$/, '');
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('test')) throw new Error('Refusing: use a loopback *test* database.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let passed = 0;
async function step(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`ok  ${name}`); }
const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined || opts.raw ? { 'content-type': 'application/json' } : {}) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

// Isolation: park every other worker/profile so this run controls the whole queue of this test database.
await db.query("UPDATE muse_workers SET status = 'paused' WHERE status = 'active'");
await db.query("UPDATE search_jobs SET status = 'cancelled' WHERE status IN ('pending','claimed')");
const token = randomBytes(32).toString('base64url');
const { rows: [user] } = await db.query("INSERT INTO users(display_name) VALUES ('E2E Worker Routes') RETURNING id");
const { rows: [profile] } = await db.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'E2E routes', 'search_profile') RETURNING id", [user.id]);
await db.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES ($1, 1, '["e2e quán mới"]', '', '["social.search"]', 30)`, [profile.id]);
const run = Date.now().toString(36);
await db.query("INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim) VALUES ($2, $1, 'active', '[\"social.search\"]', 1)",
  [createHash('sha256').update(token).digest('hex'), `E2E routes worker ${run}`]);

try {
  await step('health', async () => { const r = await call('GET', '/health'); assert.equal(r.status, 200); assert.deepEqual(r.json, { status: 'ok', database: 'connected' }); });
  await step('401 without / with wrong credential', async () => {
    assert.equal((await call('GET', '/api/worker/status')).status, 401);
    assert.equal((await call('GET', '/api/worker/status', { token: randomBytes(32).toString('base64url') })).status, 401);
  });
  await step('status', async () => { const r = await call('GET', '/api/worker/status', { token }); assert.equal(r.status, 200); assert.equal(r.json.status, 'active'); assert.equal(r.json.max_jobs_per_claim, 1); });
  let generation = '';
  await step('wake signal true with no-store, dispatch namespaced', async () => {
    const r = await call('GET', '/api/public/worker-wake');
    assert.equal(r.status, 200); assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(r.json.wake, true); generation = r.json.generation;
    const d = await call('GET', '/api/public/worker-dispatch');
    assert.equal(d.json.wake, true); assert.equal(d.json.generation, `${d.json.environment}:${generation}`);
  });
  await step('invalid JSON / unknown body field → 400', async () => {
    assert.equal((await call('POST', '/api/worker/jobs/claim', { token, raw: '{oops' })).status, 400);
    assert.equal((await call('POST', '/api/worker/jobs/claim', { token, body: { max_jobs: 1, extra: true } })).status, 400);
  });
  let job: any;
  await step('claim materialises the recurring slot and leases one job', async () => {
    const r = await call('POST', '/api/worker/jobs/claim', { token, body: { max_jobs: 1 } });
    assert.equal(r.status, 200); assert.equal(r.json.jobs.length, 1);
    job = r.json.jobs[0];
    assert.equal(job.configuration_version, 1); assert.ok(job.lease_expires_at);
    assert.deepEqual(job.search.keywords, ['e2e quán mới']);
  });
  await step('capacity: second claim returns nothing, wake goes quiet while leased', async () => {
    assert.equal((await call('POST', '/api/worker/jobs/claim', { token })).json.jobs.length, 0);
    assert.deepEqual((await call('GET', '/api/public/worker-wake')).json, { wake: false });
  });
  await step('bad job id → 400', async () => { assert.equal((await call('POST', '/api/worker/jobs/job-x/results', { token, body: {} })).status, 400); });
  const results = () => ({ event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, attempt_no: job.attempt_no,
    scanned_at: new Date().toISOString(), keywords_used: ['e2e quán mới'], posts: [{ url: `https://www.facebook.com/groups/e2e/posts/${Date.now()}`, author: 'E2E', content: 'Sắp khai trương quán, cần máy POS', collected_via: 'integration_test' }],
    stats: { total_found: 1 }, errors: [] });
  let first: any;
  const payload = results();
  await step('results accepted', async () => {
    const r = await call('POST', `/api/worker/jobs/${job.job_id}/results`, { token, body: payload });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.accepted, true); assert.equal(r.json.inserted_posts, 1); first = r.json;
  });
  await step('lost-ack retry is idempotent (same ack, nothing written twice)', async () => {
    const r = await call('POST', `/api/worker/jobs/${job.job_id}/results`, { token, body: payload });
    assert.equal(r.status, 200); assert.equal(r.json.server_received_at, first.server_received_at);
    const { rows: [n] } = await db.query('SELECT count(*)::int AS n FROM scan_runs WHERE search_job_id = $1', [job.job_id]);
    assert.equal(n.n, 1);
  });
  await step('results stored for the profile owner only', async () => {
    const { rows } = await db.query('SELECT ac.user_id FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE fp.agent_connection_id = $1', [profile.id]);
    assert.equal(rows.length, 1); assert.equal(rows[0].user_id, user.id);
  });
  await step('another worker cannot submit or fail this job', async () => {
    const other = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO muse_workers(name, credential_hash, status, authorized_sources) VALUES ($2, $1, 'paused', '[\"social.search\"]')", [createHash('sha256').update(other).digest('hex'), `E2E other ${run}`]);
    assert.equal((await call('POST', `/api/worker/jobs/${job.job_id}/results`, { token: other, body: payload })).status, 409);
    assert.equal((await call('POST', `/api/worker/jobs/${job.job_id}/failure`, { token: other, body: { scan_id: job.scan_id, code: 'execution_error' } })).status, 409);
  });
  await step('unknown route 404, wrong method 405', async () => {
    assert.equal((await call('GET', '/api/worker/nope', { token })).status, 404);
    assert.equal((await call('GET', '/api/worker/jobs/claim', { token })).status, 405);
  });
  console.log(`\n${passed}/${passed} passed`);
} finally {
  await db.query("UPDATE muse_workers SET status = 'paused' WHERE name LIKE 'E2E%'");
  await db.end();
}
