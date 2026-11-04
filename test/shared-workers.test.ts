import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { enqueueInitialJob } from '../src/jobs.js';

/**
 * Shared-worker POC on synthetic fixtures against the existing local PostgreSQL (migration 006 must be applied).
 * Proves backend behaviour only; it says nothing about what a real Muse account can execute.
 */
const realAgentIds = ['a366abd8-4e93-46dc-be80-bbf3df2af06d', 'e84ffff9-fb61-4887-a19a-6fc452a1f66c'];
const token = () => randomBytes(32).toString('base64url');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const tokens = { w1: token(), w2: token(), w3: token() };
const ids = { userA: '', userB: '', userC: '', profileA: '', profileB: '', profileC: '', w1: '', w2: '', w3: '' };

const claim = (t: string, max_jobs?: number) => app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(t), payload: max_jobs ? { max_jobs } : {} });
const submit = (t: string, jobId: string, body: unknown) => app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/results`, headers: auth(t), payload: body as any });
const fail = (t: string, jobId: string, body: unknown) => app.inject({ method: 'POST', url: `/api/worker/jobs/${jobId}/failure`, headers: auth(t), payload: body as any });
const results = (job: { scan_id: string; configuration_version: number; attempt_no: number }, urls: string[], extra: Record<string, unknown> = {}) => ({
  event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, attempt_no: job.attempt_no,
  scanned_at: '2026-11-01T10:00:00+07:00', keywords_used: [], sources_used: ['social.search'],
  posts: urls.map((url, i) => ({ url, author: `Synthetic author ${i}`, content: `Synthetic content ${i}`, published_at: '2026-11-01T08:00:00+07:00', collected_via: 'integration_test' })),
  stats: { total_found: urls.length }, errors: [], ...extra,
});
/** The customer-facing ownership rule the web app uses (web/lib/server/leads.ts): posts reachable through ac.user_id. */
const visibleUrls = async (userId: string) => (await pool.query(`SELECT fp.normalized_url FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1 ORDER BY 1`, [userId])).rows.map(r => r.normalized_url);
const historyOf = async (profileId: string) => (await pool.query(`SELECT id, external_scan_id, status, new_posts, received_posts FROM scan_runs WHERE agent_connection_id = $1 ORDER BY received_at, id`, [profileId])).rows;
const postsOf = async (profileId: string) => (await pool.query(`SELECT id, agent_connection_id, normalized_url, content, first_seen_at FROM facebook_posts WHERE agent_connection_id = $1 ORDER BY normalized_url`, [profileId])).rows;
/** Moves finished jobs to an earlier slot so the next claim creates a fresh job in the current slot. */
let cycle = 0;
const nextCycle = () => pool.query(`UPDATE search_jobs SET scheduled_for = scheduled_for - make_interval(days => $2) WHERE search_profile_id = ANY($1::uuid[]) AND status IN ('completed', 'failed', 'cancelled') AND scheduled_for > now() - interval '1 hour'`, [[ids.profileA, ids.profileB, ids.profileC], ++cycle]);
const jobFor = (jobs: any[], keyword: string) => jobs.find(j => j.search.keywords.includes(keyword));

async function snapshotLegacy() {
  const [agents, scans, posts] = await Promise.all([
    pool.query('SELECT id, user_id, name, credential_hash, status, kind FROM agent_connections WHERE id = ANY($1::uuid[]) ORDER BY id', [realAgentIds]),
    pool.query('SELECT id, agent_connection_id, external_scan_id, status, new_posts, received_at FROM scan_runs WHERE agent_connection_id = ANY($1::uuid[]) ORDER BY id', [realAgentIds]),
    pool.query('SELECT id, agent_connection_id, normalized_url, content, first_seen_at FROM facebook_posts WHERE agent_connection_id = ANY($1::uuid[]) ORDER BY id', [realAgentIds]),
  ]);
  return { agents: agents.rows, scans: scans.rows, posts: posts.rows };
}

test('shared Muse workers: two customers, one worker, replacement, retries (synthetic)', async t => {
  try { await pool.query('SELECT 1 FROM search_jobs LIMIT 1'); }
  catch { t.skip('PostgreSQL unavailable or migration 006 not applied; run npm run migrate'); await app.close(); await pool.end(); return; }
  // Workers claim every due job in the database. Refuse to run if real profiles or workers exist, so tests never take real work.
  const { rows: [existing] } = await pool.query(`SELECT (SELECT count(*) FROM agent_connections WHERE kind = 'search_profile')::int AS profiles, (SELECT count(*) FROM muse_workers WHERE status = 'active')::int AS workers`);
  if (existing.profiles || existing.workers) { t.skip('Real search profiles or active workers exist; not running claim tests against them'); await app.close(); await pool.end(); return; }

  const legacyBefore = await snapshotLegacy();
  try {
    for (const [key, name] of [['userA', 'Synthetic Shared A'], ['userB', 'Synthetic Shared B'], ['userC', 'Synthetic Shared C']] as const) {
      ids[key] = (await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    }
    for (const [key, user] of [['profileA', ids.userA], ['profileB', ids.userB], ['profileC', ids.userC]] as const) {
      ids[key] = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [user])).rows[0].id;
    }
    await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES
      ($1, 1, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 30),
      ($2, 1, '["khách sạn sắp khai trương"]', 'Hà Nội', '["social.search"]', 30)`, [ids.profileA, ids.profileB]);
    for (const [key, name, status, sources, tok] of [
      ['w1', 'Synthetic Worker 01', 'active', ['social.search'], tokens.w1],
      ['w2', 'Synthetic Worker 02', 'paused', ['social.search'], tokens.w2],
      ['w3', 'Synthetic Worker 03', 'paused', ['social.search'], tokens.w3],
    ] as const) {
      ids[key] = (await pool.query('INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim) VALUES ($1, $2, $3, $4, 5) RETURNING id', [name, hash(tok), status, JSON.stringify(sources)])).rows[0].id;
    }

    let jobA: any; let jobB: any;
    const sharedUrl = 'https://www.facebook.com/groups/khaitruong/posts/900';

    await t.test('profiles hold no credential and credentials are not interchangeable', async () => {
      const { rows: [p] } = await pool.query('SELECT credential_hash FROM agent_connections WHERE id = $1', [ids.profileA]);
      assert.equal(p.credential_hash, null);
      assert.equal((await app.inject({ method: 'GET', url: '/api/agent/config', headers: auth(tokens.w1) })).statusCode, 401, 'worker token must not open the legacy agent API');
      assert.equal((await claim('x'.repeat(43))).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', payload: {} })).statusCode, 401);
    });

    await t.test('public wake is inert for an empty queue and only returns a stable opaque signal for eligible work', async () => {
      const endpoint = () => app.inject({ method: 'GET', url: '/api/public/worker-wake' });
      await pool.query('UPDATE scan_configs SET enabled = false WHERE agent_connection_id = ANY($1::uuid[])', [[ids.profileA, ids.profileB]]);
      const empty = await endpoint();
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json(), { wake: false });
      assert.match(empty.headers['cache-control'] ?? '', /no-store/);

      await pool.query('UPDATE scan_configs SET enabled = true WHERE agent_connection_id = ANY($1::uuid[])', [[ids.profileA, ids.profileB]]);
      const recurring = await endpoint();
      assert.equal(recurring.json().wake, true, 'due recurring work is visible before claim inserts a job');
      assert.match(recurring.json().generation, /^[a-f0-9]{64}$/);
      assert.deepEqual((await endpoint()).json(), recurring.json(), 'unchanged work keeps one generation across repeated polls');
      assert.ok(!/(user|profile|job|scan|query|keyword)/i.test(recurring.body), 'public response reveals no tenant, search or job detail');

      const client = await pool.connect();
      try { await client.query('BEGIN'); await enqueueInitialJob(client, ids.profileA); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      const initial = await endpoint();
      assert.equal(initial.json().wake, true);
      assert.notEqual(initial.json().generation, recurring.json().generation, 'new initial work advances the opaque event marker');
    });

    await t.test('Worker 01 claims both due jobs; payload carries no customer identity', async () => {
      const response = await claim(tokens.w1);
      assert.equal(response.statusCode, 200, response.body);
      const { jobs } = response.json();
      assert.equal(jobs.length, 2);
      jobA = jobFor(jobs, 'quán ăn sắp khai trương'); jobB = jobFor(jobs, 'khách sạn sắp khai trương');
      assert.ok(jobA && jobB);
      assert.equal(jobA.search.location, 'Miền Nam'); assert.equal(jobB.search.location, 'Hà Nội');
      const raw = response.body;
      for (const secret of [ids.userA, ids.userB, ids.profileA, ids.profileB, 'Synthetic Shared']) assert.ok(!raw.includes(secret), `job payload leaks ${secret}`);
      assert.equal((await claim(tokens.w1)).json().jobs.length, 0, 'a claimed job is never handed out twice');
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json(), { wake: false }, 'an executing worker is not woken again');
    });

    await t.test('worker cannot name a customer or change the issued scan', async () => {
      assert.equal((await submit(tokens.w1, jobA.job_id, { ...results(jobA, [sharedUrl]), user_id: ids.userB })).statusCode, 400);
      assert.equal((await submit(tokens.w1, jobA.job_id, results({ ...jobA, scan_id: 'my-own-scan' }, [sharedUrl]))).json().error, 'job_mismatch');
      assert.equal((await submit(tokens.w1, jobA.job_id, results(jobB, [sharedUrl]))).json().error, 'job_mismatch', "job B's scan cannot be filed under job A");
      assert.equal((await submit(tokens.w2, jobA.job_id, results(jobA, [sharedUrl]))).json().error, 'lease_lost', 'another worker cannot submit');
    });

    await t.test('results persist under each original customer and stay isolated', async () => {
      const ra = await submit(tokens.w1, jobA.job_id, results(jobA, [sharedUrl, 'https://facebook.com/groups/khaitruong/posts/901']));
      const rb = await submit(tokens.w1, jobB.job_id, results(jobB, [sharedUrl, 'https://facebook.com/groups/khachsan/posts/77']));
      assert.equal(ra.statusCode, 200, ra.body); assert.equal(rb.statusCode, 200, rb.body);
      assert.equal(ra.json().inserted_posts, 2); assert.equal(rb.json().inserted_posts, 2);
      const a = await visibleUrls(ids.userA); const b = await visibleUrls(ids.userB);
      assert.deepEqual(a, ['https://facebook.com/groups/khaitruong/posts/900', 'https://facebook.com/groups/khaitruong/posts/901']);
      assert.deepEqual(b, ['https://facebook.com/groups/khachsan/posts/77', 'https://facebook.com/groups/khaitruong/posts/900']);
      assert.ok(!a.includes('https://facebook.com/groups/khachsan/posts/77'), 'A cannot see B');
      assert.ok(!b.includes('https://facebook.com/groups/khaitruong/posts/901'), 'B cannot see A');
      const { rows } = await pool.query('SELECT agent_connection_id, search_job_id, executed_by_worker_id FROM scan_runs WHERE search_job_id = ANY($1::uuid[])', [[jobA.job_id, jobB.job_id]]);
      assert.equal(rows.length, 2);
      assert.ok(rows.every(r => r.executed_by_worker_id === ids.w1));
      assert.deepEqual(new Set(rows.map(r => r.agent_connection_id)), new Set([ids.profileA, ids.profileB]));
    });

    await t.test('duplicate delivery returns the original acknowledgement and writes nothing', async () => {
      const before = { scans: await historyOf(ids.profileA), posts: await postsOf(ids.profileA) };
      const first = (await pool.query('SELECT received_at FROM scan_runs WHERE search_job_id = $1', [jobA.job_id])).rows[0];
      const retry = await submit(tokens.w1, jobA.job_id, results(jobA, [sharedUrl, 'https://facebook.com/groups/khaitruong/posts/901', 'https://facebook.com/groups/khaitruong/posts/999']));
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().inserted_posts, 2);
      assert.equal(new Date(retry.json().server_received_at).toISOString(), new Date(first.received_at).toISOString());
      assert.deepEqual({ scans: await historyOf(ids.profileA), posts: await postsOf(ids.profileA) }, before);
      assert.equal((await submit(tokens.w2, jobA.job_id, results(jobA, [sharedUrl]))).json().error, 'job_already_completed');
    });

    await t.test('one failed job does not affect the other; failures are retried with backoff', async () => {
      await nextCycle();
      const { jobs } = (await claim(tokens.w1)).json();
      assert.equal(jobs.length, 2);
      const a2 = jobFor(jobs, 'quán ăn sắp khai trương'); const b2 = jobFor(jobs, 'khách sạn sắp khai trương');
      const postsA = await postsOf(ids.profileA);
      const f = await fail(tokens.w1, a2.job_id, { scan_id: a2.scan_id, attempt_no: a2.attempt_no, code: 'execution_error', message: 'Synthetic search timeout' });
      assert.equal(f.statusCode, 200, f.body); assert.equal(f.json().job_status, 'pending');
      assert.deepEqual((await fail(tokens.w1, a2.job_id, { scan_id: a2.scan_id, attempt_no: a2.attempt_no, code: 'execution_error' })).json(), f.json(), 'repeated failure report is idempotent');
      const rb = await submit(tokens.w1, b2.job_id, results(b2, ['https://facebook.com/groups/khachsan/posts/78']));
      assert.equal(rb.statusCode, 200); assert.equal(rb.json().inserted_posts, 1);
      assert.deepEqual(await postsOf(ids.profileA), postsA, "A's data is untouched by its failure");
      assert.equal((await claim(tokens.w1)).json().jobs.length, 0, 'the failed job waits for its retry delay');
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json(), { wake: false }, 'backoff jobs do not trigger premature runs');
      const { rows: [attempt] } = await pool.query("SELECT outcome, error FROM search_job_attempts WHERE job_id = $1 AND attempt_no = 1", [a2.job_id]);
      assert.equal(attempt.outcome, 'failed'); assert.equal(attempt.error.code, 'execution_error');
      jobA = a2;
    });

    let historyBeforeReplacement: any;
    await t.test('expired lease returns the job to the queue; a late result is still accepted only while unclaimed by others', async () => {
      await pool.query('UPDATE search_jobs SET available_at = now() WHERE id = $1', [jobA.job_id]);
      const { jobs } = (await claim(tokens.w1)).json();
      assert.equal(jobs.length, 1); assert.equal(jobs[0].attempt_no, 2);
      await pool.query("UPDATE search_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [jobA.job_id]);
      historyBeforeReplacement = { a: { scans: await historyOf(ids.profileA), posts: await postsOf(ids.profileA) }, b: { scans: await historyOf(ids.profileB), posts: await postsOf(ids.profileB) } };
      // Worker 01 becomes unavailable; admin drains it and activates Worker 02.
      await pool.query("UPDATE muse_workers SET status = 'draining' WHERE id = $1", [ids.w1]);
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json(), { wake: false }, 'a draining former worker is not eligible');
      await pool.query("UPDATE muse_workers SET status = 'active' WHERE id = $1", [ids.w2]);
      assert.equal((await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json().wake, true, 'the replacement worker can observe released or expired work');
      assert.equal((await claim(tokens.w1)).json().jobs.length, 0, 'a draining worker gets no new jobs');
      const { rows: [job] } = await pool.query('SELECT status, last_error FROM search_jobs WHERE id = $1', [jobA.job_id]);
      assert.deepEqual(job, { status: 'pending', last_error: 'lease_expired' });
    });

    await t.test('replacement worker takes future jobs; late results from the old worker are rejected', async () => {
      const { jobs } = (await claim(tokens.w2)).json();
      assert.equal(jobs.length, 1); assert.equal(jobs[0].job_id, jobA.job_id); assert.equal(jobs[0].attempt_no, 3);
      const late = await submit(tokens.w1, jobA.job_id, results(jobA, ['https://facebook.com/groups/khaitruong/posts/950']));
      assert.equal(late.json().error, 'lease_lost');
      const ok = await submit(tokens.w2, jobs[0].job_id, results(jobs[0], ['https://facebook.com/groups/khaitruong/posts/951']));
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal((await submit(tokens.w1, jobA.job_id, results(jobA, ['https://facebook.com/groups/khaitruong/posts/950']))).json().error, 'job_already_completed');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM scan_runs WHERE search_job_id = $1', [jobA.job_id])).rows[0].n, 1, 'exactly one commit per job');
      const { rows: attempts } = await pool.query('SELECT attempt_no, worker_id, outcome FROM search_job_attempts WHERE job_id = $1 ORDER BY attempt_no', [jobA.job_id]);
      assert.deepEqual(attempts.map(a => [a.attempt_no, a.worker_id, a.outcome]), [[1, ids.w1, 'failed'], [2, ids.w1, 'expired'], [3, ids.w2, 'completed']]);
    });

    await t.test('worker replacement preserves all prior customer history and ownership', async () => {
      const a = await historyOf(ids.profileA); const pa = await postsOf(ids.profileA);
      assert.deepEqual(a.slice(0, historyBeforeReplacement.a.scans.length), historyBeforeReplacement.a.scans);
      for (const post of historyBeforeReplacement.a.posts) assert.deepEqual(pa.find(p => p.id === post.id), post);
      assert.deepEqual(await historyOf(ids.profileB), historyBeforeReplacement.b.scans);
      assert.deepEqual(await postsOf(ids.profileB), historyBeforeReplacement.b.posts);
      assert.ok(pa.every(p => p.agent_connection_id === ids.profileA));
    });

    await t.test('admin release of an unavailable worker requeues its jobs without spending an attempt', async () => {
      await nextCycle();
      const { jobs } = (await claim(tokens.w2)).json();
      const b3 = jobFor(jobs, 'khách sạn sắp khai trương');
      await pool.query("UPDATE muse_workers SET status = 'unavailable' WHERE id = $1", [ids.w2]);
      const { releaseWorkerJobs } = await import('../src/jobs.js');
      const client = await pool.connect();
      try { await client.query('BEGIN'); assert.equal(await releaseWorkerJobs(client, ids.w2), 2); await client.query('COMMIT'); } finally { client.release(); }
      assert.equal((await submit(tokens.w2, b3.job_id, results(b3, ['https://facebook.com/groups/khachsan/posts/79']))).json().error, 'lease_lost');
      assert.equal((await claim(tokens.w2)).json().jobs.length, 0, 'unavailable worker cannot claim');
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json(), { wake: false }, 'paused Muse 02 receives no wake while no eligible worker is active');
      await pool.query("UPDATE muse_workers SET status = 'active' WHERE id = $1", [ids.w3]);
      const reclaimed = (await claim(tokens.w3)).json().jobs;
      assert.equal(reclaimed.length, 2);
      const { rows: [row] } = await pool.query('SELECT attempts FROM search_jobs WHERE id = $1', [b3.job_id]);
      assert.equal(row.attempts, 1, 'released attempt was refunded');
      for (const j of reclaimed) assert.equal((await submit(tokens.w3, j.job_id, results(j, []))).statusCode, 200);
    });

    await t.test('no active worker means delay, not loss: jobs stay pending', async () => {
      await nextCycle();
      await pool.query("UPDATE muse_workers SET status = 'paused' WHERE id = ANY($1::uuid[])", [[ids.w1, ids.w2, ids.w3]]);
      assert.equal((await claim(tokens.w3)).json().jobs.length, 0);
      const { rows } = await pool.query("SELECT status FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]) AND status NOT IN ('completed', 'failed')", [[ids.profileA, ids.profileB]]);
      assert.deepEqual(rows.map(r => r.status), ['pending', 'pending']);
      await pool.query("UPDATE muse_workers SET status = 'active' WHERE id = $1", [ids.w3]);
      for (const j of (await claim(tokens.w3)).json().jobs) await submit(tokens.w3, j.job_id, results(j, []));
    });

    await t.test('source authorization: unauthorized jobs are BLOCKED, then unblock once a worker is authorized', async () => {
      await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES ($1, 1, '["nhà hàng mới"]', 'Đà Nẵng', '["facebook.group:private-123"]', 30)`, [ids.profileC]);
      const { jobs } = (await claim(tokens.w3)).json();
      assert.ok(!jobs.some((j: any) => j.search.keywords.includes('nhà hàng mới')), 'an unauthorized worker never receives the job');
      for (const j of jobs) await submit(tokens.w3, j.job_id, results(j, []));
      const { rows: [c] } = await pool.query("SELECT status, last_error FROM search_jobs WHERE search_profile_id = $1 ORDER BY created_at DESC LIMIT 1", [ids.profileC]);
      assert.deepEqual(c, { status: 'blocked', last_error: 'no_authorized_worker' });
      await pool.query(`UPDATE muse_workers SET authorized_sources = '["social.search", "facebook.group:private-123"]' WHERE id = $1`, [ids.w3]);
      const after = (await claim(tokens.w3)).json().jobs;
      const jc = jobFor(after, 'nhà hàng mới');
      assert.ok(jc, 'job unblocked and claimed by the newly authorized worker');
      const r = await fail(tokens.w3, jc.job_id, { scan_id: jc.scan_id, attempt_no: jc.attempt_no, code: 'needs_reauthorization', message: 'Group access revoked' });
      assert.equal(r.json().job_status, 'needs_reauthorization');
      for (const j of after) if (j !== jc) await submit(tokens.w3, j.job_id, results(j, []));
      await nextCycle();
      const later = (await claim(tokens.w3)).json().jobs;
      assert.ok(!later.some((j: any) => j.search.keywords.includes('nhà hàng mới')), 'no new jobs pile up while reauthorization is pending');
      for (const j of later) await submit(tokens.w3, j.job_id, results(j, []));
      assert.deepEqual(await visibleUrls(ids.userC), [], 'nothing incomplete was filed under C');
    });

    await t.test('exhausted attempts end FAILED and are visible in the customer scan history', async () => {
      await nextCycle();
      const { jobs } = (await claim(tokens.w3)).json();
      const ja = jobFor(jobs, 'quán ăn sắp khai trương');
      assert.ok(ja);
      await pool.query('UPDATE search_jobs SET max_attempts = 1 WHERE id = $1', [ja.job_id]);
      assert.equal((await fail(tokens.w3, ja.job_id, { scan_id: ja.scan_id, attempt_no: ja.attempt_no, code: 'rate_limited', message: 'Provider limit reached' })).json().job_status, 'failed');
      const { rows: [run] } = await pool.query('SELECT status, errors FROM scan_runs WHERE search_job_id = $1', [ja.job_id]);
      assert.equal(run.status, 'failed'); assert.equal(run.errors[0].code, 'rate_limited');
    });

    await t.test('concurrent claims from two workers never share a job', async () => {
      for (const j of (await pool.query("SELECT id FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]) AND status = 'claimed'", [[ids.profileA, ids.profileB]])).rows) {
        await pool.query("UPDATE search_jobs SET status = 'cancelled' WHERE id = $1", [j.id]);
      }
      await nextCycle();
      await pool.query("UPDATE muse_workers SET status = 'active' WHERE id = ANY($1::uuid[])", [[ids.w1, ids.w2]]);
      const responses = await Promise.all([claim(tokens.w1), claim(tokens.w2), claim(tokens.w3)]);
      const claimed = responses.flatMap(r => r.json().jobs.map((j: any) => j.job_id));
      assert.equal(claimed.length, 2, 'both due jobs assigned exactly once across three concurrent claimers');
      assert.equal(new Set(claimed).size, 2);
    });

    await t.test('legacy Agent A/B data and endpoints are unchanged', async () => {
      assert.deepEqual(await snapshotLegacy(), legacyBefore);
      assert.ok(legacyBefore.agents.every((a: any) => a.kind === 'legacy_agent' && a.credential_hash));
    });
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ids.userA, ids.userB, ids.userC].filter(Boolean)]);
    await pool.query('DELETE FROM muse_workers WHERE id = ANY($1::uuid[])', [[ids.w1, ids.w2, ids.w3].filter(Boolean)]);
    await app.close();
    await pool.end();
  }
});
