import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { enqueueInitialJob } from '../src/jobs.js';

const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const hash = createHash('sha256').update(token).digest('hex');

test('worker claim capacity serializes concurrent polls and recovers expired and missing leases', async t => {
  try { await pool.query('SELECT 1 FROM search_jobs LIMIT 1'); }
  catch { t.skip('PostgreSQL unavailable or worker migrations missing'); await app.close(); await pool.end(); return; }

  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*) FROM agent_connections WHERE kind = 'search_profile')::int AS profiles,
    (SELECT count(*) FROM muse_workers WHERE status = 'active')::int AS workers`);
  if (existing.profiles || existing.workers) {
    t.skip('Synthetic claim tests require an isolated database without real profiles or active workers');
    await app.close(); await pool.end(); return;
  }

  let workerId = '';
  const userIds: string[] = [];
  const jobIds: string[] = [];
  try {
    workerId = (await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ($1, $2, 'active', '["social.search"]', 2, 30) RETURNING id`, [`Capacity test ${randomBytes(4).toString('hex')}`, hash])).rows[0].id;

    for (let i = 0; i < 4; i++) {
      const userId = (await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [`Capacity test customer ${i}`])).rows[0].id;
      userIds.push(userId);
      const profileId = (await pool.query(`INSERT INTO agent_connections(user_id, name, kind)
        VALUES ($1, 'Synthetic profile', 'search_profile') RETURNING id`, [userId])).rows[0].id;
      await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes)
        VALUES ($1, 1, '["synthetic test"]', '', '["social.search"]', 30)`, [profileId]);
      const client = await pool.connect();
      try { await client.query('BEGIN'); await enqueueInitialJob(client, profileId); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  async function cleanup() {
    if (workerId) {
      await pool.query('DELETE FROM search_job_attempts WHERE worker_id = $1', [workerId]).catch(() => undefined);
      await pool.query('DELETE FROM muse_workers WHERE id = $1', [workerId]).catch(() => undefined);
    }
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]).catch(() => undefined);
  }

  try {
    const jobRows = await pool.query('SELECT id FROM search_jobs WHERE search_profile_id IN (SELECT id FROM agent_connections WHERE user_id = ANY($1::uuid[])) ORDER BY created_at', [userIds]);
    jobIds.push(...jobRows.rows.map(row => row.id));
    assert.equal(jobIds.length, 4);

    const wakeEndpoint = () => app.inject({ method: 'GET', url: '/api/public/worker-wake' });
    const idleWake = (await wakeEndpoint()).json();
    assert.equal(idleWake.wake, true, 'eligible work wakes an idle worker');
    const firstClaim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1 } });
    assert.equal(firstClaim.json().jobs.length, 1);
    const oneSlotWake = (await wakeEndpoint()).json();
    assert.equal(oneSlotWake.wake, true, 'one valid lease leaves a second configured slot available');
    assert.notEqual(oneSlotWake.generation, idleWake.generation, 'capacity change creates a new wake generation for deduplication');

    const concurrent = await Promise.all([
      app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 10 } }),
      app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 10 } }),
    ]);
    assert.ok(concurrent.every(response => response.statusCode === 200));
    const assigned = concurrent.flatMap(response => response.json().jobs);
    assert.equal(assigned.length, 1, 'concurrent requests can fill only the one remaining slot');
    assert.equal(new Set([...firstClaim.json().jobs, ...assigned].map(job => job.job_id)).size, 2, 'a job is never assigned twice');

    const atCapacity = await wakeEndpoint();
    assert.deepEqual(atCapacity.json(), { wake: false }, 'two valid leases exhaust worker capacity');

    const expiringId = firstClaim.json().jobs[0].job_id;
    const missingLeaseId = assigned[0].job_id;
    await pool.query("UPDATE search_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [expiringId]);
    await pool.query('UPDATE search_jobs SET lease_expires_at = NULL WHERE id = $1', [missingLeaseId]);
    const expiredResult = await app.inject({ method: 'POST', url: `/api/worker/jobs/${expiringId}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'synthetic_test', configuration_version: firstClaim.json().jobs[0].configuration_version,
      scan_id: firstClaim.json().jobs[0].scan_id, attempt_no: firstClaim.json().jobs[0].attempt_no, scanned_at: new Date().toISOString(), keywords_used: [], sources_used: ['social.search'],
      posts: [], stats: { total_found: 0 }, errors: [],
    } });
    assert.equal(expiredResult.statusCode, 409);
    assert.equal(expiredResult.json().error, 'lease_expired', 'an expired lease cannot accept late results before a new claim recovers it');
    assert.equal((await pool.query('SELECT count(*)::int n FROM scan_runs WHERE search_job_id = $1', [expiringId])).rows[0].n, 0);
    const beforeRecovery = await app.inject({ method: 'GET', url: '/api/worker/status', headers: auth });
    assert.equal(beforeRecovery.statusCode, 200);
    assert.equal(beforeRecovery.json().claimed_jobs, 0);
    assert.equal(beforeRecovery.json().expired_claims, 2);
    const wake = await app.inject({ method: 'GET', url: '/api/public/worker-wake' });
    assert.equal(wake.json().wake, true, 'wake signal includes expired and missing lease claims');
    const recovered = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: {} });
    assert.equal(recovered.json().jobs.length, 2, 'expired leases are recovered and available capacity is refilled');
    const expiredAttempt = await pool.query("SELECT outcome FROM search_job_attempts WHERE job_id = $1 AND attempt_no = 1", [expiringId]);
    assert.equal(expiredAttempt.rows[0].outcome, 'expired');
    const nullAttempt = await pool.query("SELECT outcome FROM search_job_attempts WHERE job_id = $1 AND attempt_no = 1", [missingLeaseId]);
    assert.equal(nullAttempt.rows[0].outcome, 'expired');

    const completed = recovered.json().jobs.find((job: any) => job.job_id === expiringId);
    assert.ok(completed);
    assert.equal(completed.attempt_no, 2);
    const staleAttempt = await app.inject({ method: 'POST', url: `/api/worker/jobs/${completed.job_id}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'synthetic_test', configuration_version: completed.configuration_version,
      scan_id: completed.scan_id, attempt_no: 1, scanned_at: new Date().toISOString(), keywords_used: [], sources_used: ['social.search'],
      posts: [], stats: { total_found: 0 }, errors: [],
    } });
    assert.equal(staleAttempt.statusCode, 409);
    assert.equal(staleAttempt.json().error, 'attempt_mismatch', 'a stale result from the same worker cannot complete a re-claimed job');
    assert.equal((await pool.query('SELECT count(*)::int n FROM scan_runs WHERE search_job_id = $1', [expiringId])).rows[0].n, 0);
    const scanIdAsPath = await app.inject({ method: 'POST', url: `/api/worker/jobs/${completed.scan_id}/results`, headers: auth, payload: {} });
    assert.equal(scanIdAsPath.statusCode, 400);
    assert.equal(scanIdAsPath.json().error, 'invalid_job_id', 'a scan_id in the job_id URL position is reported as an identifier-format error');
    const unknownJob = await app.inject({ method: 'POST', url: `/api/worker/jobs/${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'synthetic_test', configuration_version: 1, scan_id: 'synthetic-unknown-job',
      scanned_at: new Date().toISOString(), keywords_used: [], sources_used: ['social.search'], posts: [], stats: { total_found: 0 }, errors: [],
    } });
    assert.equal(unknownJob.statusCode, 404);
    assert.equal(unknownJob.json().error, 'job_not_found', 'a well-formed but absent job id remains a not-found response');
    const result = await app.inject({ method: 'POST', url: `/api/worker/jobs/${completed.job_id}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'synthetic_test', configuration_version: completed.configuration_version,
      scan_id: completed.scan_id, attempt_no: completed.attempt_no, scanned_at: new Date().toISOString(), keywords_used: [], sources_used: ['social.search'],
      posts: [], stats: { total_found: 0 }, errors: [],
    } });
    assert.equal(result.statusCode, 200, result.body);
    const afterCompletion = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: {} });
    assert.equal(afterCompletion.json().jobs.length, 1, 'completion releases a capacity slot for the next queued job');
    const remaining = await pool.query("SELECT count(*)::int AS n FROM search_jobs WHERE claimed_by_worker_id = $1 AND status = 'claimed' AND lease_expires_at > now()", [workerId]);
    assert.equal(remaining.rows[0].n, 2);
  } finally {
    await cleanup();
    await app.close();
    await pool.end();
  }
});
