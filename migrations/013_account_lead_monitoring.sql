-- Account-level lead monitoring suspension. Additive only: existing users default to ACTIVE and all queue/history
-- rows stay in place. The suspended timestamp/actor retain the most recent suspension audit after reactivation.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lead_monitoring_status text NOT NULL DEFAULT 'active'
    CHECK (lead_monitoring_status IN ('active', 'suspended')),
  ADD COLUMN IF NOT EXISTS lead_monitoring_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lead_monitoring_changed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_monitoring_suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS lead_monitoring_suspended_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_monitoring_reason text;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_lead_monitoring_reason_check;
ALTER TABLE users ADD CONSTRAINT users_lead_monitoring_reason_check
  CHECK (lead_monitoring_reason IS NULL OR length(lead_monitoring_reason) <= 1000);

CREATE INDEX IF NOT EXISTS users_lead_monitoring_status_idx ON users(lead_monitoring_status);
