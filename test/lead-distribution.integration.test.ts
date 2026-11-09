import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { distributeProfileLeads } from '../src/lead-distribution.js';

test('database delivery is capped, idempotent under concurrent refresh, tenant-scoped, and retains expired posts', async t => {
  if (!process.env.DATABASE_URL) { t.skip('Requires an isolated local lead-delivery test database.'); return; }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const client = await pool.connect().catch(() => null);
  if (!client) { t.skip('PostgreSQL is unavailable; requires the isolated local lead-delivery test database.'); await pool.end(); return; }
  const { rows: [database] } = await client.query<{ name: string }>('SELECT current_database() AS name');
  const connectionHost = new URL(process.env.DATABASE_URL).hostname;
  if (!database.name.includes('lead_delivery_codex_test') || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(connectionHost)) {
    client.release(); await pool.end(); t.skip('Refusing to write outside the dedicated loopback lead-delivery test database.'); return;
  }

  const { rows: [user] } = await client.query<{ id: string }>(`INSERT INTO users(display_name) VALUES ('Lead delivery integration fixture') RETURNING id`);
  const { rows: [profile] } = await client.query<{ id: string }>(`INSERT INTO agent_connections(user_id, name, kind, credential_hash)
    VALUES ($1, 'Lead delivery fixture', 'search_profile', NULL) RETURNING id`, [user.id]);
  await client.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, location, sources, frequency_minutes)
    VALUES ($1,1,true,'["quán cà phê sắp khai trương"]','TP.HCM','["social.search"]',30)`, [profile.id]);

  const urls: string[] = [];
  for (let i = 0; i < 60; i++) {
    const normalized = `https://facebook.com/deliveryfixture/posts/${i}`; urls.push(normalized);
    await client.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, title, content, author, published_at, collected_via)
      VALUES ($1,$2,$2,$3,$4,'Business page',now()-interval '1 day','qlead_shared_worker')`, [profile.id, normalized,
      `Business ${i}`, i === 59 ? 'Quán cà phê sắp khai trương, đang cần tìm nhà cung cấp.' : 'Quán cà phê sắp khai trương ở TP.HCM.']);
  }
  const staleUrl = 'https://facebook.com/deliveryfixture/posts/stale';
  await client.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, title, content, author, published_at, collected_via)
    VALUES ($1,$2,$2,'Old','Quán cà phê sắp khai trương.','Business page',now()-interval '45 days','qlead_shared_worker')`, [profile.id, staleUrl]);
  await client.query(`INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version)
    SELECT $1, normalized_url, 1 FROM facebook_posts WHERE agent_connection_id = $1`, [profile.id]);

  async function distribute(userId: string, profileId: string) {
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); const result = await distributeProfileLeads(tx, userId, profileId); await tx.query('COMMIT'); return result; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }

  try {
    const [first, retry] = await Promise.all([distribute(user.id, profile.id), distribute(user.id, profile.id)]);
    assert.equal(first?.delivered, 10);
    assert.equal(retry?.delivered, 10, 'duplicate calls return the original cycle result');
    assert.equal(retry?.maxLeads, 10);
    let { rows: [counts] } = await client.query(`SELECT count(*) FILTER (WHERE state='delivered')::int delivered,
        count(*) FILTER (WHERE state='queued')::int queued, count(*) FILTER (WHERE state='expired')::int expired
      FROM profile_lead_deliveries WHERE search_profile_id=$1`, [profile.id]);
    assert.deepEqual(counts, { delivered: 10, queued: 50, expired: 1 });
    const { rows: [top] } = await client.query(`SELECT d.state FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id=d.post_id
      WHERE d.search_profile_id=$1 AND fp.normalized_url=$2`, [profile.id, urls[59]]);
    assert.equal(top.state, 'delivered', 'the relevance-ranked candidate from the full pool wins the deterministic tie');

    // Add a better candidate and force a new stored interval in this isolated fixture to exercise backlog reconsideration.
    const better = 'https://facebook.com/deliveryfixture/posts/new-better';
    await client.query(`INSERT INTO facebook_posts(agent_connection_id, normalized_url, original_url, title, content, author, published_at, collected_via)
      VALUES ($1,$2,$2,'New opening','Quán cà phê sắp khai trương, đang cần tìm nhà cung cấp ngay.','Business page',now(),'qlead_shared_worker')`, [profile.id, better]);
    await client.query('INSERT INTO facebook_post_search_configs(agent_connection_id, normalized_url, configuration_version) VALUES ($1,$2,1)', [profile.id, better]);
    await client.query(`UPDATE lead_distribution_cycles SET cycle_key = cycle_key || ':fixture_previous' WHERE search_profile_id = $1`, [profile.id]);
    const second = await distribute(user.id, profile.id);
    assert.equal(second?.delivered, 10);
    const { rows: [newLead] } = await client.query(`SELECT state FROM profile_lead_deliveries d JOIN facebook_posts fp ON fp.id=d.post_id
      WHERE d.search_profile_id=$1 AND fp.normalized_url=$2`, [profile.id, better]);
    assert.equal(newLead.state, 'delivered');

    // No new scan is needed for the next queued batch; duplicate page reads in the new window still share one cap.
    await client.query(`UPDATE lead_distribution_cycles SET cycle_key = cycle_key || ':fixture_previous' WHERE search_profile_id = $1`, [profile.id]);
    const backlogOnly = await distribute(user.id, profile.id);
    assert.equal(backlogOnly?.delivered, 10);
    assert.equal(backlogOnly?.queued, 31);

    // The limit is data-configured, so a future package can change it without changing account storage semantics.
    await client.query('UPDATE lead_distribution_settings SET max_leads_per_scan = 20 WHERE search_profile_id = $1', [profile.id]);
    await client.query(`UPDATE lead_distribution_cycles SET cycle_key = cycle_key || ':fixture_previous' WHERE search_profile_id = $1`, [profile.id]);
    const upgradedLimit = await distribute(user.id, profile.id);
    assert.equal(upgradedLimit?.maxLeads, 20);
    assert.equal(upgradedLimit?.delivered, 20);

    // A second tenant may independently receive the same public permalink; a suspended account cannot.
    const { rows: [otherUser] } = await client.query(`INSERT INTO users(display_name) VALUES ('Other tenant fixture') RETURNING id`);
    const { rows: [otherProfile] } = await client.query(`INSERT INTO agent_connections(user_id,name,kind,credential_hash)
      VALUES ($1,'Other tenant profile','search_profile',NULL) RETURNING id`, [otherUser.id]);
    await client.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes)
      VALUES ($1,1,true,'["quán cà phê"]','TP.HCM','["social.search"]',30)`, [otherProfile.id]);
    await client.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,title,content,author,published_at,collected_via)
      VALUES ($1,$2,$2,'Other tenant','Quán cà phê sắp khai trương.','Page',now(),'qlead_shared_worker')`, [otherProfile.id, better]);
    await client.query(`INSERT INTO facebook_post_search_configs(agent_connection_id,normalized_url,configuration_version) VALUES ($1,$2,1)`, [otherProfile.id, better]);
    assert.equal((await distribute(otherUser.id, otherProfile.id))?.delivered, 1);
    await client.query(`UPDATE users SET lead_monitoring_status='suspended' WHERE id=$1`, [otherUser.id]);
    assert.equal(await distribute(otherUser.id, otherProfile.id), null);
    await client.query(`DELETE FROM users WHERE id=ANY($1::uuid[])`, [[user.id, otherUser.id]]);
  } finally {
    await client.query(`DELETE FROM users WHERE id=$1`, [user.id]).catch(() => undefined);
    client.release(); await pool.end();
  }
});
