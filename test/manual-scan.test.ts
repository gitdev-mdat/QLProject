import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { app } from '../src/server.js';
import { MANUAL_SCAN_DAILY_LIMIT, requestManualJob, supersedeQueuedJobs } from '../src/jobs.js';
import { planFromDescription } from '../src/search-plan.js';

/**
 * Natural-language profiles, edit supersession and customer-requested scans against the real queue, worker API and
 * public wake signal. Synthetic only: requires an isolated database without search profiles or active workers.
 * The worker here is a test double driven through the HTTP API; it is not a Muse run.
 */
const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const DESCRIPTION_1 = 'Các quán, nhà hàng F&B sắp khai trương hoặc tuyển dụng nhân viên cho quán sắp khai trương.';
const DESCRIPTION_2 = 'Khách sạn, homestay mới khai trương ở Đà Lạt';
const DESCRIPTION_3 = 'Spa mở chi nhánh mới';

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** What web/lib/server/profiles.ts does on a description-only save: a new version with phrases generated from it. */
async function saveDescription(profileId: string, userId: string, description: string, location = ''): Promise<number> {
  return tx(async client => {
    await client.query('SELECT 1 FROM agent_connections WHERE id = $1 AND user_id = $2 FOR UPDATE', [profileId, userId]);
    const { rows: [current] } = await client.query('SELECT coalesce(max(version), 0) AS v FROM scan_configs WHERE agent_connection_id = $1', [profileId]);
    const version = current.v + 1;
    await client.query(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id)
      VALUES ($1, $2, true, $3, 'description', $4, '["social.search"]', 10080, $5, $6)`, [profileId, version, JSON.stringify(planFromDescription(description).queries), location, description, userId]);
    await supersedeQueuedJobs(client, profileId, version);
    return version;
  });
}

const request = (profileId: string, userId: string) => tx(client => client.query('SELECT 1 FROM agent_connections WHERE id = $1 FOR UPDATE', [profileId]).then(() => requestManualJob(client, profileId, userId)));
const wake = async () => (await app.inject({ method: 'GET', url: '/api/public/worker-wake' })).json();
const claim = async (profileId: string) => (await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profileId } })).json();
const submit = (job: any, posts: unknown[]) => app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
  event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
  keywords_used: job.search.keywords, sources_used: job.search.sources, posts, stats: { total_found: posts.length }, errors: [] } });

test('natural-language intent reaches the job payload; edits supersede queued work; re-scans are deduplicated (synthetic)', async t => {
  const { rows: [existing] } = await pool.query(`SELECT (SELECT count(*)::int FROM agent_connections WHERE kind = 'search_profile') AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS workers`);
  if (existing.profiles || existing.workers) { t.skip('Requires an isolated DB with no search profiles or active workers.'); await app.close(); await pool.end(); return; }

  const users: string[] = [];
  let workerId = '';
  try {
    for (const name of ['NL scan User A', 'NL scan User B']) users.push((await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name])).rows[0].id);
    const [userA, userB] = users as [string, string];
    const profile = async (userId: string, name: string) => {
      const { rows: [row] } = await pool.query("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [userId, name]);
      return row.id as string;
    };
    const pa = await profile(userA, 'F&B');
    const pa2 = await profile(userA, 'Second');
    const pb = await profile(userB, 'B profile');
    workerId = (await pool.query(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes)
      VALUES ('Synthetic NL Worker', $1, 'active', '["social.search"]', 1, 30) RETURNING id`, [createHash('sha256').update(token).digest('hex')])).rows[0].id;

    await t.test('a description-only save stores generated phrases and no hidden region', async () => {
      assert.equal(await saveDescription(pa, userA, DESCRIPTION_1), 1);
      const { rows: [config] } = await pool.query('SELECT keywords, location, description, keywords_source FROM scan_configs WHERE agent_connection_id = $1 AND version = 1', [pa]);
      assert.deepEqual(config.keywords, planFromDescription(DESCRIPTION_1).queries);
      assert.equal(config.location, '');
      assert.equal(config.keywords_source, 'description');
      await saveDescription(pb, userB, 'Quán cafe sắp khai trương');
    });

    let firstJob = '';
    await t.test('"Tìm lại ngay" queues one job, repeats return it, another tenant cannot request it', async () => {
      const first = await request(pa, userA);
      assert.equal(first.outcome, 'queued');
      firstJob = (first as any).jobId;
      assert.deepEqual(await request(pa, userA), { outcome: 'existing', jobId: firstJob });
      assert.deepEqual(await Promise.all([request(pa, userA), request(pa, userA), request(pa, userA)]), Array(3).fill({ outcome: 'existing', jobId: firstJob }), 'concurrent clicks create no extra work');
      assert.deepEqual(await request(pa, userB), { outcome: 'not_found' }, 'User B cannot request a scan of User A’s profile');
      const { rows } = await pool.query("SELECT kind, configuration_version, requested_by_user_id FROM search_jobs WHERE search_profile_id = $1 AND status = 'pending'", [pa]);
      assert.deepEqual(rows, [{ kind: 'manual', configuration_version: 1, requested_by_user_id: userA }]);
    });

    let generation = '';
    await t.test('the wake signal reports the queued job as new eligible work', async () => {
      // Profile B has an unscanned routine slot too; scope everything below to profile A with scoped claims.
      const signal = await wake();
      assert.equal(signal.wake, true);
      generation = signal.generation;
    });

    await t.test('editing the description supersedes the queued job with one on the new version', async () => {
      assert.equal(await saveDescription(pa, userA, DESCRIPTION_2, 'Đà Lạt'), 2);
      const { rows } = await pool.query('SELECT id, kind, status, configuration_version, last_error FROM search_jobs WHERE search_profile_id = $1 ORDER BY created_at', [pa]);
      assert.equal(rows.length, 2);
      assert.deepEqual({ ...rows[0], id: undefined }, { id: undefined, kind: 'manual', status: 'cancelled', configuration_version: 1, last_error: 'superseded_by_edit' }, 'old queued job kept as history, not run');
      assert.deepEqual({ kind: rows[1].kind, status: rows[1].status, configuration_version: rows[1].configuration_version }, { kind: 'manual', status: 'pending', configuration_version: 2 });
      const signal = await wake();
      assert.equal(signal.wake, true);
      assert.notEqual(signal.generation, generation, 'the replacement job is a distinguishable wake generation');
    });

    let claimed: any;
    await t.test('the claimed payload carries the latest intent and its generated phrases, not the old keywords', async () => {
      const response = await claim(pa);
      assert.equal(response.jobs.length, 1);
      claimed = response.jobs[0];
      assert.equal(claimed.configuration_version, 2);
      assert.deepEqual(claimed.search.keywords, planFromDescription(DESCRIPTION_2).queries);
      assert.equal(claimed.search.location, 'Đà Lạt');
      assert.deepEqual(claimed.search.intent, { description: DESCRIPTION_2, keywords_source: 'description' });
      assert.ok(!claimed.search.keywords.some((keyword: string) => planFromDescription(DESCRIPTION_1).queries.includes(keyword)), 'stale F&B phrases are gone');
      assert.ok(!JSON.stringify(claimed).includes(userA), 'no customer identity in the job');
    });

    await t.test('an edit while the job runs leaves it on its version; its results never touch the newer config', async () => {
      assert.equal(await saveDescription(pa, userA, DESCRIPTION_3), 3);
      const { rows: [job] } = await pool.query('SELECT status, configuration_version FROM search_jobs WHERE id = $1', [claimed.job_id]);
      assert.deepEqual(job, { status: 'claimed', configuration_version: 2 });
      assert.deepEqual(await request(pa, userA), { outcome: 'existing', jobId: claimed.job_id }, 'a running scan is shown, not duplicated');
      const result = await submit(claimed, [{ url: 'https://www.facebook.com/synthetic.nl/posts/1', author: 'Synthetic Homestay', title: null, content: 'Homestay mới khai trương ở Đà Lạt (synthetic)', published_at: new Date().toISOString(), platform: 'facebook', collected_via: 'integration_test' }]);
      assert.equal(result.statusCode, 200, result.body);
      const { rows: [run] } = await pool.query('SELECT configuration_version, new_posts FROM scan_runs WHERE search_job_id = $1', [claimed.job_id]);
      assert.deepEqual(run, { configuration_version: 2, new_posts: 1 });
      const { rows: [provenance] } = await pool.query("SELECT configuration_version FROM facebook_post_search_configs WHERE agent_connection_id = $1 AND normalized_url LIKE '%synthetic.nl%'", [pa]);
      assert.equal(provenance.configuration_version, 2, 'the lead is attributed to the version that found it');
      const { rows: [latest] } = await pool.query('SELECT version, description FROM scan_configs WHERE agent_connection_id = $1 ORDER BY version DESC LIMIT 1', [pa]);
      assert.deepEqual(latest, { version: 3, description: DESCRIPTION_3 });
    });

    await t.test('a re-scan after an edit is allowed; the same configuration just scanned is cooled down', async () => {
      const next = await request(pa, userA);
      assert.equal(next.outcome, 'queued', 'version 3 has not been scanned yet');
      const response = await claim(pa);
      assert.equal(response.jobs[0].configuration_version, 3);
      assert.equal((await submit(response.jobs[0], [])).statusCode, 200);
      const cooled = await request(pa, userA);
      assert.equal(cooled.outcome, 'cooldown');
      assert.ok((cooled as any).retryAfterSeconds > 0 && (cooled as any).retryAfterSeconds <= 15 * 60);
    });

    await t.test('daily request limit and paused profiles create no work', async () => {
      await saveDescription(pa2, userA, 'Quán trà sữa sắp khai trương');
      for (let index = 0; index < MANUAL_SCAN_DAILY_LIMIT; index++) {
        await pool.query(`INSERT INTO search_jobs(search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind, requested_by_user_id, status, completed_at)
          VALUES ($1, 1, $2, now() - make_interval(mins => $3), '["social.search"]', 'manual', $4, 'completed', now() - interval '1 hour')`, [pa2, `synthetic-limit-${index}-${randomBytes(4).toString('hex')}`, 120 + index, userA]);
      }
      assert.deepEqual(await request(pa2, userA), { outcome: 'daily_limit' });
      await pool.query("INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description) SELECT agent_connection_id, version + 1, false, keywords, keywords_source, location, sources, frequency_minutes, description FROM scan_configs WHERE agent_connection_id = $1 AND version = 1", [pb]);
      assert.deepEqual(await request(pb, userB), { outcome: 'paused' });
    });

    await t.test('history is preserved: every version and job remains', async () => {
      const { rows: [counts] } = await pool.query(`SELECT (SELECT count(*)::int FROM scan_configs WHERE agent_connection_id = $1) AS versions,
        (SELECT count(*)::int FROM search_jobs WHERE search_profile_id = $1) AS jobs,
        (SELECT count(*)::int FROM scan_runs WHERE agent_connection_id = $1) AS runs`, [pa]);
      assert.deepEqual(counts, { versions: 3, jobs: 3, runs: 2 });
    });
  } finally {
    if (users.length) {
      await pool.query('DELETE FROM search_job_attempts WHERE job_id IN (SELECT j.id FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = ANY($1::uuid[]))', [users]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    }
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id = $1', [workerId]);
    await app.close(); await pool.end();
  }
});
