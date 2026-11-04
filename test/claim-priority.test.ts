import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';

test('initial/manual jobs get a bounded head start; overdue recurring work is not starved', async t => {
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_connections WHERE kind = 'search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS workers`);
  if (existing.profiles || existing.workers) {
    t.skip('Requires the isolated database with no search profiles or active workers.');
    await app.close(); await pool.end(); return;
  }

  const token = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token).digest('hex');
  let userId = '';
  let workerId = '';
  const profileIds: string[] = [];
  const auth = { authorization: `Bearer ${token}` };

  try {
    userId = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic claim priority') RETURNING id")).rows[0].id;
    for (const name of ['Synthetic manual', 'Synthetic recurring']) {
      profileIds.push((await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,$2,'search_profile') RETURNING id", [userId, name])).rows[0].id);
    }
    await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes,description)
      VALUES ($1,1,true,'["manual-priority"]','', '["social.search"]',30,'manual fixture'),
             ($2,1,true,'["recurring-priority"]','', '["social.search"]',30,'recurring fixture')`, profileIds);
    workerId = (await pool.query(`INSERT INTO muse_workers(name,credential_hash,status,authorized_sources,max_jobs_per_claim,lease_minutes)
      VALUES ('Synthetic priority worker',$1,'active','["social.search"]',1,30) RETURNING id`, [digest])).rows[0].id;

    const oldRecurringId = (await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources,kind)
      VALUES ($1,1,'job-old-recurring',now()-interval '60 minutes','["social.search"]','scheduled') RETURNING id`, [profileIds[1]])).rows[0].id;
    await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources,kind,requested_by_user_id)
      VALUES ($1,1,'job-fresh-manual',now(),'["social.search"]','manual',$2)`, [profileIds[0], userId]);

    const first = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1 } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().jobs[0]?.search.keywords[0], 'recurring-priority', 'a recurring job overdue by over the 30-minute boost goes first');
    assert.equal(first.json().jobs[0]?.job_id, oldRecurringId);
    const oldJob = first.json().jobs[0];
    const accepted = await app.inject({ method: 'POST', url: `/api/worker/jobs/${oldJob.job_id}/results`, headers: auth, payload: {
      event: 'facebook_scan_completed', source: 'muse', configuration_version: oldJob.configuration_version, scan_id: oldJob.scan_id,
      scanned_at: new Date().toISOString(), keywords_used: oldJob.search.keywords, sources_used: oldJob.search.sources,
      posts: [], stats: { total_found: 0 }, errors: [],
    } });
    assert.equal(accepted.statusCode, 200, accepted.body);

    const second = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1 } });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().jobs[0]?.search.keywords[0], 'manual-priority', 'a fresh manual rescan gets its bounded head start over a new recurring slot');
  } finally {
    if (userId) {
      await pool.query('DELETE FROM search_job_attempts WHERE job_id IN (SELECT id FROM search_jobs WHERE search_profile_id = ANY($1::uuid[]))', [profileIds]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id = $1', [workerId]);
    await app.close(); await pool.end();
  }
});
