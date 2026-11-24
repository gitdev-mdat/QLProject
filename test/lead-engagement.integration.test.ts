import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { enqueueDueJobs, requestManualJob } from '../src/jobs.js';
import { getLeadEngagementProgress, recordLeadReview } from '../src/lead-engagement.js';
import { distributeProfileLeads } from '../src/lead-distribution.js';

test('isolated PostgreSQL enforces profile cohorts, third-scan holding, review unlocks and cycle idempotency', async t => {
  const url = process.env.DATABASE_URL;
  if (!url) { t.skip('Requires the isolated loopback lead_engagement_codex_test PostgreSQL database.'); return; }
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const client = await pool.connect().catch(() => null);
  if (!client) { t.skip('PostgreSQL is unavailable; requires the isolated lead_engagement_codex_test database.'); await pool.end(); return; }
  const { rows: [database] } = await client.query<{ name: string }>('SELECT current_database() AS name');
  const host = new URL(url).hostname;
  if (database.name !== 'lead_engagement_codex_test' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    client.release(); await pool.end(); t.skip('Refusing to write outside the dedicated loopback engagement test database.'); return;
  }

  const tx = async <T>(work: (connection: pg.PoolClient) => Promise<T>): Promise<T> => {
    await client.query('BEGIN');
    try { const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  let userId: string | undefined;
  let profileId: string | undefined;
  try {
    const { rows: [user] } = await client.query<{ id: string }>(`INSERT INTO users(display_name) VALUES ('Engagement gate integration fixture') RETURNING id`);
    userId = user.id;
    const { rows: [profile] } = await client.query<{ id: string }>(`INSERT INTO agent_connections(user_id,name,kind,credential_hash)
      VALUES ($1,'Engagement fixture','search_profile',NULL) RETURNING id`, [userId]);
    profileId = profile.id;
    await client.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes,description)
      VALUES ($1,1,true,'["quán cà phê sắp khai trương"]','TP.HCM','["social.search"]',30,'Quán cà phê sắp khai trương')`, [profileId]);

    const { rows: [activation] } = await client.query<{ policy_activated_at: Date }>(
      'SELECT policy_activated_at FROM lead_distribution_settings WHERE search_profile_id=$1', [profileId]);
    assert.ok(activation.policy_activated_at, 'a new profile receives its activation baseline on creation');

    const urls: string[] = [];
    for (let i = 0; i < 56; i++) {
      const url = `https://facebook.com/groups/engagement-fixture/posts/${i + 1}`; urls.push(url);
      await client.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,title,content,author,published_at,collected_via)
        VALUES ($1,$2,$2,$3,'Quán cà phê sắp khai trương, đang cần tìm nhà cung cấp.','Business page',now()-interval '1 day','qlead_shared_worker')`,
      [profileId, url, `Opportunity ${i + 1}`]);
      await client.query(`INSERT INTO facebook_post_search_configs(agent_connection_id,normalized_url,configuration_version) VALUES ($1,$2,1)`, [profileId, url]);
    }

    async function completeScan(kind: 'initial' | 'manual' | 'scheduled', ordinal: number): Promise<string> {
      const { rows: [job] } = await client.query<{ id: string }>(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources,kind,status,completed_at)
        VALUES ($1,1,$2,now()+make_interval(mins=>$3),'["social.search"]',$4,'completed',now()) RETURNING id`,
      [profileId, `engagement-scan-${ordinal}`, ordinal, kind]);
      await client.query(`INSERT INTO scan_runs(agent_connection_id,external_scan_id,configuration_version,scanned_at,total_found,received_posts,new_posts,duplicates_skipped,status,search_job_id)
        VALUES ($1,$2,1,now(),56,0,0,0,'success',$3)`, [profileId, `engagement-scan-${ordinal}`, job.id]);
      return job.id;
    }

    async function distributeScan(ordinal: number) {
      const jobId = await completeScan(ordinal === 1 ? 'initial' : 'scheduled', ordinal);
      return tx(connection => distributeProfileLeads(connection, userId!, profileId!, `scan:${jobId}`));
    }

    const historical = urls[0]!;
    const { rows: [historicPost] } = await client.query<{ id: string }>('SELECT id FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url=$2', [profileId, historical]);
    await client.query(`INSERT INTO profile_lead_deliveries(search_profile_id,post_id,state,delivered_at)
      VALUES ($1,$2,'delivered',$3::timestamptz-interval '1 minute')`, [profileId, historicPost.id, activation.policy_activated_at]);
    await client.query(`INSERT INTO lead_states(user_id,post_id,status) VALUES ($1,$2,'contacted')`, [userId, historicPost.id]);
    await client.query(`INSERT INTO lead_source_opens(user_id,normalized_url,post_id,first_opened_at) VALUES ($1,$2,$3,now())`, [userId, historical, historicPost.id]);
    let progress = await getLeadEngagementProgress(client, userId, profileId);
    assert.equal(progress?.deliveredCount, 0, 'historical deliveries and status/open rows stay outside the new cohort');
    assert.equal(progress?.reviewedCount, 0, 'pre-policy evidence is not backfilled as review');

    const first = await distributeScan(1);
    assert.equal(first?.delivered, 10);
    assert.equal(first?.queued, 45, 'the remaining nonhistorical candidates stay pending after one old delivered row is preserved');
    const second = await distributeScan(2);
    assert.equal(second?.delivered, 10, 'the second scan is unrestricted and drains at most one more batch');
    const third = await distributeScan(3);
    assert.equal(third?.delivered, 0, 'the third real scan is recorded but its results are held below 80%');
    progress = await getLeadEngagementProgress(client, userId, profileId);
    assert.equal(progress?.completedDiscoveryScans, 3);
    assert.equal(progress?.gateState, 'holding_third_scan_results');
    assert.equal(progress?.deliveredCount, 20);
    assert.equal(progress?.pendingCount, 35);
    assert.equal((await tx(connection => requestManualJob(connection, profileId!, userId!))).outcome, 'usage_gated');
    assert.equal(await tx(connection => enqueueDueJobs(connection, profileId)), 0, 'routine scheduling does not materialize a fourth scan');

    const { rows: deliveredRows } = await client.query<{ id: string }>(`SELECT fp.id FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id=d.post_id
      WHERE d.search_profile_id=$1 AND d.state='delivered' ORDER BY d.delivered_at, fp.id LIMIT 20`, [profileId]);
    for (let i = 0; i < 15; i++) await tx(connection => recordLeadReview(connection, userId!, deliveredRows[i]!.id, 'source_open'));
    assert.equal((await tx(connection => recordLeadReview(connection, userId!, deliveredRows[0]!.id, 'source_open'))), 0,
      'reopening the same source is one review and cannot start another cycle');
    const unlockBatch = await tx(connection => recordLeadReview(connection, userId!, deliveredRows[15]!.id, 'source_open'));
    assert.equal(unlockBatch, 10, 'the exact sixteenth review immediately releases one pending batch without a Muse search');
    progress = await getLeadEngagementProgress(client, userId, profileId);
    assert.equal(progress?.deliveredCount, 30, 'the percentage denominator is recalculated after a new batch');
    assert.equal(progress?.reviewedCount, 16);
    assert.equal(progress?.requiredReviewedCount, 24);
    assert.equal(progress?.mayStartNewScan, false);

    const { rows: remaining } = await client.query<{ id: string }>(`SELECT fp.id FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id=d.post_id
      WHERE d.search_profile_id=$1 AND d.state='delivered' AND NOT EXISTS (SELECT 1 FROM lead_engagement_reviews r
        WHERE r.search_profile_id=d.search_profile_id AND r.post_id=d.post_id) ORDER BY d.delivered_at,fp.id LIMIT 8`, [profileId]);
    for (let i = 0; i < 7; i++) await tx(connection => recordLeadReview(connection, userId!, remaining[i]!.id, 'manual_status'));
    // Repeated workflow decisions remain one reviewed lead each.
    await tx(connection => recordLeadReview(connection, userId!, remaining[0]!.id, 'manual_status'));
    assert.equal(await tx(connection => recordLeadReview(connection, userId!, remaining[7]!.id, 'manual_status')), 10,
      'a manual status decision that reaches 24/30 releases only one more batch');
    progress = await getLeadEngagementProgress(client, userId, profileId);
    assert.equal(progress?.deliveredCount, 40);
    assert.equal(progress?.reviewedCount, 24);
    assert.equal(progress?.requiredReviewedCount, 32);
    assert.equal(progress?.mayStartNewScan, false);

    assert.equal((await tx(connection => distributeProfileLeads(connection, userId!, profileId!, 'scan:third')))?.delivered, 0,
      'retrying an old logical scan returns its original cycle and cannot redeliver');
    const { rows: [duplicates] } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM profile_lead_deliveries
      WHERE search_profile_id=$1 AND state='delivered'`, [profileId]);
    assert.equal(duplicates.n, 40, 'every distinct lead is delivered only once per profile');
  } finally {
    if (userId) await client.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
    client.release(); await pool.end();
  }
});
