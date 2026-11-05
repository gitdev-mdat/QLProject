import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { enqueueInitialJob, supersedeQueuedJobs } from '../src/jobs.js';

const DATABASE = 'muse_bridge_qlead_initial_discovery_test';
const tx = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};

test('bounded initial-discovery follow-up lifecycle (isolated PostgreSQL)', async t => {
  const { rows: [db] } = await pool.query<{ database: string }>('SELECT current_database() AS database');
  if (db.database !== DATABASE) {
    t.skip(`Restricted to ${DATABASE}; current database is ${db.database}.`);
    await app.close(); await pool.end(); return;
  }
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_connections WHERE kind='search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status='active') AS workers`);
  if (existing.profiles || existing.workers) {
    t.skip('Requires the dedicated fixture database to have no search profiles or active workers.');
    await app.close(); await pool.end(); return;
  }

  const token = randomBytes(32).toString('base64url');
  const auth = { authorization: `Bearer ${token}` };
  const tokenHash = createHash('sha256').update(token).digest('hex');
  let userId = '';
  let workerId = '';
  const profileIds: string[] = [];
  const makeProfile = async (description: string) => {
    const { rows: [profile] } = await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,$2,'search_profile') RETURNING id", [userId, `Synthetic ${profileIds.length + 1}`]);
    profileIds.push(profile.id);
    await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,keywords_source,location,sources,frequency_minutes,description)
      VALUES ($1,1,true,$2,'description','','["social.search"]',30,$3)`, [profile.id, JSON.stringify(['quán ăn uống sắp khai trương', 'quán cà phê sắp khai trương', 'quán chè sắp khai trương']), description]);
    await tx(client => enqueueInitialJob(client, profile.id));
    return profile.id as string;
  };
  const claim = async (profileId: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profileId } });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json().jobs[0];
    assert.ok(job, `expected a claimed job for ${profileId}`);
    return job;
  };
  const submit = (job: any, posts: any[] = []) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
    event: 'facebook_scan_completed', source: 'muse', attempt_no: job.attempt_no, configuration_version: job.configuration_version,
    scan_id: job.scan_id, scanned_at: new Date().toISOString(), keywords_used: job.search.keywords,
    sources_used: job.search.sources, posts, stats: { total_found: posts.length }, errors: [],
  } });
  const usefulPost = (url: string) => ({ url: `https://www.facebook.com/synthetic/posts/${url}`, author: 'Synthetic Business', content: 'Sắp khai trương cửa hàng mới', published_at: new Date().toISOString(), collected_via: 'controlled_fixture' });

  try {
    userId = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic early follow-up') RETURNING id")).rows[0].id;
    workerId = (await pool.query(`INSERT INTO muse_workers(name,credential_hash,status,authorized_sources,max_jobs_per_claim,lease_minutes)
      VALUES ('Synthetic follow-up worker',$1,'active','["social.search"]',1,30) RETURNING id`, [tokenHash])).rows[0].id;

    await t.test('zero usable initial posts queue exactly one complementary follow-up; concurrent callbacks are idempotent', async () => {
      const profileId = await makeProfile('Các quán F&B sắp khai trương');
      const first = await claim(profileId);
      assert.equal(first.kind, 'initial');
      const results = await Promise.all([submit(first), submit(first)]);
      assert.ok(results.every(result => result.statusCode === 200), results.map(result => result.body).join('\n'));
      const { rows: [queued] } = await pool.query(`SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'`, [profileId]);
      assert.equal(queued.count, 1);
      const { rows: [initial] } = await pool.query('SELECT usable_new_posts FROM scan_runs WHERE search_job_id=$1', [first.job_id]);
      assert.equal(initial.usable_new_posts, 0);

      await pool.query("UPDATE search_jobs SET scheduled_for=now(), available_at=now() WHERE search_profile_id=$1 AND kind='followup'", [profileId]);
      const followup = await claim(profileId);
      assert.equal(followup.kind, 'followup');
      assert.ok(followup.search.keywords.some((phrase: string) => phrase.includes('mới thuê mặt bằng')));
      assert.ok(followup.search.keywords.every((phrase: string) => !first.search.keywords.includes(phrase)));
      const done = await submit(followup);
      assert.equal(done.statusCode, 200, done.body);
      assert.equal(done.json().usable_new_posts, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [profileId])).rows[0].count, 1,
        'a follow-up result never queues another follow-up');
    });

    await t.test('one useful post queues one follow-up, while several useful posts do not', async () => {
      const oneProfile = await makeProfile('Quán cà phê sắp khai trương');
      const oneJob = await claim(oneProfile);
      const one = await submit(oneJob, [usefulPost('one'), usefulPost('one')]);
      assert.equal(one.statusCode, 200, one.body);
      assert.equal(one.json().usable_new_posts, 1);
      assert.equal(one.json().early_followup_queued, true);

      const manyProfile = await makeProfile('Quán cà phê sắp khai trương');
      const manyJob = await claim(manyProfile);
      const several = await submit(manyJob, [usefulPost('many-a'), usefulPost('many-b')]);
      assert.equal(several.statusCode, 200, several.body);
      assert.equal(several.json().usable_new_posts, 2);
      assert.equal(several.json().early_followup_queued, false);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [manyProfile])).rows[0].count, 0);
    });

    await t.test('ten source-linked opportunities stop Early Follow-up even when source metadata is missing', async () => {
      const profileId = await makeProfile('Quán cà phê sắp khai trương');
      const job = await claim(profileId);
      const posts = Array.from({ length: 10 }, (_, index) => ({
        url: `https://www.facebook.com/synthetic/posts/url-only-${index + 1}`,
        collected_via: 'controlled_fixture',
      }));
      const response = await submit(job, posts);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().source_linked_new_posts, 10);
      assert.equal(response.json().usable_new_posts, 0, 'legacy metadata count remains available for audit');
      assert.equal(response.json().early_followup_queued, false);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [profileId])).rows[0].count, 0);
    });

    await t.test('a successful follow-up adds a lead and ends the discovery episode', async () => {
      const profileId = await makeProfile('Quán cà phê sắp khai trương');
      const initial = await claim(profileId);
      assert.equal((await submit(initial)).json().early_followup_queued, true);
      await pool.query("UPDATE search_jobs SET scheduled_for=now(),available_at=now() WHERE search_profile_id=$1 AND kind='followup'", [profileId]);
      const followup = await claim(profileId);
      const result = await submit(followup, [usefulPost('followup-success')]);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().usable_new_posts, 1);
      const { rows: [counts] } = await pool.query(`SELECT sum(usable_new_posts)::int AS total,
          sum(usable_new_posts) FILTER (WHERE search_job_id IN (SELECT id FROM search_jobs WHERE kind='initial'))::int AS initial,
          sum(usable_new_posts) FILTER (WHERE search_job_id IN (SELECT id FROM search_jobs WHERE kind='followup'))::int AS followup
        FROM scan_runs WHERE agent_connection_id=$1`, [profileId]);
      assert.deepEqual(counts, { total: 1, initial: 0, followup: 1 });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [profileId])).rows[0].count, 1);
    });

    await t.test('no relevant complementary direction and failed initial jobs do not schedule follow-ups', async () => {
      const noCoverage = await makeProfile('Quán cà phê đang tuyển nhân viên');
      const noCoverageJob = await claim(noCoverage);
      const empty = await submit(noCoverageJob);
      assert.equal(empty.statusCode, 200, empty.body);
      assert.equal(empty.json().early_followup_queued, false);

      const failedProfile = await makeProfile('Quán cà phê sắp khai trương');
      const failedJob = await claim(failedProfile);
      const failed = await app.inject({ method: 'POST', url: `/api/worker/jobs/${failedJob.job_id}/failure`, headers: auth,
        payload: { scan_id: failedJob.scan_id, attempt_no: failedJob.attempt_no, code: 'execution_error', message: 'controlled failure', retryable: false } });
      assert.equal(failed.statusCode, 200, failed.body);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [failedProfile])).rows[0].count, 0);
    });

    await t.test('a profile edit supersedes the queued follow-up and binds all jobs to their configuration versions', async () => {
      const profileId = await makeProfile('Quán cà phê sắp khai trương');
      const initial = await claim(profileId);
      assert.equal((await submit(initial)).json().early_followup_queued, true);
      await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,keywords_source,location,sources,frequency_minutes,description)
        SELECT agent_connection_id,2,enabled,keywords,keywords_source,location,sources,frequency_minutes,'Quán cà phê mới khai trương'
        FROM scan_configs WHERE agent_connection_id=$1 AND version=1`, [profileId]);
      await tx(client => supersedeQueuedJobs(client, profileId, 2));
      const { rows: [followup] } = await pool.query("SELECT status,configuration_version,last_error FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [profileId]);
      assert.deepEqual(followup, { status: 'cancelled', configuration_version: 1, last_error: 'superseded_by_edit' });
      const claimed = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profileId } });
      assert.equal(claimed.json().jobs.length, 0, 'the edited description has no implicit initial follow-up');
    });

    await t.test('paused and suspended profiles cannot run a queued follow-up', async () => {
      const pausedProfile = await makeProfile('Quán cà phê sắp khai trương');
      const pausedInitial = await claim(pausedProfile);
      assert.equal((await submit(pausedInitial)).json().early_followup_queued, true);
      await pool.query("UPDATE scan_configs SET enabled=false WHERE agent_connection_id=$1 AND version=1", [pausedProfile]);
      await pool.query("UPDATE search_jobs SET status='cancelled',last_error='paused_by_customer',completed_at=now() WHERE search_profile_id=$1 AND kind='followup' AND status='pending'", [pausedProfile]);
      const paused = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: pausedProfile } });
      assert.equal(paused.json().jobs.length, 0);

      const suspendedProfile = await makeProfile('Quán cà phê sắp khai trương');
      const suspendedInitial = await claim(suspendedProfile);
      assert.equal((await submit(suspendedInitial)).json().early_followup_queued, true);
      await pool.query("UPDATE search_jobs SET scheduled_for=now(),available_at=now() WHERE search_profile_id=$1 AND kind='followup'", [suspendedProfile]);
      await pool.query("UPDATE users SET lead_monitoring_status='suspended' WHERE id=$1", [userId]);
      const suspended = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: suspendedProfile } });
      assert.equal(suspended.json().jobs.length, 0);
      assert.equal((await pool.query("SELECT status FROM search_jobs WHERE search_profile_id=$1 AND kind='followup'", [suspendedProfile])).rows[0].status, 'pending',
        'suspension retains queued work without making it eligible');
      await pool.query("UPDATE users SET lead_monitoring_status='active' WHERE id=$1", [userId]);
    });

    await t.test('worker capacity stays bounded and an expired lease is safely reclaimed', async () => {
      const firstProfile = await makeProfile('Quán cà phê sắp khai trương');
      const first = await claim(firstProfile);
      const secondProfile = await makeProfile('Quán chè sắp khai trương');
      const full = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: secondProfile } });
      assert.equal(full.json().jobs.length, 0, 'one worker lease occupies its configured capacity');

      await pool.query('UPDATE search_jobs SET lease_expires_at=now()-interval \'1 second\' WHERE id=$1', [first.job_id]);
      const reclaimed = await claim(firstProfile);
      assert.equal(reclaimed.job_id, first.job_id);
      assert.equal(reclaimed.attempt_no, first.attempt_no + 1);
      const result = await submit(reclaimed);
      assert.equal(result.statusCode, 200, result.body);
      const second = await claim(secondProfile);
      assert.equal(second.kind, 'initial', 'other first-time work proceeds after the lease is released');
      await submit(second);
    });

    await t.test('new initial work precedes a follow-up; old recurring work regains priority after its bounded boost', async () => {
      const sparseProfile = await makeProfile('Quán cà phê sắp khai trương');
      const sparseInitial = await claim(sparseProfile);
      assert.equal((await submit(sparseInitial)).json().early_followup_queued, true);
      await pool.query("UPDATE search_jobs SET scheduled_for=now(),available_at=now() WHERE search_profile_id=$1 AND kind='followup'", [sparseProfile]);

      const newProfile = await makeProfile('Quán chè sắp khai trương');
      const newInitial = await claim(newProfile);
      assert.equal(newInitial.kind, 'initial', 'a first-time request outranks an early follow-up');
      await submit(newInitial);

      const oldProfile = await makeProfile('Quán cà phê đang tuyển nhân viên');
      await pool.query("UPDATE search_jobs SET status='cancelled',completed_at=now(),last_error='fixture_replaced' WHERE search_profile_id=$1 AND kind='initial'", [oldProfile]);
      await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources,kind)
        VALUES ($1,1,'synthetic-old-recurring',now()-interval '60 minutes','["social.search"]','scheduled')`, [oldProfile]);
      const recurring = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1 } });
      assert.equal(recurring.statusCode, 200, recurring.body);
      assert.equal(recurring.json().jobs[0]?.kind, 'scheduled', 'old routine work overtakes the five-minute follow-up boost');
      await submit(recurring.json().jobs[0]);
    });
  } finally {
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id=$1', [workerId]);
    await app.close(); await pool.end();
  }
});
