import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { enqueueDueJobs, enqueueInitialJob, requestManualJob } from '../src/jobs.js';
import { setLeadMonitoringStatus } from '../src/account-monitoring.js';

const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('account monitoring suspension blocks new work and retains valid in-flight work (isolated synthetic DB)', async t => {
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_connections WHERE kind = 'search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS active_workers`);
  if (existing.profiles !== 0 || existing.active_workers !== 0) {
    t.skip('Requires a dedicated isolated database with no profiles or active workers.');
    await app.close(); await pool.end(); return;
  }

  let workerId = '';
  let userA = '';
  let userB = '';
  const profileIds: string[] = [];
  const bProfiles: string[] = [];
  try {
    userA = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic suspended account') RETURNING id")).rows[0].id;
    userB = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic active account') RETURNING id")).rows[0].id;
    assert.equal((await pool.query('SELECT lead_monitoring_status FROM users WHERE id = $1', [userA])).rows[0].lead_monitoring_status, 'active');
    const addProfile = async (owner: string, name: string, enabled: boolean) => {
      const id = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [owner, name])).rows[0].id as string;
      await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
        VALUES ($1, 1, $2, '["synthetic test"]', 'manual', '', '["social.search"]', 10080, 'synthetic monitoring test')`, [id, enabled]);
      return id;
    };
    profileIds.push(await addProfile(userA, 'Synthetic A1', true));
    profileIds.push(await addProfile(userA, 'Synthetic A2', true));
    profileIds.push(await addProfile(userA, 'Synthetic A3 paused', false));
    await tx(async client => {
      assert.equal(await enqueueInitialJob(client, profileIds[0]!), true);
      assert.equal(await enqueueInitialJob(client, profileIds[1]!), true);
      assert.equal(await enqueueInitialJob(client, profileIds[2]!), false);
    });
    await pool.query('UPDATE search_jobs SET attempts = 1, available_at = now() + interval \'1 hour\' WHERE search_profile_id = $1', [profileIds[1]]);
    workerId = (await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ('Synthetic account-monitoring worker', $1, 'active', '["social.search"]', 1, 30) RETURNING id`, [hash(token)])).rows[0].id;

    const claim = async (profile?: string) => app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth,
      payload: { max_jobs: 1, ...(profile ? { search_profile_id: profile } : {}) } });
    const wake = async () => app.inject({ method: 'GET', url: '/api/public/worker-wake' });

    await t.test('valid job claimed before suspension can finish; pending work is retained but not eligible', async () => {
      const claimed = await claim(profileIds[0]);
      assert.equal(claimed.statusCode, 200);
      assert.equal(claimed.json().jobs.length, 1);
      const job = claimed.json().jobs[0];
      const suspended = await tx(client => setLeadMonitoringStatus(client, userA, userB, { status: 'suspended', reason: 'synthetic test' }));
      assert.equal(suspended?.changed, true);
      assert.equal(suspended?.status, 'suspended');
      assert.equal(suspended?.inFlightJobCount, 1);
      assert.equal((await claim(profileIds[1])).json().jobs.length, 0, 'suspended pending work cannot be claimed');
      const manual = await tx(client => requestManualJob(client, profileIds[1]!, userA));
      assert.deepEqual(manual, { outcome: 'suspended' });
      assert.equal(await tx(client => enqueueDueJobs(client)), 0);
      const before = await pool.query("SELECT id, status FROM search_jobs WHERE search_profile_id = $1 ORDER BY id", [profileIds[1]]);
      assert.equal(before.rows.length, 1);
      assert.equal(before.rows[0].status, 'pending');
      const backoffClaim = await claim(profileIds[1]);
      assert.equal(backoffClaim.json().jobs.length, 0, 'a suspended retry remains unavailable during backoff');

      const result = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
        event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id,
        scanned_at: new Date().toISOString(), keywords_used: job.search.keywords, sources_used: job.search.sources,
        posts: [], stats: { total_found: 0 }, errors: [],
      } });
      assert.equal(result.statusCode, 200, result.body);
      const stored = await pool.query('SELECT j.status, r.status AS run_status FROM search_jobs j LEFT JOIN scan_runs r ON r.search_job_id = j.id WHERE j.id = $1', [job.job_id]);
      assert.equal(stored.rows[0].status, 'completed');
      assert.equal(stored.rows[0].run_status, 'success');
      assert.deepEqual((await wake()).json(), { wake: false }, 'suspended-only pending work does not wake after the prior lease finishes');
    });

    await t.test('another active account still receives work; reactivation preserves profile pause and pending rows', async () => {
      bProfiles.push(await addProfile(userB, 'Synthetic B', true));
      await tx(client => enqueueInitialJob(client, bProfiles[0]!));
      const signal = await wake();
      assert.equal(signal.statusCode, 200);
      assert.equal(signal.json().wake, true);
      const job = (await claim()).json().jobs[0];
      assert.ok(job);
      const owner = await pool.query('SELECT ac.user_id FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE j.id = $1', [job.job_id]);
      assert.equal(owner.rows[0].user_id, userB, 'only active tenant work was assigned');
      const bResult = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
        event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id,
        scanned_at: new Date().toISOString(), keywords_used: job.search.keywords, sources_used: job.search.sources,
        posts: [], stats: { total_found: 0 }, errors: [],
      } });
      assert.equal(bResult.statusCode, 200, bResult.body);

      const resumed = await tx(client => setLeadMonitoringStatus(client, userA, userB, { status: 'active' }));
      assert.equal(resumed?.changed, true);
      assert.equal(resumed?.status, 'active');
      const repeat = await tx(client => setLeadMonitoringStatus(client, userA, userB, { status: 'active' }));
      assert.equal(repeat?.changed, false, 'repeated activation has no side effect');
      const paused = await pool.query('SELECT enabled FROM scan_configs WHERE agent_connection_id = $1', [profileIds[2]]);
      assert.equal(paused.rows[0].enabled, false);
      const jobsBefore = await pool.query('SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id = ANY($1::uuid[])', [profileIds]);
      await tx(async client => {
        await enqueueDueJobs(client);
        assert.equal(await enqueueInitialJob(client, profileIds[1]!), false);
      });
      const jobsAfter = await pool.query('SELECT count(*)::int AS count FROM search_jobs WHERE search_profile_id = ANY($1::uuid[])', [profileIds]);
      assert.equal(jobsAfter.rows[0].count, jobsBefore.rows[0].count, 'reactivation did not duplicate retained work or create a catch-up storm');
      assert.equal((await claim(profileIds[1])).json().jobs.length, 0, 'reactivation still respects the retry backoff');
      await pool.query('UPDATE search_jobs SET available_at = now() WHERE search_profile_id = $1', [profileIds[1]]);
      const resumedClaim = await claim(profileIds[1]);
      assert.equal(resumedClaim.json().jobs.length, 1, 'retained eligible work is claimable after reactivation');
    });
  } finally {
    await app.close();
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userA, userB].filter(Boolean)]);
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id = $1', [workerId]);
    await pool.end();
  }
});
