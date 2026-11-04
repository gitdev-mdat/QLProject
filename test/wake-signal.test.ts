import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { enqueueInitialJob } from '../src/jobs.js';

const token01 = randomBytes(32).toString('base64url');
const token02 = randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test('public wake signal lifecycle and bounded recovery (isolated synthetic DB)', async t => {
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_connections WHERE kind = 'search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS active_workers`);
  if (existing.profiles !== 0 || existing.active_workers !== 0) {
    t.skip('Requires an isolated DB with no search profiles or active workers.');
    await app.close(); await pool.end(); return;
  }

  const dataFingerprint = async (table: 'scan_runs' | 'facebook_posts') => {
    const { rows: [row] } = await pool.query(`SELECT count(*)::int AS n,
      md5(coalesce(string_agg(to_jsonb(x)::text, '' ORDER BY x.id), '')) AS digest FROM ${table} x`);
    return row;
  };
  const baseline = { scans: await dataFingerprint('scan_runs'), posts: await dataFingerprint('facebook_posts') };
  const created: { user: string; profiles: string[]; workers: string[] } = { user: '', profiles: [], workers: [] };
  let firstGeneration = '';

  try {
    const { rows: [user] } = await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic wake signal test') RETURNING id");
    created.user = user.id;
    for (const [index, name] of ['Wake A', 'Wake B', 'Wake C', 'Wake D', 'Wake E'].entries()) {
      const { rows: [profile] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [created.user, name]);
      created.profiles.push(profile.id);
      await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes)
        VALUES ($1, 1, $2, $3::jsonb, 'Synthetic location', '["social.search"]', 10080)`, [profile.id, false, JSON.stringify([`synthetic-${index}`])]);
    }
    const { rows: [w1] } = await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ('Synthetic Wake Worker 01', $1, 'active', '["social.search"]', 1, 45) RETURNING id`, [hash(token01)]);
    created.workers.push(w1.id);
    const { rows: [w2] } = await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ('Synthetic Wake Worker 02', $1, 'paused', '["social.search"]', 1, 45) RETURNING id`, [hash(token02)]);
    created.workers.push(w2.id);

    const endpoint = () => app.inject({ method: 'GET', url: '/api/public/worker-wake' });
    const enableInitial = async (profileId: string) => {
      await pool.query('UPDATE scan_configs SET enabled = true, updated_at = now() WHERE agent_connection_id = $1', [profileId]);
      const client = await pool.connect();
      try { await client.query('BEGIN'); assert.equal(await enqueueInitialJob(client, profileId), true); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const complete = async (workerToken: string, job: any) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth(workerToken), payload: {
      event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id,
      scanned_at: new Date().toISOString(), keywords_used: job.search.keywords, sources_used: job.search.sources,
      posts: [], stats: { total_found: 0 }, errors: [] } });

    await t.test('empty disabled queue stays quiet; eligible initial work signals once per generation', async () => {
      assert.deepEqual((await endpoint()).json(), { wake: false });
      await enableInitial(created.profiles[0]!);
      const first = await endpoint();
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().wake, true);
      firstGeneration = first.json().generation;
      const repeated = await endpoint();
      assert.deepEqual(repeated.json(), first.json(), 'unchanged state and recovery phase are stable');
      assert.match(first.headers['cache-control'] ?? '', /no-store/);
      assert.deepEqual(Object.keys(first.json()).sort(), ['generation', 'wake']);
      assert.match(first.json().generation, /^[a-f0-9]{64}$/);
      for (const secret of [created.user, ...created.profiles, ...created.workers, 'Synthetic Wake Worker', 'synthetic-0', 'Synthetic location']) {
        assert.ok(!first.body.includes(secret), `public response contains fixture value ${secret}`);
      }
    });

    let completedJob: any;
    await t.test('claim suppresses wake during the lease; completion clears that job state', async () => {
      const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(token01), payload: { max_jobs: 1 } });
      assert.equal(claim.statusCode, 200, claim.body);
      assert.equal(claim.json().jobs.length, 1);
      completedJob = claim.json().jobs[0];
      assert.deepEqual((await endpoint()).json(), { wake: false });
      const result = await complete(token01, completedJob);
      assert.equal(result.statusCode, 200, result.body);
      const { rows: [job] } = await pool.query('SELECT status FROM search_jobs WHERE id = $1', [completedJob.job_id]);
      assert.equal(job.status, 'completed');
      assert.deepEqual((await endpoint()).json(), { wake: false });
    });

    await t.test('a new eligible job after completion gets a distinguishable event generation', async () => {
      await enableInitial(created.profiles[1]!);
      const next = await endpoint();
      assert.equal(next.json().wake, true);
      assert.notEqual(next.json().generation, firstGeneration, 'new work after the completed event has a new marker');
    });

    await t.test('unclaimed work produces at most two delayed recovery generations then remains quiet', async () => {
      // Remove the previous synthetic pending job so this phase tests exactly one unchanged job.
      await pool.query('UPDATE scan_configs SET enabled = false WHERE agent_connection_id = $1', [created.profiles[1]]);
      await pool.query("UPDATE search_jobs SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE search_profile_id = $1 AND status = 'pending'", [created.profiles[1]]);
      await enableInitial(created.profiles[2]!);
      const initial = (await endpoint()).json();
      assert.equal(initial.wake, true);
      const job = (await pool.query("SELECT id FROM search_jobs WHERE search_profile_id = $1 AND status = 'pending'", [created.profiles[2]])).rows[0];
      await pool.query("UPDATE muse_workers SET last_success_at = now() - interval '6 minutes' WHERE id = $1", [created.workers[0]]);
      await pool.query("UPDATE search_jobs SET created_at = now() - interval '6 minutes', updated_at = now() - interval '6 minutes', available_at = now() - interval '6 minutes', scheduled_for = now() - interval '6 minutes' WHERE id = $1", [job.id]);
      const recovery1 = (await endpoint()).json();
      assert.equal(recovery1.wake, true);
      assert.notEqual(recovery1.generation, initial.generation);
      assert.deepEqual((await endpoint()).json(), recovery1, 'same recovery phase does not duplicate-wake');
      await pool.query("UPDATE muse_workers SET last_success_at = now() WHERE id = $1", [created.workers[0]]);
      assert.deepEqual((await endpoint()).json(), recovery1, 'unrelated successful work does not reset this pending item recovery phase');
      await pool.query("UPDATE search_jobs SET created_at = now() - interval '16 minutes', updated_at = now() - interval '16 minutes', available_at = now() - interval '16 minutes', scheduled_for = now() - interval '16 minutes' WHERE id = $1", [job.id]);
      const recovery2 = (await endpoint()).json();
      assert.equal(recovery2.wake, true);
      assert.notEqual(recovery2.generation, recovery1.generation);
      assert.deepEqual((await endpoint()).json(), recovery2, 'the final recovery phase is stable; no further automatic wake loop');
      const { rows: [pending] } = await pool.query('SELECT status FROM search_jobs WHERE id = $1', [job.id]);
      assert.equal(pending.status, 'pending', 'unclaimed work remains available for operator recovery');
      await enableInitial(created.profiles[3]!);
      const afterExhaustion = (await endpoint()).json();
      assert.equal(afterExhaustion.wake, true, 'genuinely new work can wake after the prior event exhausted recovery');
      assert.notEqual(afterExhaustion.generation, recovery2.generation);
      assert.deepEqual((await endpoint()).json(), afterExhaustion, 'new work generation is stable under repeated observations');
    });

    await t.test('retry backoff is quiet until available_at; paused and handoff eligibility is enforced', async () => {
      await pool.query('UPDATE scan_configs SET enabled = false WHERE agent_connection_id = $1', [created.profiles[2]]);
      await pool.query("UPDATE search_jobs SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE search_profile_id = $1 AND status = 'pending'", [created.profiles[2]]);
      await pool.query('UPDATE scan_configs SET enabled = false WHERE agent_connection_id = $1', [created.profiles[3]]);
      await pool.query("UPDATE search_jobs SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE search_profile_id = $1 AND status = 'pending'", [created.profiles[3]]);
      await enableInitial(created.profiles[3]!);
      let claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(token01), payload: { max_jobs: 1 } });
      let job = claim.json().jobs[0];
      const failed = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/failure`, headers: auth(token01), payload: { scan_id: job.scan_id, code: 'execution_error', retryable: true } });
      assert.equal(failed.json().job_status, 'pending');
      assert.deepEqual((await endpoint()).json(), { wake: false }, 'backoff must not trigger early retry wakeups');
      await pool.query("UPDATE search_jobs SET available_at = now() - interval '1 second', updated_at = now() - interval '1 second' WHERE id = $1", [job.job_id]);
      const retryEligible = (await endpoint()).json();
      assert.equal(retryEligible.wake, true, 'retry becomes wakeable after backoff expires');
      assert.deepEqual((await endpoint()).json(), retryEligible, 'eligible retry does not wake repeatedly for its unchanged generation');
      await pool.query("UPDATE muse_workers SET status_changed_at = now() - interval '6 minutes' WHERE id = $1", [created.workers[0]]);
      await pool.query("UPDATE search_jobs SET scheduled_for = now() - interval '6 minutes', available_at = now() - interval '6 minutes', updated_at = now() - interval '6 minutes' WHERE id = $1", [job.job_id]);
      const retryRecovery1 = (await endpoint()).json();
      assert.equal(retryRecovery1.wake, true);
      assert.notEqual(retryRecovery1.generation, retryEligible.generation, 'unclaimed retry gets its first bounded recovery generation');
      await pool.query("UPDATE muse_workers SET status_changed_at = now() - interval '16 minutes' WHERE id = $1", [created.workers[0]]);
      await pool.query("UPDATE search_jobs SET scheduled_for = now() - interval '16 minutes', available_at = now() - interval '16 minutes', updated_at = now() - interval '16 minutes' WHERE id = $1", [job.job_id]);
      const retryRecovery2 = (await endpoint()).json();
      assert.equal(retryRecovery2.wake, true);
      assert.notEqual(retryRecovery2.generation, retryRecovery1.generation, 'retry recovery exhausts at the final marker');
      assert.deepEqual((await endpoint()).json(), retryRecovery2, 'exhausted retry recovery remains quiet');

      await pool.query('UPDATE scan_configs SET enabled = false WHERE agent_connection_id = $1', [created.profiles[3]]);
      await pool.query("UPDATE search_jobs SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE search_profile_id = $1 AND status = 'pending'", [created.profiles[3]]);
      await pool.query("UPDATE muse_workers SET status = 'paused', status_changed_at = now() WHERE id = $1", [created.workers[0]]);
      await pool.query('UPDATE scan_configs SET enabled = true WHERE agent_connection_id = $1', [created.profiles[1]]);
      {
        const client = await pool.connect();
        try { await client.query('BEGIN'); assert.equal(await enqueueInitialJob(client, created.profiles[1]!), true); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      }
      await pool.query('UPDATE scan_configs SET enabled = true, updated_at = now() WHERE agent_connection_id = $1', [created.profiles[4]]);
      assert.deepEqual((await endpoint()).json(), { wake: false }, 'paused sole worker produces inert signal');
      await pool.query("UPDATE muse_workers SET status = 'active', status_changed_at = now() WHERE id = $1", [created.workers[0]]);
      assert.equal((await endpoint()).json().wake, true);
      const sourceGeneration = (await endpoint()).json().generation;
      await pool.query("UPDATE muse_workers SET status = 'draining', status_changed_at = now() WHERE id = $1", [created.workers[0]]);
      assert.deepEqual((await endpoint()).json(), { wake: false }, 'no active worker during handoff is inert');
      await pool.query("UPDATE muse_workers SET status = 'active', status_changed_at = now() WHERE id = $1", [created.workers[1]]);
      const destinationWake = (await endpoint()).json();
      assert.equal(destinationWake.wake, true, 'destination worker becomes eligible at handoff cutover');
      assert.notEqual(destinationWake.generation, sourceGeneration, 'handoff produces a destination-specific wake marker');
      claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(token02), payload: { max_jobs: 1, search_profile_id: created.profiles[4] } });
      assert.equal(claim.json().jobs.length, 1, 'only active destination claims the synthetic job');
      job = claim.json().jobs[0];
      assert.equal(job.search.location, 'Synthetic location');
      const { rows: [targetJob] } = await pool.query('SELECT kind, status FROM search_jobs WHERE id = $1', [job.job_id]);
      assert.deepEqual(targetJob, { kind: 'initial', status: 'claimed' }, 'scoped first claim repairs and takes only the selected initial job');
      const { rows: [other] } = await pool.query("SELECT status, attempts FROM search_jobs WHERE search_profile_id = $1 AND status <> 'cancelled'", [created.profiles[1]]);
      assert.deepEqual(other, { status: 'pending', attempts: 0 }, 'profile-scoped claim leaves another eligible profile untouched');
      assert.equal((await complete(token02, job)).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(token01), payload: { max_jobs: 1, search_profile_id: created.profiles[4] } })).json().jobs.length, 0, 'old draining worker claims no work');
    });
  } finally {
    if (created.profiles.length) {
      await pool.query('DELETE FROM search_job_attempts WHERE job_id IN (SELECT id FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]))', [created.profiles]);
      await pool.query('DELETE FROM users WHERE id = $1', [created.user]);
    }
    if (created.workers.length) await pool.query('DELETE FROM muse_workers WHERE id = ANY($1::uuid[])', [created.workers]);
    assert.deepEqual({ scans: await dataFingerprint('scan_runs'), posts: await dataFingerprint('facebook_posts') }, baseline, 'synthetic tests leave existing scan and lead history unchanged');
    await app.close(); await pool.end();
  }

});
