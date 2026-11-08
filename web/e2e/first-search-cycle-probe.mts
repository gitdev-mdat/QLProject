// Probe (no browser): does an early, empty delivery cycle hold back the first search's results until the next cycle?
// Run from the repo root on the isolated DB only:
//   $env:DATABASE_URL='postgres://muse:<pw>@127.0.0.1:55432/muse_bridge_test_firstux'; npx tsx web/e2e/first-search-cycle-probe.mts
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db.js';
import { app } from '../../src/server.js';
import { enqueueInitialJob } from '../../src/jobs.js';
import { distributeProfileLeads } from '../../src/lead-distribution.js';

if (!/muse_bridge_test_firstux/.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing: DATABASE_URL must point at muse_bridge_test_firstux.'); process.exit(2); }
const RUN = randomBytes(4).toString('hex');
const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
const tx = async <T>(work: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const out = await work(client); await client.query('COMMIT'); return out; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

await q("UPDATE search_jobs SET status = 'cancelled', last_error = 'e2e_isolation', updated_at = now() WHERE status IN ('pending', 'blocked')");
await q(`INSERT INTO muse_workers(name, credential_hash, status, authorized_sources, max_jobs_per_claim, lease_minutes, connection_verified_at) VALUES ($1, $2, 'active', '["social.search"]', 1, 30, now())`, [`probe ${RUN}`, createHash('sha256').update(token).digest('hex')]);
const [{ id: userId }] = await q("INSERT INTO users(display_name) VALUES ($1) RETURNING id", [`probe ${RUN}`]);
const [{ id: profile }] = await q("INSERT INTO agent_connections(user_id, name, kind) VALUES ($1, 'Probe', 'search_profile') RETURNING id", [userId]);
await q(`INSERT INTO scan_configs(agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description)
  VALUES ($1, 1, true, '["quán cà phê sắp khai trương"]', 'description', '', '["social.search"]', 30, 'probe')`, [profile]);
await tx(client => enqueueInitialJob(client, profile));

const early = await tx(client => distributeProfileLeads(client, userId, profile));
console.log('1. user opens Today while the first search waits →', early);

const claim = await app.inject({ method: 'POST', url: '/api/worker/jobs/claim', headers: auth, payload: { max_jobs: 1, search_profile_id: profile } });
const job = claim.json().jobs[0];
const submit = await app.inject({ method: 'POST', url: `/api/worker/jobs/${job.job_id}/results`, headers: auth, payload: {
  event: 'facebook_scan_completed', source: 'muse', configuration_version: job.configuration_version, scan_id: job.scan_id, scanned_at: new Date().toISOString(),
  keywords_used: job.search.keywords, sources_used: job.search.sources,
  posts: Array.from({ length: 12 }, (_, i) => ({ url: `https://www.facebook.com/probe/${RUN}/${i}`, author: `Quán ${i}`, content: `Quán ${i} sắp khai trương, cần máy pha cà phê.`, published_at: new Date(Date.now() - 3600_000).toISOString(), collected_via: 'controlled_fixture' })),
  stats: { total_found: 30 }, errors: [] } });
console.log('2. first search submits 12 posts →', submit.statusCode);

const after = await tx(client => distributeProfileLeads(client, userId, profile));
console.log('3. user opens the list right after →', after);
const states = await q("SELECT state, count(*)::int FROM profile_lead_deliveries WHERE search_profile_id = $1 GROUP BY state", [profile]);
console.log('4. ledger →', states);
const blocked = (after?.delivered ?? 0) === 0;
console.log(blocked ? `RESULT: BLOCKED — results wait for the next cycle (${after?.nextCycleAt})` : 'RESULT: delivered in the same cycle');
await app.close(); await pool.end();
