import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './db.js';
import { enqueueDueJobs, enqueueInitialJob, releaseWorkerJobs } from './jobs.js';

const [command, ...args] = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const help = `Muse Local Bridge admin CLI (runs locally and connects directly to PostgreSQL)

  npm run cli -- migrate
  npm run cli -- create-user --name "Test User A"
  npm run cli -- create-agent --user <USER_ID> --name "Muse A"
  npm run cli -- set-config --agent <AGENT_ID> --keywords "quán cafe sắp khai trương" --location "TP.HCM" [--frequency 30]
  npm run cli -- scans [--agent <AGENT_ID>] [--limit 20]
  npm run cli -- posts --user <USER_ID> [--limit 50]
  npm run cli -- status [--agent <AGENT_ID>]
  npm run cli -- rotate --agent <AGENT_ID>
  npm run cli -- revoke --agent <AGENT_ID>
  npm run seed

Shared Muse workers (customers own search profiles; workers only execute jobs):
  npm run cli -- create-profile --user <USER_ID> [--name "Tìm kiếm của tôi"]   (then set-config --agent <PROFILE_ID> ...)
  npm run cli -- create-worker --name "Muse Worker 01" [--sources "social.search"] [--max-jobs 2] [--lease 20]
  npm run cli -- workers
  npm run cli -- worker-set --worker <WORKER_ID> [--status active|draining|paused|unavailable] [--sources "a|b"] [--max-jobs N]
  npm run cli -- release-jobs --worker <WORKER_ID>     (worker must not be active; returns its claimed jobs to the queue)
  npm run cli -- jobs [--status <STATUS>] [--worker <WORKER_ID>] [--limit 50]
  npm run cli -- job-attempts --job <JOB_ID>
  npm run cli -- unblock-jobs --profile <PROFILE_ID>  (after a worker regains source access)
  npm run cli -- enqueue-jobs
  npm run cli -- rotate-worker --worker <WORKER_ID>
  npm run cli -- revoke-worker --worker <WORKER_ID>

Seed creates two test users/agents with the POC filters and prints each new credential once.
`;

async function migrate() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const client = await pool.connect();
  try {
    for (const name of ['001_initial.sql', '002_post_metadata_enrichment.sql', '003_post_search_config_associations.sql', '004_web_sessions.sql', '005_lead_workflow.sql', '006_shared_workers.sql', '007_worker_handoffs.sql', '008_group_requests.sql', '009_search_profile_details.sql', '010_user_accounts.sql', '011_initial_search_jobs.sql', '012_natural_language_search.sql', '013_account_lead_monitoring.sql', '014_admin_user_deletion_audit.sql', '015_initial_discovery_followup.sql', '016_add_summary_vi_to_facebook_posts.sql', '017_push_notifications.sql', '018_account_notifications.sql', '019_customer_feedback.sql', '020_login_events.sql', '021_lead_distribution.sql', '022_landing_preview.sql', '023_landing_showcase_pins.sql']) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
      if (applied.rowCount) continue;
      const sql = await readFile(resolve('migrations', name), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    }
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
async function createUser(name: string) {
  const { rows: [user] } = await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id, display_name, created_at', [name]);
  console.log(JSON.stringify(user, null, 2)); return user;
}
async function createAgent(userId: string, name: string) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const { rows: [agent] } = await pool.query('INSERT INTO agent_connections(user_id,name,credential_hash) VALUES ($1,$2,$3) RETURNING id,user_id,name,status,created_at', [userId, name, hash]);
  console.log(JSON.stringify({ ...agent, credential: token, warning: 'Credential is shown once. Save it in Muse secure configuration; it cannot be retrieved later.' }, null, 2)); return agent;
}
async function setConfig(agentId: string, keywords: string[], location: string, frequency: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [agent] } = await client.query("SELECT id FROM agent_connections WHERE id=$1 AND status='active' FOR UPDATE", [agentId]);
    if (!agent) throw new Error('Active agent not found');
    const { rows: [current] } = await client.query('SELECT version FROM scan_configs WHERE agent_connection_id=$1 ORDER BY version DESC LIMIT 1', [agentId]);
    const version = (current?.version ?? 0) + 1;
    const { rows: [config] } = await client.query('INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes) VALUES($1,$2,true,$3,$4,$5,$6) RETURNING *', [agentId, version, JSON.stringify(keywords), location, JSON.stringify(['social.search']), frequency]);
    // CLI-created search profiles need the same first-scan job as profiles enabled through web onboarding.
    await enqueueInitialJob(client, agentId);
    await client.query('COMMIT'); console.log(JSON.stringify(config, null, 2));
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function main() {
  switch (command) {
    case 'migrate': return migrate();
    case 'create-user': { const name = arg('--name'); if (!name) throw new Error('Provide --name'); return createUser(name); }
    case 'create-agent': { const user = arg('--user'); const name = arg('--name'); if (!user || !name) throw new Error('Provide --user and --name'); return createAgent(user, name); }
    case 'set-config': { const agent = arg('--agent'); const keywords = arg('--keywords'); const location = arg('--location'); const frequency = Number(arg('--frequency', '30')); if (!agent || !keywords || !location) throw new Error('Provide --agent, --keywords, and --location'); if (!Number.isInteger(frequency) || frequency < 1 || frequency > 10080) throw new Error('--frequency must be an integer from 1 to 10080'); return setConfig(agent, keywords.split('|').map(s => s.trim()).filter(Boolean), location, frequency); }
    case 'scans': { const agent = arg('--agent'); const limit = Math.min(100, Math.max(1, Number(arg('--limit', '20')))); const { rows } = await pool.query(`SELECT sr.external_scan_id, ac.name AS agent, u.display_name AS user, sr.configuration_version, sr.scanned_at, sr.received_at, sr.total_found, sr.received_posts, sr.new_posts, sr.updated_posts, sr.duplicates_skipped, sr.status FROM scan_runs sr JOIN agent_connections ac ON ac.id=sr.agent_connection_id JOIN users u ON u.id=ac.user_id WHERE ($1::uuid IS NULL OR ac.id=$1) ORDER BY received_at DESC LIMIT $2`, [agent ?? null, limit]); console.log(JSON.stringify(rows, null, 2)); return; }
    case 'posts': { const user = arg('--user'); if (!user) throw new Error('Provide --user <USER_ID>'); const limit = Math.min(500, Math.max(1, Number(arg('--limit', '50')))); const { rows } = await pool.query(`SELECT p.*, ac.name AS agent_name FROM facebook_posts p JOIN agent_connections ac ON ac.id=p.agent_connection_id WHERE ac.user_id=$1 ORDER BY p.published_at DESC NULLS LAST, p.id ASC LIMIT $2`, [user, limit]); console.log(JSON.stringify(rows, null, 2)); return; }
    case 'status': { const agent = arg('--agent'); const { rows } = await pool.query(`SELECT ac.id,ac.name,ac.status,u.display_name AS user,ac.last_seen_at,(SELECT count(*)::int FROM facebook_posts WHERE agent_connection_id=ac.id) AS total_posts,(SELECT received_at FROM scan_runs WHERE agent_connection_id=ac.id ORDER BY received_at DESC LIMIT 1) AS last_scan,(SELECT version FROM scan_configs WHERE agent_connection_id=ac.id ORDER BY version DESC LIMIT 1) AS config_version FROM agent_connections ac JOIN users u ON u.id=ac.user_id WHERE ($1::uuid IS NULL OR ac.id=$1) ORDER BY u.created_at,ac.created_at`, [agent ?? null]); console.log(JSON.stringify(rows, null, 2)); return; }
    case 'rotate': { const agent = arg('--agent'); if (!agent) throw new Error('Provide --agent <AGENT_ID>'); const token = randomBytes(32).toString('base64url'); const hash = createHash('sha256').update(token).digest('hex'); const { rows: [updated] } = await pool.query("UPDATE agent_connections SET credential_hash=$2 WHERE id=$1 AND status='active' RETURNING id,user_id,name,status", [agent, hash]); if (!updated) throw new Error('Active agent not found; no credential was changed'); console.log(JSON.stringify({ ...updated, credential: token, warning: 'Credential shown once. Save it in Muse private credential storage; it cannot be retrieved later.' }, null, 2)); return; }
    case 'revoke': { const agent = arg('--agent'); if (!agent) throw new Error('Provide --agent <AGENT_ID>'); const { rowCount } = await pool.query("UPDATE agent_connections SET status='revoked' WHERE id=$1 AND status='active'", [agent]); console.log(rowCount ? 'Credential revoked.' : 'No active agent matched.'); return; }
    case 'create-profile': {
      const user = arg('--user'); const name = arg('--name', 'Tìm kiếm của tôi');
      if (!user) throw new Error('Provide --user <USER_ID>');
      const { rows: [profile] } = await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,$2,'search_profile') RETURNING id,user_id,name,kind,status,created_at", [user, name]);
      console.log(JSON.stringify(profile, null, 2)); return;
    }
    case 'create-worker': {
      const name = arg('--name'); if (!name) throw new Error('Provide --name');
      const sources = arg('--sources', 'social.search')!.split('|').map(x => x.trim()).filter(Boolean);
      const token = randomBytes(32).toString('base64url');
      const { rows: [worker] } = await pool.query('INSERT INTO muse_workers(name,credential_hash,authorized_sources,max_jobs_per_claim,lease_minutes) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,status,authorized_sources,max_jobs_per_claim,lease_minutes,created_at',
        [name, createHash('sha256').update(token).digest('hex'), JSON.stringify(sources), Number(arg('--max-jobs', '2')), Number(arg('--lease', '20'))]);
      console.log(JSON.stringify({ ...worker, credential: token, warning: 'Credential is shown once. The worker starts paused; activate it with worker-set --status active.' }, null, 2)); return;
    }
    case 'workers': {
      const { rows } = await pool.query(`SELECT w.id, w.name, w.status, w.credential_status, w.authorized_sources, w.max_jobs_per_claim, w.lease_minutes, w.last_seen_at, w.last_success_at,
          (SELECT count(*)::int FROM search_jobs WHERE claimed_by_worker_id = w.id AND status = 'claimed' AND lease_expires_at > now()) AS claimed_jobs,
          (SELECT count(*)::int FROM search_job_attempts WHERE worker_id = w.id AND outcome = 'completed') AS completed_attempts,
          (SELECT count(*)::int FROM search_job_attempts WHERE worker_id = w.id AND outcome IN ('failed','needs_reauthorization','expired')) AS failed_attempts,
          (SELECT jsonb_agg(x) FROM (SELECT a.claimed_at, a.outcome, a.error FROM search_job_attempts a WHERE a.worker_id = w.id AND a.outcome IN ('failed','needs_reauthorization','expired') ORDER BY a.claimed_at DESC LIMIT 3) x) AS recent_failures
        FROM muse_workers w ORDER BY w.created_at`);
      const { rows: [queue] } = await pool.query(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at > now())::int AS claimed,
          count(*) FILTER (WHERE status IN ('blocked', 'needs_reauthorization'))::int AS blocked, min(scheduled_for) FILTER (WHERE status = 'pending') AS oldest_pending_slot FROM search_jobs`);
      console.log(JSON.stringify({ workers: rows, queue }, null, 2)); return;
    }
    case 'worker-set': {
      const worker = arg('--worker'); if (!worker) throw new Error('Provide --worker <WORKER_ID>');
      const status = arg('--status'); const sources = arg('--sources'); const maxJobs = arg('--max-jobs');
      if (status && !['active', 'draining', 'paused', 'unavailable'].includes(status)) throw new Error('--status must be active, draining, paused or unavailable');
      const { rows: [updated] } = await pool.query(`UPDATE muse_workers SET status_changed_at = CASE WHEN $2::text IS NOT NULL AND $2 <> status THEN now() ELSE status_changed_at END, status = coalesce($2, status), authorized_sources = coalesce($3::jsonb, authorized_sources),
          max_jobs_per_claim = coalesce($4::int, max_jobs_per_claim) WHERE id = $1 RETURNING id, name, status, authorized_sources, max_jobs_per_claim`,
      [worker, status ?? null, sources ? JSON.stringify(sources.split('|').map(x => x.trim()).filter(Boolean)) : null, maxJobs ?? null]);
      if (!updated) throw new Error('Worker not found');
      console.log(JSON.stringify(updated, null, 2)); return;
    }
    case 'release-jobs': {
      const worker = arg('--worker'); if (!worker) throw new Error('Provide --worker <WORKER_ID>');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [w] } = await client.query('SELECT status FROM muse_workers WHERE id = $1 FOR UPDATE', [worker]);
        if (!w) throw new Error('Worker not found');
        if (w.status === 'active') throw new Error('Pause, drain or mark the worker unavailable before releasing its jobs');
        const released = await releaseWorkerJobs(client, worker);
        await client.query('COMMIT'); console.log(JSON.stringify({ released }, null, 2));
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      return;
    }
    case 'jobs': {
      const limit = Math.min(500, Math.max(1, Number(arg('--limit', '50'))));
      const { rows } = await pool.query(`SELECT j.id, j.status, j.scheduled_for, j.available_at, j.attempts, j.max_attempts, j.last_error, j.lease_expires_at, j.scan_id,
          u.display_name AS customer, ac.name AS profile, w.name AS worker, j.required_sources
        FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id JOIN users u ON u.id = ac.user_id LEFT JOIN muse_workers w ON w.id = j.claimed_by_worker_id
        WHERE ($1::text IS NULL OR j.status = $1) AND ($2::uuid IS NULL OR j.claimed_by_worker_id = $2) ORDER BY j.scheduled_for DESC, j.created_at DESC LIMIT $3`,
      [arg('--status') ?? null, arg('--worker') ?? null, limit]);
      console.log(JSON.stringify(rows, null, 2)); return;
    }
    case 'job-attempts': {
      const job = arg('--job'); if (!job) throw new Error('Provide --job <JOB_ID>');
      const { rows } = await pool.query('SELECT a.attempt_no, w.name AS worker, a.claimed_at, a.lease_expires_at, a.finished_at, a.outcome, a.error FROM search_job_attempts a JOIN muse_workers w ON w.id = a.worker_id WHERE a.job_id = $1 ORDER BY a.attempt_no', [job]);
      console.log(JSON.stringify(rows, null, 2)); return;
    }
    case 'unblock-jobs': {
      const profile = arg('--profile'); if (!profile) throw new Error('Provide --profile <PROFILE_ID>');
      const { rowCount } = await pool.query(`UPDATE search_jobs SET status = 'pending', claimed_by_worker_id = NULL, current_attempt_id = NULL, attempts = 0, last_error = NULL, available_at = now(), updated_at = now()
        WHERE search_profile_id = $1 AND status IN ('blocked', 'needs_reauthorization')`, [profile]);
      console.log(JSON.stringify({ unblocked: rowCount }, null, 2)); return;
    }
    case 'enqueue-jobs': {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const created = await enqueueDueJobs(client); await client.query('COMMIT'); console.log(JSON.stringify({ created }, null, 2)); }
      catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      return;
    }
    case 'rotate-worker': {
      const worker = arg('--worker'); if (!worker) throw new Error('Provide --worker <WORKER_ID>');
      const token = randomBytes(32).toString('base64url');
      const { rows: [updated] } = await pool.query("UPDATE muse_workers SET credential_hash = $2, credential_status = 'active' WHERE id = $1 RETURNING id, name, status", [worker, createHash('sha256').update(token).digest('hex')]);
      if (!updated) throw new Error('Worker not found; no credential was changed');
      console.log(JSON.stringify({ ...updated, credential: token, warning: 'Credential shown once.' }, null, 2)); return;
    }
    case 'revoke-worker': {
      const worker = arg('--worker'); if (!worker) throw new Error('Provide --worker <WORKER_ID>');
      const { rowCount } = await pool.query("UPDATE muse_workers SET credential_status = 'revoked', status = 'unavailable', status_changed_at = now() WHERE id = $1 AND credential_status = 'active'", [worker]);
      console.log(rowCount ? 'Worker credential revoked and marked unavailable. Run release-jobs to requeue its claimed jobs.' : 'No active worker credential matched.'); return;
    }
    case 'seed': {
      const fixtures = [
        { user: 'Test User A', agent: 'Muse A', keywords: ['quán cafe sắp khai trương'], location: 'TP.HCM' },
        { user: 'Test User B', agent: 'Muse B', keywords: ['đại lý phân phối mỹ phẩm'], location: 'Hà Nội' }
      ];
      for (const f of fixtures) { const u = await createUser(f.user); const a = await createAgent(u.id, f.agent); await setConfig(a.id, f.keywords, f.location, 30); }
      return;
    }
    default: console.log(help);
  }
}
main().catch(e => { console.error(`Admin command failed: ${e instanceof Error ? e.message : 'unknown error'}`); process.exitCode = 1; }).finally(() => pool.end());
