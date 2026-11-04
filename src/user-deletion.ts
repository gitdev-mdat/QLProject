import type { PoolClient } from 'pg';

export type UserDeletionImpact = {
  targetUserId: string;
  profileCount: number;
  legacyConnectionCount: number;
  museCredentialCount: number;
  searchConfigCount: number;
  jobCount: number;
  attemptCount: number;
  scanCount: number;
  customerLeadCount: number;
  leadStatusCount: number;
  noteCount: number;
  sessionCount: number;
  loginCredentialCount: number;
  groupRequestCount: number;
  activeJobs: Array<{ profileName: string; leaseExpiresAt: string }>;
};

export class UserDeletionError extends Error {
  constructor(readonly code: 'not_found' | 'stale_confirmation' | 'self_delete' | 'protected_admin' | 'active_jobs' | 'schema_not_ready', message: string, readonly impact?: UserDeletionImpact) {
    super(message);
  }
}

export function userDeletionHttpStatus(code: UserDeletionError['code']): number {
  if (code === 'schema_not_ready') return 503;
  if (code === 'active_jobs') return 409;
  if (code === 'not_found') return 404;
  if (code === 'stale_confirmation') return 400;
  return 403;
}

export type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

type CountRow = {
  profile_count: number; legacy_connection_count: number; muse_credential_count: number; search_config_count: number; job_count: number; attempt_count: number;
  scan_count: number; customer_lead_count: number; lead_status_count: number; note_count: number;
  session_count: number; login_credential_count: number; group_request_count: number;
};

async function impactFor(client: PoolClient, userId: string, lockActiveJobs = false): Promise<UserDeletionImpact> {
  const { rows: [counts] } = await client.query<CountRow>(`SELECT
      (SELECT count(*)::int FROM agent_connections ac WHERE ac.user_id = $1 AND ac.kind = 'search_profile') AS profile_count,
      (SELECT count(*)::int FROM agent_connections ac WHERE ac.user_id = $1 AND ac.kind = 'legacy_agent') AS legacy_connection_count,
      (SELECT count(*)::int FROM agent_connections ac WHERE ac.user_id = $1 AND ac.credential_hash IS NOT NULL) AS muse_credential_count,
      (SELECT count(*)::int FROM scan_configs sc JOIN agent_connections ac ON ac.id = sc.agent_connection_id WHERE ac.user_id = $1) AS search_config_count,
      (SELECT count(*)::int FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = $1) AS job_count,
      (SELECT count(*)::int FROM search_job_attempts a JOIN search_jobs j ON j.id = a.job_id JOIN agent_connections ac ON ac.id = j.search_profile_id WHERE ac.user_id = $1) AS attempt_count,
      (SELECT count(*)::int FROM scan_runs sr JOIN agent_connections ac ON ac.id = sr.agent_connection_id WHERE ac.user_id = $1) AS scan_count,
      (SELECT count(*)::int FROM facebook_posts fp JOIN agent_connections ac ON ac.id = fp.agent_connection_id WHERE ac.user_id = $1) AS customer_lead_count,
      (SELECT count(*)::int FROM lead_states ls WHERE ls.user_id = $1) AS lead_status_count,
      (SELECT count(*)::int FROM lead_notes ln WHERE ln.user_id = $1) AS note_count,
      (SELECT count(*)::int FROM web_sessions ws WHERE ws.user_id = $1) AS session_count,
      (SELECT count(*)::int FROM user_accounts ua WHERE ua.user_id = $1) AS login_credential_count,
      (SELECT count(*)::int FROM facebook_group_requests gr WHERE gr.user_id = $1) AS group_request_count`, [userId]);
  if (!counts) throw new Error('Deletion impact query returned no count row.');
  const { rows: activeJobs } = await client.query<{ profile_name: string; lease_expires_at: Date }>(`SELECT ac.name AS profile_name, j.lease_expires_at
    FROM search_jobs j JOIN agent_connections ac ON ac.id = j.search_profile_id
    WHERE ac.user_id = $1 AND j.status = 'claimed' AND j.lease_expires_at >= now()
    ORDER BY j.lease_expires_at, ac.name ${lockActiveJobs ? 'FOR UPDATE OF j' : ''}`, [userId]);
  return {
    targetUserId: userId,
    profileCount: counts.profile_count, legacyConnectionCount: counts.legacy_connection_count, museCredentialCount: counts.muse_credential_count,
    searchConfigCount: counts.search_config_count, jobCount: counts.job_count, attemptCount: counts.attempt_count,
    scanCount: counts.scan_count, customerLeadCount: counts.customer_lead_count, leadStatusCount: counts.lead_status_count,
    noteCount: counts.note_count, sessionCount: counts.session_count, loginCredentialCount: counts.login_credential_count,
    groupRequestCount: counts.group_request_count,
    activeJobs: activeJobs.map(j => ({ profileName: j.profile_name, leaseExpiresAt: j.lease_expires_at.toISOString() })),
  };
}

export async function previewUserDeletion(userId: string, withTx: TransactionRunner): Promise<UserDeletionImpact> {
  return withTx(async client => {
    const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!exists.rowCount) throw new UserDeletionError('not_found', 'Account was not found.');
    return impactFor(client, userId);
  });
}

async function audit(client: PoolClient, actorId: string, targetId: string, result: string) {
  await client.query('INSERT INTO admin_user_deletion_audit(actor_user_id, target_user_id, result) VALUES ($1, $2, $3)', [actorId, targetId, result]);
}

/** Caller supplies the same transaction runner used by the web application's PostgreSQL pool. */
export async function deleteUserAccount(actorId: string, targetId: string, confirmedTargetId: string, protectedAdminIds: ReadonlySet<string>, withTx: TransactionRunner): Promise<UserDeletionImpact> {
  if (confirmedTargetId !== targetId) throw new UserDeletionError('stale_confirmation', 'The confirmation does not match the selected account.');
  if (actorId === targetId) {
    await withTx(client => audit(client, actorId, targetId, 'rejected_self'));
    throw new UserDeletionError('self_delete', 'You cannot delete your own Admin account here.');
  }
  try {
    const outcome = await withTx(async client => {
      const auditSchema = await client.query<{ audit_table: string | null }>("SELECT to_regclass('public.admin_user_deletion_audit')::text AS audit_table");
      if (!auditSchema.rows[0]?.audit_table) return { kind: 'schema_not_ready' as const };
      const { rows: [target] } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetId]);
      if (!target) {
        await audit(client, actorId, targetId, 'not_found');
        return { kind: 'not_found' as const };
      }
      if (protectedAdminIds.has(targetId.toLowerCase())) {
        await audit(client, actorId, targetId, 'rejected_admin');
        return { kind: 'protected_admin' as const };
      }
      const impact = await impactFor(client, targetId, true);
      if (impact.activeJobs.length) {
        await audit(client, actorId, targetId, 'blocked_active_jobs');
        return { kind: 'active_jobs' as const, impact };
      }
      await audit(client, actorId, targetId, 'deleted');
      const deletion = await client.query('DELETE FROM users WHERE id = $1', [targetId]);
      if (deletion.rowCount !== 1) throw new Error('locked user row disappeared during deletion');
      return { kind: 'deleted' as const, impact };
    });
    if (outcome.kind === 'deleted') return outcome.impact;
    if (outcome.kind === 'active_jobs') throw new UserDeletionError('active_jobs', 'Account has jobs with active worker leases.', outcome.impact);
    if (outcome.kind === 'protected_admin') throw new UserDeletionError('protected_admin', 'Admin accounts cannot be deleted through customer management.');
    if (outcome.kind === 'schema_not_ready') throw new UserDeletionError('schema_not_ready', 'Account deletion is unavailable until the database is updated.');
    throw new UserDeletionError('not_found', 'Account was not found.');
  } catch (error) {
    if (error instanceof UserDeletionError) throw error;
    // The destructive transaction rolled back. Record only outcome and immutable IDs in a fresh transaction.
    await withTx(client => audit(client, actorId, targetId, 'failed')).catch(() => undefined);
    throw error;
  }
}
