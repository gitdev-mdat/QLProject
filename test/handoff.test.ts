import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { buildSummary, cancelHandoff, confirmWithoutWork, cutover, displayState, failHandoff, HandoffError, prepareHandoff, refreshHandoff, startDrain } from '../src/handoff.js';

/**
 * Admin worker handoff on synthetic fixtures. Run against an isolated database:
 *   DATABASE_URL=postgres://muse:CHANGE_ME@127.0.0.1:55432/muse_bridge_test npm test
 * It refuses to run where real search profiles or active workers exist.
 */
const token = () => randomBytes(32).toString('base64url');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const t01 = token(); const t02 = token();
const ids = { admin: '', userA: '', userB: '', profileA: '', profileB: '', w01: '', w02: '', legacyUser: '', legacyAgent: '' };
const claim = (t: string) => app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth(t), payload: {} });
const submit = (t: string, job: any, urls: string[]) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth(t), payload: {
  event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, attempt_no: job.attempt_no, scanned_at: '2026-11-02T00:05:00+07:00',
  posts: urls.map(url => ({ url, author: 'Synthetic', content: 'Synthetic', published_at: '2026-11-01T20:00:00+07:00' })), stats: { total_found: urls.length }, errors: [] } });
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const worker = async (id: string) => (await pool.query('SELECT status, last_seen_at, last_claim_at, connection_verified_at, status_changed_at, credential_status FROM muse_workers WHERE id = $1', [id])).rows[0];
const handoff = async (id: string) => (await pool.query('SELECT * FROM worker_handoffs WHERE id = $1', [id])).rows[0];
const visible = async (userId: string) => (await pool.query('SELECT fp.normalized_url FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1 ORDER BY 1', [userId])).rows.map(r => r.normalized_url);
const history = async () => (await pool.query("SELECT id, agent_connection_id, external_scan_id, status, new_posts, received_at FROM scan_runs WHERE agent_connection_id = ANY($1::uuid[]) ORDER BY id", [[ids.profileA, ids.profileB]])).rows;
let slotShift = 0;
const nextSlot = () => pool.query(`UPDATE search_jobs SET scheduled_for = scheduled_for - make_interval(days => $2) WHERE search_profile_id = ANY($1::uuid[]) AND status IN ('completed', 'failed') AND scheduled_for > now() - interval '1 hour'`, [[ids.profileA, ids.profileB], ++slotShift]);

test('admin worker handoff: Muse 01 -> Muse 02 and back (synthetic)', async t => {
  const { rows: [existing] } = await pool.query(`SELECT (SELECT count(*) FROM agent_connections WHERE kind = 'search_profile')::int AS profiles, (SELECT count(*) FROM muse_workers WHERE status = 'active')::int AS workers`).catch(() => ({ rows: [{ profiles: -1, workers: -1 }] }));
  if (existing.profiles !== 0 || existing.workers !== 0) { t.skip('Needs an isolated database with migration 007 and no real search profiles or active workers'); await app.close(); await pool.end(); return; }
  try {
    for (const [k, name] of [['admin', 'Synthetic Admin'], ['userA', 'Synthetic Handoff A'], ['userB', 'Synthetic Handoff B'], ['legacyUser', 'Synthetic Legacy']] as const) ids[k] = (await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    ids.legacyAgent = (await pool.query("INSERT INTO agent_connections(user_id, name, credential_hash) VALUES ($1, 'Synthetic legacy Muse', $2) RETURNING id", [ids.legacyUser, hash(token())])).rows[0].id;
    await pool.query(`INSERT INTO scan_runs(agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, duplicates_skipped) SELECT $1, 'legacy-1', 1, now(), 1, 1, 1, 0`, [ids.legacyAgent]).catch(() => undefined);
    for (const [k, user] of [['profileA', ids.userA], ['profileB', ids.userB]] as const) ids[k] = (await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Tìm kiếm của tôi', 'search_profile') RETURNING id", [user])).rows[0].id;
    await pool.query(`INSERT INTO scan_configs(agent_connection_id, version, keywords, location, sources, frequency_minutes) VALUES ($1, 1, '["quán ăn sắp khai trương"]', 'Miền Nam', '["social.search"]', 30), ($2, 1, '["khách sạn sắp khai trương"]', 'Hà Nội', '["social.search"]', 30)`, [ids.profileA, ids.profileB]);
    ids.w01 = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status) VALUES ('Synthetic Muse 01', $1, 'active') RETURNING id", [hash(t01)])).rows[0].id;
    ids.w02 = (await pool.query("INSERT INTO muse_workers(name, credential_hash, status) VALUES ('Synthetic Muse 02', $1, 'paused') RETURNING id", [hash(t02)])).rows[0].id;
    const legacyBefore = (await pool.query('SELECT * FROM scan_runs WHERE agent_connection_id = $1', [ids.legacyAgent])).rows;

    await t.test('1. one-time connection check records evidence and claims nothing', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/worker/status', headers: auth(t02) });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().status, 'paused'); assert.equal(r.json().queue.claimable_jobs, 0);
      const w = await worker(ids.w02);
      assert.ok(w.connection_verified_at); assert.equal(w.last_claim_at, null);
      assert.equal(displayState(w).state, 'ready', 'paused + verified = ready standby');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM search_job_attempts WHERE worker_id = $1', [ids.w02])).rows[0].n, 0);
    });

    let jobA: any; let jobB: any; let completedBefore: any[] = [];
    await t.test('2. Muse 01 works; Muse 02 standby makes no requests and nothing changes for it', async () => {
      const before = await worker(ids.w02);
      const { jobs } = (await claim(t01)).json();
      assert.equal(jobs.length, 2);
      for (const j of jobs) assert.equal((await submit(t01, j, [`https://facebook.com/synthetic/${j.search.location === 'Hà Nội' ? 'b' : 'a'}/1`])).statusCode, 200);
      const after = await worker(ids.w02);
      assert.deepEqual(after, before, 'QLead never contacts or changes the standby worker');
      assert.equal(displayState(after).standbyContact, false);
      completedBefore = await history();
      await nextSlot();
      // Muse 01 claims the next slot: job A is in flight when Admin starts the handoff.
      const next = (await claim(t01)).json().jobs;
      jobA = next.find((j: any) => j.search.location === 'Miền Nam'); jobB = next.find((j: any) => j.search.location === 'Hà Nội');
      assert.equal((await submit(t01, jobB, [])).statusCode, 200);
    });

    let h1 = '';
    await t.test('3. prepare shows the complete operational context without changing workers', async () => {
      h1 = await tx(c => prepareHandoff(c, { sourceId: ids.w01, destinationId: ids.w02, userId: ids.admin }));
      const row = await handoff(h1);
      assert.equal(row.status, 'preparing');
      const s = row.prepared_summary;
      assert.equal(s.jobs.in_flight_source, 1); assert.equal(s.in_flight_source[0].job_id, jobA.job_id);
      assert.equal(s.jobs.completed_by_source, 3); assert.equal(s.profiles.active, 2);
      assert.ok(s.checks.find((c: any) => c.key === 'source_in_flight' && !c.ok));
      assert.equal((await worker(ids.w01)).status, 'active');
      assert.equal((await worker(ids.w02)).status, 'paused');
      await assert.rejects(tx(c => prepareHandoff(c, { sourceId: ids.w01, destinationId: ids.w02 })), (e: HandoffError) => e.code === 'handoff_in_progress');
      assert.ok(!JSON.stringify(s).includes('Synthetic Handoff'), 'summary has no customer names');
    });

    await t.test('4. draining: Muse 01 claims nothing new but may finish its in-flight job', async () => {
      await tx(c => startDrain(c, h1));
      assert.equal((await worker(ids.w01)).status, 'draining');
      await nextSlot();
      assert.equal((await claim(t01)).json().jobs.length, 0);
    });

    await t.test('7. normal cutover waits for valid in-flight work', async () => {
      await assert.rejects(tx(c => cutover(c, h1, { emergency: false })), (e: HandoffError) => e.code === 'source_has_in_flight_jobs');
      assert.equal((await handoff(h1)).status, 'draining');
    });

    await t.test('7b/8/9. emergency cutover releases work; stale Muse 01 result rejected; Muse 02 re-runs it', async () => {
      const { released } = await tx(c => cutover(c, h1, { emergency: true }));
      assert.equal(released, 1);
      assert.equal((await worker(ids.w01)).status, 'unavailable'); assert.equal((await worker(ids.w02)).status, 'active');
      const row = await handoff(h1);
      assert.equal(row.status, 'awaiting_worker_start', 'database switch alone is not success');
      assert.equal(row.cutover_summary.jobs.released_waiting, 1);
      assert.equal(await tx(c => refreshHandoff(c, h1)), 'awaiting_worker_start');
      assert.equal((await submit(t01, jobA, ['https://facebook.com/synthetic/a/stale'])).json().error, 'lease_lost');
      const status = await app.inject({ method: 'GET', url: '/api/worker/status', headers: auth(t02) });
      assert.equal(status.json().handoff.role, 'destination'); assert.ok(status.json().queue.claimable_jobs >= 1);
      assert.equal(await tx(c => refreshHandoff(c, h1)), 'verifying');
      const { jobs } = (await claim(t02)).json();
      const again = jobs.find((j: any) => j.job_id === jobA.job_id);
      assert.ok(again, 'interrupted job A goes to Muse 02 with the same job identity');
      assert.equal(again.scan_id, jobA.scan_id); assert.equal(again.attempt_no, 2);
      for (const j of jobs) assert.equal((await submit(t02, j, j.job_id === jobA.job_id ? ['https://facebook.com/synthetic/a/2'] : [])).statusCode, 200);
      assert.equal(await tx(c => refreshHandoff(c, h1)), 'completed');
      const done = await handoff(h1);
      assert.ok(done.destination_first_contact_at && done.destination_first_claim_at && done.destination_first_success_at);
      assert.deepEqual(done.events.map((e: any) => e.type), ['prepared', 'drain_started', 'cutover', 'destination_contacted', 'destination_completed_job']);
    });

    await t.test('5/6/10/11/12. history intact, no duplicates, tenants isolated', async () => {
      const now = await history();
      for (const run of completedBefore) assert.deepEqual(now.find(r => r.id === run.id), run);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM scan_runs WHERE search_job_id = $1', [jobA.job_id])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM facebook_posts WHERE normalized_url LIKE '%/synthetic/a/stale'")).rows[0].n, 0);
      const a = await visible(ids.userA); const b = await visible(ids.userB);
      assert.ok(a.every(u => u.includes('/synthetic/a/'))); assert.ok(b.every(u => u.includes('/synthetic/b/')));
      assert.deepEqual(a, ['https://facebook.com/synthetic/a/1', 'https://facebook.com/synthetic/a/2']);
    });

    let h2 = '';
    await t.test('14. switching back uses the same service; normal mode with nothing in flight', async () => {
      await pool.query("UPDATE muse_workers SET status = 'paused', status_changed_at = now() WHERE id = $1", [ids.w01]); // Admin restored capacity on Muse 01
      h2 = await tx(c => prepareHandoff(c, { sourceId: ids.w02, destinationId: ids.w01, userId: ids.admin }));
      await tx(c => startDrain(c, h2));
      await tx(c => cutover(c, h2, { emergency: false }));
      assert.equal((await worker(ids.w02)).status, 'paused'); assert.equal((await worker(ids.w01)).status, 'active');
      assert.equal((await handoff(h2)).mode, 'normal');
      await nextSlot();
      const { jobs } = (await claim(t01)).json();
      for (const j of jobs) await submit(t01, j, []);
      assert.equal(await tx(c => refreshHandoff(c, h2)), 'completed');
    });

    await t.test('standby polling by a paused worker is detected and gets no work', async () => {
      await new Promise(r => setTimeout(r, 20));
      assert.equal((await claim(t02)).json().jobs.length, 0);
      assert.equal(displayState(await worker(ids.w02)).standbyContact, true);
    });

    await t.test('15. destination never starts: handoff stays awaiting, then Admin marks it failed', async () => {
      const h3 = await tx(c => prepareHandoff(c, { sourceId: ids.w01, destinationId: ids.w02 }));
      await tx(c => cutover(c, h3, { emergency: false }));
      await pool.query("UPDATE worker_handoffs SET cutover_at = now() + interval '1 second' WHERE id = $1", [h3]); // the earlier standby claim predates cutover
      assert.equal(await tx(c => refreshHandoff(c, h3)), 'awaiting_worker_start');
      await assert.rejects(tx(c => confirmWithoutWork(c, h3)), (e: HandoffError) => e.code === 'invalid_state');
      await tx(c => failHandoff(c, h3, 'Muse 02 không khởi động'));
      assert.equal((await handoff(h3)).status, 'failed');
      // Recovery is another handoff with the same service.
      const h4 = await tx(c => prepareHandoff(c, { sourceId: ids.w02, destinationId: ids.w01 }));
      await tx(c => cancelHandoff(c, h4));
      assert.equal((await handoff(h4)).status, 'cancelled');
    });

    await t.test('cancel during drain restores the source', async () => {
      await pool.query("UPDATE muse_workers SET status = 'active' WHERE id = $1", [ids.w01]);
      await pool.query("UPDATE muse_workers SET status = 'paused' WHERE id = $1", [ids.w02]);
      const h = await tx(c => prepareHandoff(c, { sourceId: ids.w01, destinationId: ids.w02 }));
      await tx(c => startDrain(c, h));
      await tx(c => cancelHandoff(c, h));
      assert.equal((await worker(ids.w01)).status, 'active');
    });

    await t.test('revoked destination credential blocks preparation', async () => {
      await pool.query("UPDATE muse_workers SET credential_status = 'revoked' WHERE id = $1", [ids.w02]);
      await assert.rejects(tx(c => prepareHandoff(c, { sourceId: ids.w01, destinationId: ids.w02 })), (e: HandoffError) => e.code === 'precheck_failed');
      await pool.query("UPDATE muse_workers SET credential_status = 'active' WHERE id = $1", [ids.w02]);
      const s = await tx(c => buildSummary(c, ids.w01, ids.w02));
      assert.equal(s.checks.find(c => c.key === 'destination_credential')!.ok, true);
    });

    await t.test('18. legacy agents unaffected', async () => {
      assert.deepEqual((await pool.query('SELECT * FROM scan_runs WHERE agent_connection_id = $1', [ids.legacyAgent])).rows, legacyBefore);
      assert.equal((await pool.query('SELECT kind FROM agent_connections WHERE id = $1', [ids.legacyAgent])).rows[0].kind, 'legacy_agent');
    });
  } finally {
    await pool.query('DELETE FROM worker_handoffs WHERE source_worker_id = ANY($1::uuid[]) OR destination_worker_id = ANY($1::uuid[])', [[ids.w01, ids.w02].filter(Boolean)]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.entries(ids).filter(([k, v]) => v && ['admin', 'userA', 'userB', 'legacyUser'].includes(k)).map(([, v]) => v)]);
    await pool.query('DELETE FROM muse_workers WHERE id = ANY($1::uuid[])', [[ids.w01, ids.w02].filter(Boolean)]);
    await app.close(); await pool.end();
  }
});
