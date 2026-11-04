import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';

const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const hash = createHash('sha256').update(token).digest('hex');

test('three due recurring profiles advance one wake generation per one-job claim (isolated DB)', async t => {
  const { rows: [db] } = await pool.query<{ database: string }>('SELECT current_database() AS database');
  if (db.database !== 'muse_bridge_wake_test') {
    t.skip('This regression test is restricted to muse_bridge_wake_test.');
    await app.close(); await pool.end(); return;
  }
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_connections WHERE kind = 'search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS active_workers`);
  if (existing.profiles !== 0 || existing.active_workers !== 0) {
    t.skip('Requires the isolated wake-test database to have no profiles or active workers.');
    await app.close(); await pool.end(); return;
  }

  const baseline = await pool.query(`SELECT count(*)::int AS scans, md5(coalesce(string_agg(to_jsonb(x)::text, '' ORDER BY x.id), '')) AS scan_hash FROM scan_runs x`);
  const postBaseline = await pool.query(`SELECT count(*)::int AS posts, md5(coalesce(string_agg(to_jsonb(x)::text, '' ORDER BY x.id), '')) AS post_hash FROM facebook_posts x`);
  let userId = '';
  let workerId = '';
  let profileIds: string[] = [];
  const endpoint = () => app.inject({ method: 'GET', url: '/api/public/worker-wake' });
  const wake = async () => (await endpoint()).json() as { wake: boolean; generation?: string };
  const claimOne = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1 } });
    assert.equal(response.statusCode, 200, response.body);
    const jobs = response.json().jobs;
    assert.equal(jobs.length, 1, 'one worker cycle claims exactly one job');
    return jobs[0];
  };
  const complete = async (job: any) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version,
    scan_id: job.scan_id, scanned_at: new Date().toISOString(), keywords_used: job.search.keywords,
    sources_used: job.search.sources, posts: [], stats: { total_found: 0 }, errors: [],
  } });

  try {
    const { rows: [user] } = await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic recurring progression') RETURNING id");
    userId = user.id;
    const { rows: [worker] } = await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ('Synthetic Recurring Worker', $1, 'active', '["social.search"]', 1, 45) RETURNING id`, [hash]);
    workerId = worker.id;

    for (const name of ['Recurring A', 'Recurring B', 'Recurring C']) {
      const { rows: [profile] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
      profileIds.push(profile.id);
      await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes)
        VALUES ($1, 1, true, '["synthetic recurring search"]', '', '["social.search"]', 10080)`, [profile.id]);
    }

    const firstSignal = await wake();
    assert.equal(firstSignal.wake, true, 'all three due profiles are eligible before job insertion');
    assert.ok(firstSignal.generation);
    assert.deepEqual(await wake(), firstSignal, 'all three due profiles produce a stable first generation');
    const generations: string[] = [];
    for (let index = 0; index < 3; index++) {
      const job = await claimOne();
      assert.ok(profileIds.includes((await pool.query('SELECT search_profile_id FROM search_jobs WHERE id = $1', [job.job_id])).rows[0].search_profile_id));
      assert.deepEqual(await wake(), { wake: false }, 'a live lease suppresses further wakes while execution is active');
      const response = await complete(job);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await pool.query('SELECT status FROM search_jobs WHERE id = $1', [job.job_id])).rows[0].status, 'completed');
      const signal = await wake();
      if (index < 2) {
        assert.equal(signal.wake, true, 'unclaimed due recurring profiles remain eligible after completion');
        assert.ok(signal.generation);
        generations.push(signal.generation!);
        assert.deepEqual(await wake(), signal, 'unchanged remaining work does not duplicate its generation');
      } else {
        assert.deepEqual(signal, { wake: false }, 'all profiles completed for this slot leaves no wake');
      }
    }
    assert.notEqual(generations[0], generations[1], 'completing one profile creates a distinct generation for the remaining set');
    const { rows: [counts] } = await pool.query(`SELECT count(*)::int AS jobs,
      count(*) FILTER (WHERE status = 'completed')::int AS completed,
      count(DISTINCT search_profile_id)::int AS profiles
      FROM search_jobs WHERE search_profile_id = ANY($1::uuid[])`, [profileIds]);
    assert.deepEqual(counts, { jobs: 3, completed: 3, profiles: 3 });
  } finally {
    if (profileIds.length) await pool.query('DELETE FROM search_job_attempts WHERE job_id IN (SELECT id FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]))', [profileIds]);
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id = $1', [workerId]);
    const after = await pool.query(`SELECT count(*)::int AS scans, md5(coalesce(string_agg(to_jsonb(x)::text, '' ORDER BY x.id), '')) AS scan_hash FROM scan_runs x`);
    const postsAfter = await pool.query(`SELECT count(*)::int AS posts, md5(coalesce(string_agg(to_jsonb(x)::text, '' ORDER BY x.id), '')) AS post_hash FROM facebook_posts x`);
    assert.deepEqual(after.rows, baseline.rows, 'test preserves scan history');
    assert.deepEqual(postsAfter.rows, postBaseline.rows, 'test preserves lead/post history');
    await app.close(); await pool.end();
  }
});
