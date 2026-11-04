import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { claimJobs } from '../src/jobs.js';

const tokenHash = () => randomBytes(32).toString('hex');

test('Admin account deletion is isolated, atomic, audited and claim-safe', async t => {
  let databaseName: string;
  try { databaseName = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name; }
  catch { t.skip('PostgreSQL is unavailable; run this on an isolated deletion test database.'); await pool.end(); return; }
  if (databaseName === 'muse_bridge' || !databaseName.toLowerCase().includes('test')) {
    t.skip(`Requires an explicitly isolated *test* database; configured database is ${databaseName}.`);
    await pool.end(); return;
  }
  const { rows: [existing] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM agent_connections) AS profiles,
    (SELECT count(*)::int FROM muse_workers WHERE status = 'active') AS active_workers`);
  if (existing.users || existing.profiles || existing.active_workers) {
    t.skip('Requires an empty isolated test database, with no customer profiles or active workers.');
    await pool.end(); return;
  }
  const { deleteUserAccount: deleteAccountWithTx, previewUserDeletion: previewWithTx, UserDeletionError, userDeletionHttpStatus } = await import('../src/user-deletion.js');

  const oldAdmins = process.env.QLEAD_ADMIN_USER_IDS;
  const actor = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic deletion Admin') RETURNING id")).rows[0]!.id as string;
  const target = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic deletion target') RETURNING id")).rows[0]!.id as string;
  const other = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic deletion target') RETURNING id")).rows[0]!.id as string;
  const protectedAdmin = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic protected Admin') RETURNING id")).rows[0]!.id as string;
  let failureTarget = '';
  let emptyTarget = '';
  process.env.QLEAD_ADMIN_USER_IDS = `${actor},${protectedAdmin}`;
  const withTx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  };
  const previewUserDeletion = (id: string) => previewWithTx(id, withTx);
  const deleteUserAccount = (actorId: string, targetId: string, confirmationId: string) =>
    deleteAccountWithTx(actorId, targetId, confirmationId, new Set([actor.toLowerCase(), protectedAdmin.toLowerCase()]), withTx);
  const schemaMissingTx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => fn({
    query: async () => ({ rows: [{ audit_table: null }], rowCount: 1 }),
  } as unknown as PoolClient);
  let workerId = '';
  try {
    const profile = async (userId: string, name: string) => {
      const id = (await pool.query("INSERT INTO agent_connections(user_id,name,kind,credential_hash) VALUES ($1,$2,'search_profile',NULL) RETURNING id", [userId, name])).rows[0]!.id as string;
      await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,keywords_source,location,sources,frequency_minutes,description)
        VALUES ($1,1,true,'["synthetic"]','manual','Synthetic area','["social.search"]',10080,'Synthetic test')`, [id]);
      return id;
    };
    const profileA = await profile(target, 'Synthetic target profile A');
    const profileB = await profile(target, 'Synthetic target profile B');
    await pool.query("INSERT INTO agent_connections(user_id,name,credential_hash) VALUES ($1,'Synthetic legacy Muse credential',$2)", [target, tokenHash()]);
    const otherProfile = await profile(other, 'Synthetic other profile');
    const { rows: [post] } = await pool.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,content,author)
      VALUES ($1,'https://facebook.com/synthetic/target','https://facebook.com/synthetic/target','Synthetic lead','Synthetic author') RETURNING id`, [profileA]);
    await pool.query("INSERT INTO lead_states(user_id,post_id,status) VALUES ($1,$2,'seen')", [target, post.id]);
    await pool.query("INSERT INTO lead_notes(user_id,post_id,body) VALUES ($1,$2,'Synthetic note')", [target, post.id]);
    await pool.query(`INSERT INTO scan_runs(agent_connection_id,external_scan_id,configuration_version,scanned_at,total_found,received_posts,new_posts,duplicates_skipped,status)
      VALUES ($1,'synthetic-complete',1,now(),1,1,1,0,'success')`, [profileA]);
    await pool.query("INSERT INTO user_accounts(user_id,email,password_hash) VALUES ($1,'deletion-target@example.invalid','scrypt$synthetic')", [target]);
    await pool.query("INSERT INTO web_sessions(user_id,token_hash,created_via,expires_at) VALUES ($1,$2,'password',now()+interval '1 day')", [target, tokenHash()]);
    const { rows: [worker] } = await pool.query(`INSERT INTO muse_workers(name,credential_hash,status,authorized_sources,max_jobs_per_claim,lease_minutes)
      VALUES ('Synthetic deletion worker',$1,'active','["social.search"]',1,30) RETURNING id`, [tokenHash()]);
    workerId = worker.id;
    emptyTarget = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic no-profile target') RETURNING id")).rows[0]!.id as string;
    const emptyImpact = await deleteUserAccount(actor, emptyTarget, emptyTarget);
    assert.equal(emptyImpact.profileCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [emptyTarget])).rowCount, 0);
    const { rows: [job] } = await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources,status,completed_at)
      VALUES ($1,1,'synthetic-completed-job',now(),'["social.search"]','completed',now()) RETURNING id`, [profileA]);
    await pool.query(`INSERT INTO search_job_attempts(job_id,worker_id,attempt_no,lease_expires_at,finished_at,outcome)
      VALUES ($1,$2,1,now(),now(),'completed')`, [job.id, workerId]);

    const counts = await previewUserDeletion(target);
    assert.equal(counts.profileCount, 2);
    assert.equal(counts.legacyConnectionCount, 1);
    assert.equal(counts.museCredentialCount, 1);
    assert.equal(counts.jobCount, 1);
    assert.equal(counts.scanCount, 1);
    assert.equal(counts.customerLeadCount, 1);
    assert.equal(counts.noteCount, 1);
    assert.equal(counts.sessionCount, 1);
    assert.equal(counts.loginCredentialCount, 1);
    assert.deepEqual(counts.activeJobs, []);

    await assert.rejects(deleteUserAccount(actor, target, other), (e: unknown) => e instanceof UserDeletionError && e.code === 'stale_confirmation');
    await assert.rejects(deleteUserAccount(actor, actor, actor), (e: unknown) => e instanceof UserDeletionError && e.code === 'self_delete');
    await assert.rejects(deleteUserAccount(actor, protectedAdmin, protectedAdmin), (e: unknown) => e instanceof UserDeletionError && e.code === 'protected_admin');
    await assert.rejects(deleteAccountWithTx(actor, target, target, new Set([actor.toLowerCase(), protectedAdmin.toLowerCase()]), schemaMissingTx),
      (e: unknown) => e instanceof UserDeletionError && e.code === 'schema_not_ready');
    assert.equal(userDeletionHttpStatus('schema_not_ready'), 503);
    assert.equal(userDeletionHttpStatus('active_jobs'), 409);
    assert.equal(userDeletionHttpStatus('stale_confirmation'), 400);

    // A live lease blocks removal and the response contains only the needed profile/lease blocker details.
    const { rows: [pending] } = await pool.query(`INSERT INTO search_jobs(search_profile_id,configuration_version,scan_id,scheduled_for,required_sources)
      VALUES ($1,1,'synthetic-active-job',now(),'["social.search"]') RETURNING id`, [profileB]);
    const { rows: [attempt] } = await pool.query(`INSERT INTO search_job_attempts(job_id,worker_id,attempt_no,lease_expires_at)
      VALUES ($1,$2,1,now()+interval '10 minutes') RETURNING id,lease_expires_at`, [pending.id, workerId]);
    await pool.query("UPDATE search_jobs SET status='claimed',claimed_by_worker_id=$2,current_attempt_id=$3,lease_expires_at=$4 WHERE id=$1", [pending.id, workerId, attempt.id, attempt.lease_expires_at]);
    await assert.rejects(deleteUserAccount(actor, target, target), (e: unknown) => e instanceof UserDeletionError && e.code === 'active_jobs' && e.impact?.activeJobs.length === 1);
    await pool.query("UPDATE search_jobs SET status='pending',claimed_by_worker_id=NULL,current_attempt_id=NULL,lease_expires_at=NULL WHERE id=$1", [pending.id]);
    await pool.query("UPDATE search_job_attempts SET outcome='released',finished_at=now() WHERE id=$1", [attempt.id]);

    // A user-row lock causes the existing claim query (FOR UPDATE OF j,u SKIP LOCKED) to skip this tenant.
    const lockClient = await pool.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target]);
      const claimClient = await pool.connect();
      try {
        await claimClient.query('BEGIN');
        const claimed = await claimJobs(claimClient, { id: workerId, name: 'Synthetic deletion worker', status: 'active', authorized_sources: ['social.search'], max_jobs_per_claim: 1, lease_minutes: 30 }, 1, profileB);
        assert.equal(claimed.length, 0);
        await claimClient.query('ROLLBACK');
      } finally { claimClient.release(); }
      await lockClient.query('ROLLBACK');
    } finally { lockClient.release(); }

    const deletedImpact = await deleteUserAccount(actor, target, target);
    assert.equal(deletedImpact.profileCount, 2);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [target])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM agent_connections WHERE user_id=$1', [target])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM web_sessions WHERE user_id=$1', [target])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM user_accounts WHERE user_id=$1', [target])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM facebook_posts WHERE id=$1', [post.id])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM scan_runs WHERE external_scan_id='synthetic-complete'")).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM search_job_attempts WHERE job_id=$1", [job.id])).rowCount, 0);
    assert.equal((await pool.query("SELECT result FROM admin_user_deletion_audit WHERE target_user_id=$1 ORDER BY occurred_at DESC LIMIT 1", [target])).rows[0]!.result, 'deleted');
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [other])).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM agent_connections WHERE id=$1', [otherProfile])).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM muse_workers WHERE id=$1', [workerId])).rowCount, 1);
    await assert.rejects(deleteUserAccount(actor, target, target), (e: unknown) => e instanceof UserDeletionError && e.code === 'not_found');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [other])).rows[0]!.n, 1);

    // A failing cascade rolls back; trigger is test-only and removed in finally.
    failureTarget = (await pool.query("INSERT INTO users(display_name) VALUES ('Synthetic rollback target') RETURNING id")).rows[0]!.id as string;
    await pool.query(`CREATE OR REPLACE FUNCTION test_reject_synthetic_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.id = '${failureTarget}'::uuid THEN RAISE EXCEPTION 'synthetic deletion failure'; END IF; RETURN OLD; END $$`);
    await pool.query('CREATE TRIGGER test_reject_synthetic_user_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION test_reject_synthetic_user_delete()');
    await assert.rejects(deleteUserAccount(actor, failureTarget, failureTarget));
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id=$1', [failureTarget])).rowCount, 1);
    assert.equal((await pool.query("SELECT result FROM admin_user_deletion_audit WHERE target_user_id=$1 ORDER BY occurred_at DESC LIMIT 1", [failureTarget])).rows[0]!.result, 'failed');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS test_reject_synthetic_user_delete ON users').catch(() => undefined);
    await pool.query('DROP FUNCTION IF EXISTS test_reject_synthetic_user_delete()').catch(() => undefined);
    await pool.query('DELETE FROM admin_user_deletion_audit WHERE target_user_id = ANY($1::uuid[])', [[actor, target, other, protectedAdmin, failureTarget, emptyTarget].filter(Boolean)]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[actor, target, other, protectedAdmin, failureTarget, emptyTarget].filter(Boolean)]).catch(() => undefined);
    if (workerId) await pool.query('DELETE FROM muse_workers WHERE id=$1', [workerId]).catch(() => undefined);
    if (oldAdmins === undefined) delete process.env.QLEAD_ADMIN_USER_IDS; else process.env.QLEAD_ADMIN_USER_IDS = oldAdmins;
    await pool.end();
  }
});
