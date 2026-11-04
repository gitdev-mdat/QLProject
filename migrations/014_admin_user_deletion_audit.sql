-- Minimal deletion audit: retain immutable account and actor IDs, never names, email addresses or credentials.
-- The target ID is intentionally not a foreign key so the event survives permanent account deletion.
CREATE TABLE IF NOT EXISTS admin_user_deletion_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('deleted', 'blocked_active_jobs', 'rejected_self', 'rejected_admin', 'not_found', 'failed'))
);
CREATE INDEX IF NOT EXISTS admin_user_deletion_audit_recent_idx
  ON admin_user_deletion_audit(occurred_at DESC);
