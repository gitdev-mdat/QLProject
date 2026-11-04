import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';

const tokenA = randomBytes(32).toString('base64url');
const tokenB = randomBytes(32).toString('base64url');
let userA = ''; let userB = ''; let agentA = ''; let agentB = '';
const realAgentIds = ['a366abd8-4e93-46dc-be80-bbf3df2af06d', 'e84ffff9-fb61-4887-a19a-6fc452a1f66c'];
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const basePost = (url: string, extra: Record<string, unknown> = {}) => ({ url, ...extra });
const payload = (scan_id: string, posts: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
  event: 'facebook_scan_completed', source: 'muse', user_id: 'untrusted-client-claim', configuration_version: 1,
  scan_id, scanned_at: '2026-10-29T13:17:51+07:00', keywords_used: ['synthetic'], sources_used: ['public'],
  posts, stats: { total_found: posts.length }, errors: [], ...overrides
});

async function snapshotExistingAgents() {
  const [agents, configs, scans, posts] = await Promise.all([
    pool.query(`SELECT id,user_id,name,credential_hash,status,created_at FROM agent_connections WHERE id=ANY($1::uuid[]) ORDER BY id`, [realAgentIds]),
    pool.query(`SELECT sc.* FROM scan_configs sc WHERE agent_connection_id=ANY($1::uuid[]) ORDER BY agent_connection_id,version`, [realAgentIds]),
    pool.query(`SELECT id,agent_connection_id,external_scan_id,configuration_version,scanned_at,received_at,total_found,received_posts,new_posts,duplicates_skipped,status,errors FROM scan_runs WHERE agent_connection_id=ANY($1::uuid[]) ORDER BY agent_connection_id,external_scan_id`, [realAgentIds]),
    pool.query(`SELECT id,agent_connection_id,normalized_url,original_url,content,author,published_at,source_type,collected_via,first_seen_at FROM facebook_posts WHERE agent_connection_id=ANY($1::uuid[]) ORDER BY agent_connection_id,normalized_url`, [realAgentIds])
  ]);
  return { agents: agents.rows, configs: configs.rows, scans: scans.rows, posts: posts.rows };
}

test('POC #6 metadata retention integration checks (requires the existing local PostgreSQL)', async t => {
  try { await pool.query('SELECT 1'); }
  catch { t.skip('PostgreSQL is unavailable; start the existing Docker Compose stack and rerun npm test'); return; }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  const preservedBefore = await snapshotExistingAgents();
  await pool.query(await readFile(new URL('../migrations/002_post_metadata_enrichment.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/003_post_search_config_associations.sql', import.meta.url), 'utf8'));

  const uA = await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Metadata Test A') RETURNING id"); userA = uA.rows[0].id;
  const uB = await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic Metadata Test B') RETURNING id"); userB = uB.rows[0].id;
  const a = await pool.query("INSERT INTO agent_connections(user_id,name,credential_hash) VALUES ($1,'Synthetic Muse A',$2) RETURNING id", [userA, createHash('sha256').update(tokenA).digest('hex')]); agentA = a.rows[0].id;
  const b = await pool.query("INSERT INTO agent_connections(user_id,name,credential_hash) VALUES ($1,'Synthetic Muse B',$2) RETURNING id", [userB, createHash('sha256').update(tokenB).digest('hex')]); agentB = b.rows[0].id;
  await pool.query("INSERT INTO scan_configs(agent_connection_id,version,keywords,location,frequency_minutes) VALUES ($1,1,'[\"synthetic A\"]','Test Location A',30),($2,1,'[\"synthetic B\"]','Test Location B',30)", [agentA, agentB]);

  await t.test('health and agent configurations remain scoped to their credentials', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/agent/config', headers: headers(tokenA) })).json().keywords, ['synthetic A']);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/agent/config', headers: headers(tokenB) })).json().keywords, ['synthetic B']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/config' })).statusCode, 401);
  });

  await t.test('Muse posted_at is the original post time and is mapped without losing Vietnamese text', async () => {
    const body = payload('synthetic-muse-schema', [basePost('https://www.facebook.com/demo/posts/1001', {
      title: 'Khai trương quán cà phê ☕', content: 'Canonical content wins', summary: 'Alias fallback content', published_at: '2026-10-28T09:30:00+07:00', posted_at: '2026-10-27T09:30:00+07:00', platform: 'facebook', author: 'Trang địa phương'
    })]);
    const response = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: body });
    assert.equal(response.statusCode, 200, response.body);
    const { rows: [stored] } = await pool.query('SELECT title,content,author,published_at,platform FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE $2', [agentA, '%/demo/posts/1001']);
    assert.equal(stored.title, 'Khai trương quán cà phê ☕');
    assert.equal(stored.content, 'Canonical content wins');
    assert.equal(stored.author, 'Trang địa phương');
    assert.equal(stored.platform, 'facebook');
    assert.equal(new Date(stored.published_at).toISOString(), new Date('2026-10-27T02:30:00.000Z').toISOString());
  });

  await t.test('agent posts endpoint returns actionable fields and remains credential-scoped', async () => {
    const outOfOrder = payload('synthetic-post-order', [
      basePost('https://www.facebook.com/demo/posts/1005', { author: 'Newest by post time', content: 'Synthetic ordering text', posted_at: '2026-11-02T12:00:00Z' }),
      basePost('https://www.facebook.com/demo/posts/1006', { author: 'Older by post time', content: 'Synthetic ordering text', posted_at: '2026-10-26T12:00:00Z' }),
      basePost('https://www.facebook.com/demo/posts/1007', { author: 'Unknown post time', content: 'Synthetic ordering text' }),
    ]);
    const ingested = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: outOfOrder });
    assert.equal(ingested.statusCode, 200, ingested.body);
    const response = await app.inject({ method: 'GET', url: '/api/agent/posts', headers: headers(tokenA) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().total, 4);
    const lead = response.json().records.find((record: { author: string }) => record.author === 'Trang địa phương');
    assert.equal(lead.author, 'Trang địa phương');
    assert.equal(lead.content, 'Canonical content wins');
    assert.equal(lead.published_at, new Date('2026-10-27T02:30:00.000Z').toISOString());
    assert.equal(lead.discovered_at !== null, true);
    assert.equal(lead.contact, null);
    assert.equal(lead.area.location, null);
    assert.deepEqual(lead.search_configurations.map((config: { version: number }) => config.version), [1]);
    const firstPage = await app.inject({ method: 'GET', url: '/api/agent/posts?limit=2&offset=0', headers: headers(tokenA) });
    const secondPage = await app.inject({ method: 'GET', url: '/api/agent/posts?limit=2&offset=2', headers: headers(tokenA) });
    assert.deepEqual(firstPage.json().records.map((record: { author: string }) => record.author), ['Newest by post time', 'Trang địa phương']);
    assert.deepEqual(secondPage.json().records.map((record: { author: string }) => record.author), ['Older by post time', 'Unknown post time']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/posts' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/posts', headers: headers(tokenB) })).json().total, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/posts?limit=201', headers: headers(tokenA) })).statusCode, 400);
  });

  await t.test('canonical metadata, URL-only posts, and optional metadata are accepted', async () => {
    const canonical = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('canonical', [basePost('https://facebook.com/demo/posts/1002', { title: 'Canonical title', content: 'Canonical content', published_at: '2026-10-27T10:00:00Z', platform: 'facebook' })]) });
    const urlOnly = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('url-only', [basePost('https://facebook.com/demo/posts/1003')]) });
    assert.equal(canonical.statusCode, 200, canonical.body);
    assert.equal(urlOnly.statusCode, 200, urlOnly.body);
    const { rows: [row] } = await pool.query('SELECT title,content,published_at,platform FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE $2', [agentA, '%/demo/posts/1003']);
    assert.deepEqual(row, { title: null, content: null, published_at: null, platform: null });
  });

  await t.test('a later new scan enriches blank fields but never overwrites existing nonblank metadata', async () => {
    const url = 'https://facebook.com/demo/posts/1003';
    const first = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('enrichment-pass-1', [basePost(url)]) });
    assert.equal(first.statusCode, 200, first.body);
    const later = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('enrichment-pass-2', [basePost(url, {
      title: 'Recovered title', summary: 'Recovered summary with Unicode — đã lưu', posted_at: '2026-10-26T08:00:00+07:00', platform: 'facebook', author: 'Recovered author'
    })]) });
    assert.equal(later.statusCode, 200, later.body);
    assert.equal(later.json().inserted_posts, 0);
    assert.equal(later.json().updated_posts, 1);
    const { rows: [row] } = await pool.query('SELECT title,content,author,published_at,platform FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE $2', [agentA, '%/demo/posts/1003']);
    assert.deepEqual(row, { title: 'Recovered title', content: 'Recovered summary with Unicode — đã lưu', author: 'Recovered author', published_at: new Date('2026-10-26T01:00:00.000Z'), platform: 'facebook' });

    const attemptOverwrite = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('enrichment-pass-3', [basePost(url, { title: 'Different title', summary: 'Different content', platform: 'other' })]) });
    assert.equal(attemptOverwrite.statusCode, 200);
    assert.equal(attemptOverwrite.json().updated_posts, 0);
    const { rows: [unchanged] } = await pool.query('SELECT title,content,platform FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE $2', [agentA, '%/demo/posts/1003']);
    assert.deepEqual(unchanged, { title: 'Recovered title', content: 'Recovered summary with Unicode — đã lưu', platform: 'facebook' });
    const emptyUpdate = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('enrichment-pass-4', [basePost(url, { title: '', summary: '   ', platform: null })]) });
    assert.equal(emptyUpdate.statusCode, 200);
    assert.equal(emptyUpdate.json().updated_posts, 0);
    const { rows: [run] } = await pool.query('SELECT new_posts,updated_posts,duplicates_skipped FROM scan_runs WHERE agent_connection_id=$1 AND external_scan_id=$2', [agentA, 'enrichment-pass-2']);
    assert.deepEqual(run, { new_posts: 0, updated_posts: 1, duplicates_skipped: 0 });
  });

  await t.test('same scan_id retry is idempotent and cannot use richer retry data to enrich', async () => {
    const url = 'https://facebook.com/demo/posts/1004';
    const first = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('idempotent-enrichment', [basePost(url)]) });
    const retry = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('idempotent-enrichment', [basePost(url, { title: 'Must not apply', summary: 'Must not apply' })]) });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), first.json());
    const { rows: [row] } = await pool.query('SELECT title,content FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE $2', [agentA, '%/demo/posts/1004']);
    assert.deepEqual(row, { title: null, content: null });
  });

  await t.test('duplicate URLs remain agent-isolated and duplicate errors explain malformed fields', async () => {
    const shared = 'https://facebook.com/shared/posts/555';
    const ra = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('shared-a', [basePost(shared)]) });
    const rb = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenB), payload: payload('shared-b', [basePost(shared, { summary: 'Agent B only' })]) });
    assert.equal(ra.statusCode, 200); assert.equal(rb.statusCode, 200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM facebook_posts WHERE agent_connection_id=ANY($1::uuid[]) AND normalized_url LIKE '%/shared/posts/555'", [[agentA, agentB]])).rows[0].n, 2);
    assert.equal((await pool.query("SELECT content FROM facebook_posts WHERE agent_connection_id=$1 AND normalized_url LIKE '%/shared/posts/555'", [agentB])).rows[0].content, 'Agent B only');

    const malformed = await app.inject({ method: 'POST', url: '/api/agent/results', headers: headers(tokenA), payload: payload('bad-schema', [basePost('https://facebook.com/demo/posts/999', { posted_at: 'yesterday', unexpected: true })]) });
    assert.equal(malformed.statusCode, 400);
    assert.ok(malformed.json().details.some((issue: { message: string }) => issue.message));
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/config', headers: headers('not-a-real-token-'.padEnd(44, 'x')) })).statusCode, 401);
  });

  await t.test('migration is repeatable and original Agent A/B state is preserved', async () => {
    await pool.query(await readFile(new URL('../migrations/002_post_metadata_enrichment.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/003_post_search_config_associations.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshotExistingAgents(), preservedBefore);
    const { rows } = await pool.query("SELECT name FROM schema_migrations WHERE name='001_initial.sql'");
    assert.equal(rows.length, 1);
  });

  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userA, userB]]);
  await app.close();
  await pool.end();
});
