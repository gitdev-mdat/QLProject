import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import webpush from 'web-push';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import {
  drainPushNotifications,
  registerPushSubscription,
  removePushSubscription,
  sendTestPush,
  subscriptionStatus,
  type PushPayload,
  type PushSubscriptionInput,
} from '../src/push-notifications.js';

const migrationNames = [
  '001_initial.sql', '002_post_metadata_enrichment.sql', '003_post_search_config_associations.sql', '004_web_sessions.sql',
  '005_lead_workflow.sql', '006_shared_workers.sql', '007_worker_handoffs.sql', '008_group_requests.sql',
  '009_search_profile_details.sql', '010_user_accounts.sql', '011_initial_search_jobs.sql', '012_natural_language_search.sql',
  '013_account_lead_monitoring.sql', '014_admin_user_deletion_audit.sql', '015_initial_discovery_followup.sql',
  '016_add_summary_vi_to_facebook_posts.sql', '017_push_notifications.sql', '018_account_notifications.sql',
  '019_customer_feedback.sql', '020_login_events.sql', '021_lead_distribution.sql', '022_landing_preview.sql',
  '023_landing_showcase_pins.sql', '024_seo_attribution.sql', '025_hot_leads_quiet_hours.sql',
];
const realAgentIds = ['a366abd8-4e93-46dc-be80-bbf3df2af06d', 'e84ffff9-fb61-4887-a19a-6fc452a1f66c'];
const token = randomBytes(32).toString('base64url');
const workerToken = randomBytes(32).toString('base64url');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const auth = { authorization: `Bearer ${workerToken}` };

async function ensureMigrations() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of migrationNames) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (rowCount) continue;
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(sql); await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

function fakeSubscription(endpoint: string): PushSubscriptionInput {
  return { endpoint, expirationTime: null, keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function scanResults(job: any, urls: string[]) {
  return {
    event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version,
    scan_id: job.scan_id, attempt_no: job.attempt_no, scanned_at: new Date().toISOString(),
    keywords_used: ['synthetic'], sources_used: ['social.search'],
    posts: urls.map((url, index) => ({ url, author: `Synthetic ${index}`, content: `Synthetic content ${index}`, collected_via: 'muse' })),
    stats: { total_found: urls.length }, errors: [],
  };
}

test('worker result commits deduplicated push outbox and delivery retries on isolated PostgreSQL', async t => {
  try { await pool.query('SELECT 1'); }
  catch { t.skip('PostgreSQL unavailable; requires the isolated test database.'); await app.close(); if (process.env.DATABASE_URL) await pool.end().catch(() => undefined); return; }
  const { rows: [database] } = await pool.query('SELECT current_database() AS name');
  if (database.name !== 'muse_bridge_qlead_initial_discovery_test') {
    t.skip('Refusing to run mutating push integration tests outside muse_bridge_qlead_initial_discovery_test.');
    await app.close(); await pool.end(); return;
  }

  await ensureMigrations();
  const preserved = await pool.query(`SELECT id,agent_connection_id,external_scan_id,received_at,new_posts FROM scan_runs WHERE agent_connection_id=ANY($1::uuid[]) ORDER BY id`, [realAgentIds]);
  const originalRows = preserved.rows;
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'https://qlead.vercel.app/';
  process.env.QLEAD_WEB_PUSH_ENCRYPTION_KEY = randomBytes(32).toString('base64');

  let userId = '';
  let otherUserId = '';
  let disabledUserId = '';
  let profileId = '';
  let otherProfileId = '';
  let disabledProfileId = '';
  let workerId = '';
  let sessionId = '';
  const endpoints = ['https://fcm.googleapis.com/fcm/send/synthetic-device-1', 'https://fcm.googleapis.com/fcm/send/synthetic-device-2'];
  const qleadEndpoints = ['https://fcm.googleapis.com/fcm/send/synthetic-qlead-device-1', 'https://fcm.googleapis.com/fcm/send/synthetic-qlead-device-2'];
  const delivered: Array<{ endpoint: string; payload: PushPayload }> = [];

  try {
    userId = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Push Owner') RETURNING id")).rows[0].id;
    otherUserId = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Push Other') RETURNING id")).rows[0].id;
    disabledUserId = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Push Disabled') RETURNING id")).rows[0].id;
    profileId = (await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,'Synthetic Push Profile','search_profile') RETURNING id", [userId])).rows[0].id;
    otherProfileId = (await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,'Synthetic Push Other Profile','search_profile') RETURNING id", [otherUserId])).rows[0].id;
    disabledProfileId = (await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,'Synthetic Push Disabled Profile','search_profile') RETURNING id", [disabledUserId])).rows[0].id;
    await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,keywords,location,sources,frequency_minutes)
      VALUES ($1,1,'["synthetic"]','Test','["social.search"]',30),($2,1,'["synthetic"]','Test','["social.search"]',30),($3,1,'["synthetic"]','Test','["social.search"]',30)`, [profileId, otherProfileId, disabledProfileId]);
    sessionId = (await pool.query(`INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at) VALUES ($1,$2,'password',now()+interval '1 day') RETURNING id`, [userId, sha(token)])).rows[0].id;
    const otherSessionId = (await pool.query(`INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at) VALUES ($1,$2,'password',now()+interval '1 day') RETURNING id`, [otherUserId, sha(randomBytes(32).toString('base64url'))])).rows[0].id;
    const disabledSessionId = (await pool.query(`INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at) VALUES ($1,$2,'password',now()+interval '1 day') RETURNING id`, [disabledUserId, sha(randomBytes(32).toString('base64url'))])).rows[0].id;
    for (let index = 0; index < endpoints.length; index++) {
      const subscription = fakeSubscription(endpoints[index]!);
      await registerPushSubscription({ userId, sessionId, subscription, platform: index ? 'desktop' : 'ios', standalone: Boolean(index), origin: 'https://qlead.vercel.app' });
      if (index === 0) await registerPushSubscription({ userId, sessionId, subscription, platform: 'ios', standalone: false, origin: 'https://qlead.vercel.app' });
    }
    for (let index = 0; index < qleadEndpoints.length; index++) {
      await registerPushSubscription({ userId, sessionId, subscription: fakeSubscription(qleadEndpoints[index]!), platform: index ? 'desktop' : 'ios', standalone: Boolean(index), origin: 'https://qlead.vn' });
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [userId])).rows[0].n, 4, 'repeat registration upserts one device on each active origin');
    assert.equal(await subscriptionStatus({ userId, sessionId, endpoint: endpoints[0]! }), true);
    assert.equal(await subscriptionStatus({ userId: otherUserId, sessionId: otherSessionId, endpoint: endpoints[0]! }), false, 'another account cannot inspect a subscription');
    await registerPushSubscription({ userId: otherUserId, sessionId: otherSessionId, subscription: fakeSubscription('https://fcm.googleapis.com/fcm/send/other'), platform: 'android', standalone: false, origin: 'https://qlead.vercel.app' });
    await registerPushSubscription({ userId: disabledUserId, sessionId: disabledSessionId, subscription: fakeSubscription('https://fcm.googleapis.com/fcm/send/disabled'), platform: 'android', standalone: false, origin: 'https://qlead.vercel.app' });
    await pool.query('UPDATE push_notification_preferences SET enabled=false WHERE user_id=$1', [disabledUserId]);

    workerId = (await pool.query(`INSERT INTO muse_workers(name,credential_hash,status,authorized_sources,max_jobs_per_claim,lease_minutes)
      VALUES ('Synthetic Push Worker',$1,'active','["social.search"]',2,20) RETURNING id`, [sha(workerToken)])).rows[0].id;
    const makeJob = async (searchProfileId: string, slot: Date, kind: 'initial' | 'scheduled' = 'scheduled') => {
      // Keep this push integration fixture independent of wall-clock cycle boundaries; every scan has its own eligible batch.
      await pool.query(`UPDATE lead_distribution_cycles SET cycle_key=cycle_key || ':push-fixture' WHERE search_profile_id=$1`, [searchProfileId]);
      const { rows: [job] } = await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,available_at,required_sources,kind)
        VALUES ($1,1,$2,$3,now()-interval '1 hour','["social.search"]',$4) RETURNING id`, [searchProfileId, `push-${randomBytes(8).toString('hex')}`, slot, kind]);
      const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { search_profile_id: searchProfileId, max_jobs: 1 } });
      assert.equal(claim.statusCode, 200, claim.body);
      const issued = claim.json().jobs[0];
      assert.equal(issued.job_id, job.id);
      return issued;
    };
    const submit = async (job: any, urls: string[]) => {
      const result = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: scanResults(job, urls) });
      assert.equal(result.statusCode, 200, result.body);
      return result;
    };

    const first = await makeJob(profileId, new Date(Date.now() - 60 * 60_000), 'initial');
    const urlsA = Array.from({ length: 5 }, (_, index) => `https://facebook.com/groups/push-test/posts/${index + 1}`);
    const firstResult = await submit(first, urlsA);
    assert.equal(firstResult.json().source_linked_new_posts, 5);
    const firstOutboxId = (await pool.query(`SELECT o.id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [first.job_id])).rows[0].id;
    const duplicate = await submit(first, [...urlsA, 'https://facebook.com/groups/push-test/posts/late-duplicate']);
    assert.equal(duplicate.json().source_linked_new_posts, 5);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1', [userId])).rows[0].n, 1, 'duplicate job acknowledgement created no extra event');

    const second = await makeJob(profileId, new Date(Date.now() - 2 * 60 * 60_000));
    const urlsB = ['https://facebook.com/groups/push-test/posts/6', 'https://facebook.com/groups/push-test/posts/7'];
    await submit(second, urlsB);
    const secondOutboxId = (await pool.query(`SELECT o.id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [second.job_id])).rows[0].id;
    const aggregated = await drainPushNotifications({ outboxId: secondOutboxId, sender: async (subscription, payload) => {
      delivered.push({ endpoint: subscription.endpoint, payload });
      return { statusCode: 201 };
    } });
    assert.equal(aggregated.sent, 2, 'one coalesced request per active device');
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every(item => qleadEndpoints.includes(item.endpoint)), 'qlead.vn subscriptions take precedence when both production origins are active');
    assert.ok(delivered.every(item => item.payload.count === 7 && item.payload.url === '/app/bai-viet'));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM push_notification_deliveries WHERE outbox_id=ANY($1::uuid[]) AND status='sent'", [[firstOutboxId, secondOutboxId]])).rows[0].n, 4);

    const cooldownOne = await makeJob(profileId, new Date(Date.now() - 3 * 60 * 60_000));
    await submit(cooldownOne, ['https://facebook.com/groups/push-test/posts/8']);
    const cooldownOneOutbox = (await pool.query(`SELECT o.id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [cooldownOne.job_id])).rows[0].id;
    const deferredOne = await drainPushNotifications({ outboxId: cooldownOneOutbox, sender: async () => ({ statusCode: 201 }) });
    assert.equal(deferredOne.sent, 0, 'a fresh event inside 15 minutes is deferred');

    const cooldownTwo = await makeJob(profileId, new Date(Date.now() - 4 * 60 * 60_000));
    await submit(cooldownTwo, ['https://facebook.com/groups/push-test/posts/9', 'https://facebook.com/groups/push-test/posts/10']);
    const cooldownTwoOutbox = (await pool.query(`SELECT o.id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [cooldownTwo.job_id])).rows[0].id;
    const deferredTwo = await drainPushNotifications({ outboxId: cooldownTwoOutbox, sender: async () => ({ statusCode: 201 }) });
    assert.equal(deferredTwo.sent, 0, 'the next scan is coalesced during the same cooldown');
    await pool.query("UPDATE push_notification_preferences SET last_new_lead_push_at=now()-interval '16 minutes' WHERE user_id=$1", [userId]);
    await pool.query("UPDATE push_notification_deliveries SET available_at=now() WHERE outbox_id=ANY($1::uuid[]) AND status='pending'", [[cooldownOneOutbox, cooldownTwoOutbox]]);
    delivered.length = 0;
    const coalesced = await drainPushNotifications({ sender: async (subscription, payload) => {
      delivered.push({ endpoint: subscription.endpoint, payload }); return { statusCode: 201 };
    } });
    assert.equal(coalesced.sent, 2);
    assert.ok(delivered.every(item => item.payload.count === 3), 'lead counts accumulated into one push per device after the cooldown');

    const fifth = await makeJob(profileId, new Date(Date.now() - 5 * 60 * 60_000));
    await submit(fifth, []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1', [userId])).rows[0].n, 4, 'zero eligible posts create no event');

    const sixth = await makeJob(profileId, new Date(Date.now() - 6 * 60 * 60_000));
    await submit(sixth, [urlsA[0]!]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1', [userId])).rows[0].n, 4, 'metadata enrichment alone does not create an event');

    const seventh = await makeJob(profileId, new Date(Date.now() - 7 * 60 * 60_000));
    const seventhResult = await submit(seventh, ['https://facebook.com/groups/push-test/posts/11']);
    assert.equal(seventhResult.json().source_linked_new_posts, 1);
    const seventhOutboxId = (await pool.query(`SELECT o.id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [seventh.job_id])).rows[0].id;
    await pool.query(`UPDATE push_notification_preferences SET last_new_lead_push_at=now()-interval '16 minutes' WHERE user_id=$1`, [userId]);
    const retryOutcome = await drainPushNotifications({ outboxId: seventhOutboxId, sender: async (subscription) => {
      if (subscription.endpoint === qleadEndpoints[0]) throw Object.assign(new Error('gone'), { statusCode: 410 });
      throw Object.assign(new Error('temporary'), { statusCode: 503 });
    } });
    assert.equal(retryOutcome.expired, 1);
    assert.equal(retryOutcome.retried, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1', [userId])).rows[0].n, 3, '410 removed invalid device and retained old-origin subscriptions');
    const pending = await pool.query("SELECT status,attempts FROM push_notification_deliveries WHERE outbox_id=$1 AND status='pending'", [seventhOutboxId]);
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0].attempts, 1);
    await pool.query("UPDATE push_notification_deliveries SET available_at=now() WHERE outbox_id=$1 AND status='pending'", [seventhOutboxId]);
    const recovered = await drainPushNotifications({ outboxId: seventhOutboxId, sender: async () => ({ statusCode: 201 }) });
    assert.equal(recovered.sent, 1);

    // An explicit, recent request that matches the user's profile gets a distinct alert after its delivery commits.
    await pool.query(`UPDATE lead_distribution_cycles SET cycle_key=cycle_key || ':hot-fixture' WHERE search_profile_id=$1`, [profileId]);
    const hotJob = await makeJob(profileId, new Date(Date.now() - 10 * 60 * 60_000));
    const hotUrl = 'https://facebook.com/groups/push-test/posts/hot';
    const hotPayload = scanResults(hotJob, [hotUrl]);
    hotPayload.posts[0]!.content = 'Chủ quán đang cần tìm synthetic phần mềm quản lý ngay.';
    hotPayload.posts[0]!.published_at = new Date().toISOString();
    const hotResult = await app.inject({ method: 'POST', url: `/api/worker/jobs/${hotJob.job_id}/results`, headers: auth, payload: hotPayload });
    assert.equal(hotResult.statusCode, 200, hotResult.body);
    const hotEvent = await pool.query(`SELECT o.id,o.notification_kind,o.lead_id FROM push_notification_outbox o JOIN scan_runs r ON r.id=o.scan_run_id WHERE r.search_job_id=$1`, [hotJob.job_id]);
    assert.equal(hotEvent.rows.length, 1);
    assert.equal(hotEvent.rows[0]!.notification_kind, 'hot_lead');
    const hotAssessment = await pool.query(`SELECT d.state,d.hot_at_discovery,d.hot_reason_vi FROM profile_lead_deliveries d WHERE d.post_id=$1`, [hotEvent.rows[0]!.lead_id]);
    assert.deepEqual(hotAssessment.rows[0], { state: 'delivered', hot_at_discovery: true, hot_reason_vi: hotAssessment.rows[0]?.hot_reason_vi });
    assert.match(hotAssessment.rows[0]!.hot_reason_vi, /dang can tim/);
    await submit(hotJob, [hotUrl]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1 AND notification_kind='hot_lead'`, [userId])).rows[0]!.n, 1,
      'duplicate result acknowledgement does not repeat a Hot Lead notification');
    delivered.length = 0;
    const hotDrain = await drainPushNotifications({ outboxId: hotEvent.rows[0]!.id, sender: async (subscription, payload) => {
      delivered.push({ endpoint: subscription.endpoint, payload }); return { statusCode: 201 };
    } });
    assert.equal(hotDrain.sent, 1, 'hot alerts bypass ordinary lead cooldown and are sent to each remaining active device');
    assert.ok(delivered.every(item => item.payload.kind === 'hot_lead' && item.payload.url === `/app/bai-viet/${hotEvent.rows[0]!.lead_id}`));

    const remainingEndpoint = qleadEndpoints[1]!;
    assert.equal(await sendTestPush({ userId, sessionId, endpoint: remainingEndpoint }, async (_subscription, payload) => {
      assert.equal(payload.kind, 'test'); return { statusCode: 201 };
    }), 'sent');
    assert.equal(await sendTestPush({ userId, sessionId, endpoint: remainingEndpoint }, async () => ({ statusCode: 201 })), 'rate_limited');
    await removePushSubscription({ userId, sessionId, endpoint: remainingEndpoint });
    assert.equal(await subscriptionStatus({ userId, sessionId, endpoint: remainingEndpoint }), false);

    const suspendedJob = await makeJob(otherProfileId, new Date(Date.now() - 8 * 60 * 60_000), 'initial');
    await pool.query("UPDATE users SET lead_monitoring_status='suspended' WHERE id=$1", [otherUserId]);
    await submit(suspendedJob, ['https://facebook.com/groups/push-test-suspended/posts/1']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1', [otherUserId])).rows[0].n, 0, 'monitoring suspension suppresses new push event');
    const disabledJob = await makeJob(disabledProfileId, new Date(Date.now() - 9 * 60 * 60_000), 'initial');
    await submit(disabledJob, ['https://facebook.com/groups/push-test-disabled/posts/1']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_notification_outbox WHERE user_id=$1', [disabledUserId])).rows[0].n, 0, 'account preference suppresses new push event');
    const afterPreservation = await pool.query(`SELECT id,agent_connection_id,external_scan_id,received_at,new_posts FROM scan_runs WHERE agent_connection_id=ANY($1::uuid[]) ORDER BY id`, [realAgentIds]);
    assert.deepEqual(afterPreservation.rows, originalRows, 'existing scan history remained unchanged');
  } finally {
    if (userId || otherUserId || disabledUserId) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId, otherUserId, disabledUserId].filter(Boolean)]).catch(() => undefined);
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id=$1', [workerId]).catch(() => undefined);
    await app.close();
    await pool.end();
  }
});
