import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import webpush from 'web-push';
import { pool } from '../src/db.js';
import { setLeadMonitoringStatus } from '../src/account-monitoring.js';
import { listAccountNotifications, markNotificationsRead, countUnreadNotifications, NOTIFICATION_HISTORY_LIMIT, normalizePublicReason } from '../src/account-notifications.js';
import { accountStatusPayload, drainPushNotifications, registerPushSubscription, type PushPayload } from '../src/push-notifications.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('public reason normalization keeps the Admin text and never invents one', () => {
  assert.equal(normalizePublicReason(null), null);
  assert.equal(normalizePublicReason('   \n  '), null);
  assert.equal(normalizePublicReason('  Gói   dùng thử  đã hết hạn.\r\nLiên hệ QLead.  '), 'Gói dùng thử đã hết hạn.\nLiên hệ QLead.');
  assert.equal(normalizePublicReason('x'.repeat(600))!.length, 500);
});

test('account status push payload says only what happened (no reason on the lock screen)', () => {
  const suspended = accountStatusPayload('lead_monitoring_suspended');
  assert.equal(suspended.body, 'Quản trị viên đã tạm dừng tìm lead mới cho tài khoản của bạn.');
  assert.equal(suspended.url, '/app/thong-bao');
  assert.equal(suspended.tag, 'account-status');
  assert.equal(accountStatusPayload('lead_monitoring_resumed').body, 'QLead đã tiếp tục tìm lead mới cho tài khoản của bạn.');
});

test('Admin suspension/reactivation creates exactly one scoped notification per real change (isolated DB)', async t => {
  try { await pool.query('SELECT 1'); }
  catch { t.skip('PostgreSQL unavailable.'); return; }
  const { rows: [database] } = await pool.query('SELECT current_database() AS name');
  if (!/_test/.test(database.name) && database.name !== 'muse_bridge') { t.skip('Requires an isolated local test database.'); await pool.end(); return; }
  const vapid = webpush.generateVAPIDKeys();
  Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'https://qlead.vn/', QLEAD_WEB_PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64') });

  const ids: string[] = [];
  try {
    const admin = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Notif Admin') RETURNING id")).rows[0].id as string;
    const customer = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Notif Customer') RETURNING id")).rows[0].id as string;
    const other = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Notif Other') RETURNING id")).rows[0].id as string;
    const legacy = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Notif Legacy') RETURNING id")).rows[0].id as string;
    ids.push(admin, customer, other, legacy);
    const profile = (await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,'Synthetic Notif Profile','search_profile') RETURNING id", [customer])).rows[0].id;
    await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes) VALUES ($1,1,true,'["x"]','','["social.search"]',30)`, [profile]);
    await pool.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,content,author,published_at,platform) VALUES ($1,'https://facebook.com/n/1','https://facebook.com/n/1','Synthetic','A',now(),'facebook')`, [profile]);
    await pool.query(`INSERT INTO lead_notes(user_id, post_id, body) SELECT $1, id, 'Ghi chú khách' FROM facebook_posts WHERE agent_connection_id = $2`, [customer, profile]).catch(() => undefined);
    const dataBefore = (await pool.query(`SELECT (SELECT count(*) FROM facebook_posts WHERE agent_connection_id=$1)::int AS posts, (SELECT count(*) FROM scan_configs WHERE agent_connection_id=$1)::int AS configs,
      (SELECT count(*) FROM lead_notes WHERE user_id=$2)::int AS notes`, [profile, customer])).rows[0];

    // Device with push on: account notices go through the existing outbox.
    const session = (await pool.query(`INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at) VALUES ($1,$2,'password',now()+interval '1 day') RETURNING id`, [customer, sha(randomBytes(16).toString('hex'))])).rows[0].id;
    await registerPushSubscription({ userId: customer, sessionId: session, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/notif-synthetic', expirationTime: null, keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString('base64url') } }, platform: 'android', standalone: true, origin: 'https://qlead.vn' });

    // Case A: suspension with a public reason and a separate internal note.
    const a = await tx(c => setLeadMonitoringStatus(c, customer, admin, { status: 'suspended', reason: 'NỘI BỘ: nợ phí', publicReason: '  Gói dùng thử đã hết hạn.  ' }));
    assert.equal(a?.changed, true);
    assert.ok(a?.notificationId && a.pushOutboxId);
    // Retry of the same request: no change, no second notification, no second push.
    const retry = await tx(c => setLeadMonitoringStatus(c, customer, admin, { status: 'suspended', reason: 'khác', publicReason: 'khác' }));
    assert.equal(retry?.changed, false);
    assert.equal(retry?.notificationId, null);
    let list = await listAccountNotifications(pool, customer);
    assert.equal(list.items.length, 1);
    assert.equal(list.unread, 1);
    assert.equal(list.items[0]!.kind, 'lead_monitoring_suspended');
    assert.equal(list.items[0]!.publicReason, 'Gói dùng thử đã hết hạn.');
    assert.ok(!JSON.stringify(list).includes('NỘI BỘ'), 'internal note never reaches the customer');

    // Account isolation: another account sees nothing and cannot mark this one read.
    assert.deepEqual((await listAccountNotifications(pool, other)).items, []);
    assert.equal(await markNotificationsRead(pool, other, [list.items[0]!.id]), 0);
    assert.equal(await countUnreadNotifications(pool, customer), 1, 'foreign mark-read ignored');

    // Push: delivered with the account payload while suspended (new-lead pushes stay blocked for suspended accounts).
    const sent: PushPayload[] = [];
    await drainPushNotifications({ outboxId: a!.pushOutboxId!, sender: async (_s, payload) => { sent.push(payload); return { statusCode: 201 }; } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, 'account_status');
    assert.ok(!JSON.stringify(sent[0]).includes('hết hạn'), 'no reason in the push payload');
    assert.equal((await pool.query('SELECT last_new_lead_push_at FROM push_notification_preferences WHERE user_id=$1', [customer])).rows[0].last_new_lead_push_at, null, 'account push does not start the new-lead cooldown');

    // Case C: reactivation, then a quick re-suspension without a public reason (case B); the stale push is suppressed.
    const resumed = await tx(c => setLeadMonitoringStatus(c, customer, admin, { status: 'active' }));
    assert.equal(resumed?.changed, true);
    const b = await tx(c => setLeadMonitoringStatus(c, customer, admin, { status: 'suspended', reason: 'chỉ nội bộ' }));
    sent.length = 0;
    await drainPushNotifications({ sender: async (_s, payload) => { sent.push(payload); return { statusCode: 201 }; } });
    assert.deepEqual(sent.map(p => p.body), ['Quản trị viên đã tạm dừng tìm lead mới cho tài khoản của bạn.'], 'only the notice for the current status is pushed');
    list = await listAccountNotifications(pool, customer);
    assert.deepEqual(list.items.map(i => i.kind), ['lead_monitoring_suspended', 'lead_monitoring_resumed', 'lead_monitoring_suspended']);
    assert.equal(list.items[0]!.id, b!.notificationId);
    assert.ok(!('publicReason' in list.items[0]!), 'no reason key at all without a public reason');
    assert.ok(!('publicReason' in list.items[1]!), 'reactivation carries no reason');
    assert.equal(b?.publicReason, null, 'a new suspension does not reuse an older public reason');

    // Read state: only the ids marked, idempotent.
    assert.equal(await markNotificationsRead(pool, customer, [list.items[2]!.id, list.items[2]!.id, 'not-a-uuid']), 2);
    assert.equal(await markNotificationsRead(pool, customer, [list.items[2]!.id]), 2);

    // Legacy suspension written before migration 018 (internal reason only): no public reason and no notification is invented.
    await pool.query(`UPDATE users SET lead_monitoring_status='suspended', lead_monitoring_reason='Ghi chú cũ chỉ admin thấy', lead_monitoring_changed_at=now() WHERE id=$1`, [legacy]);
    const legacyRetry = await tx(c => setLeadMonitoringStatus(c, legacy, admin, { status: 'suspended' }));
    assert.equal(legacyRetry?.changed, false);
    assert.equal(legacyRetry?.publicReason, null);
    assert.deepEqual((await listAccountNotifications(pool, legacy)).items, []);
    const legacyResume = await tx(c => setLeadMonitoringStatus(c, legacy, admin, { status: 'active' }));
    const legacyList = await listAccountNotifications(pool, legacy);
    assert.equal(legacyList.items.length, 1);
    assert.ok(!JSON.stringify(legacyList).includes('Ghi chú cũ'), 'legacy internal note not exposed');
    assert.equal(legacyResume?.reason, 'Ghi chú cũ chỉ admin thấy', 'internal audit retained for Admins');

    // Retention: history is bounded per account.
    for (let i = 0; i < NOTIFICATION_HISTORY_LIMIT + 4; i++) {
      await tx(c => setLeadMonitoringStatus(c, other, admin, { status: i % 2 ? 'active' : 'suspended' }));
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM account_notifications WHERE user_id=$1', [other])).rows[0].n, NOTIFICATION_HISTORY_LIMIT);

    // Data integrity: suspension and reactivation touched no lead, note or configuration.
    const dataAfter = (await pool.query(`SELECT (SELECT count(*) FROM facebook_posts WHERE agent_connection_id=$1)::int AS posts, (SELECT count(*) FROM scan_configs WHERE agent_connection_id=$1)::int AS configs,
      (SELECT count(*) FROM lead_notes WHERE user_id=$2)::int AS notes`, [profile, customer])).rows[0];
    assert.deepEqual(dataAfter, dataBefore);
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});
