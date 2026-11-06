-- Customer-visible account notifications (in-app notification center) and an explicit customer-facing suspension reason.
-- Additive only: no existing row, column or constraint loses data.
--
-- users.lead_monitoring_reason stays the Admin-only internal note (migration 013 told Admins "chỉ quản trị viên thấy").
-- It is never copied into the new public column or into notifications; old suspensions therefore have no public reason.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_monitoring_public_reason text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_lead_monitoring_public_reason_check;
ALTER TABLE users ADD CONSTRAINT users_lead_monitoring_public_reason_check
  CHECK (lead_monitoring_public_reason IS NULL OR length(lead_monitoring_public_reason) BETWEEN 1 AND 500);

-- One row per real Admin state change. event_key = '<kind>:<user id>:<users.lead_monitoring_changed_at>' is written in the
-- same transaction (under the users row lock) as the state change, so a retried or concurrent request cannot add a second row.
CREATE TABLE IF NOT EXISTS account_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('lead_monitoring_suspended', 'lead_monitoring_resumed')),
  -- Exactly the text an Admin chose to publish for this event; NULL when none was given (the UI then shows no reason at all).
  public_reason text CHECK (public_reason IS NULL OR (kind = 'lead_monitoring_suspended' AND length(public_reason) BETWEEN 1 AND 500)),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_notifications_user_idx ON account_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_notifications_unread_idx ON account_notifications(user_id) WHERE read_at IS NULL;

-- The existing Web Push outbox also carries account notifications, so there is one delivery pipeline (retries, expiry,
-- per-device rows, origin rules). New-lead rows keep exactly their previous shape; an account row has no scan and no leads.
ALTER TABLE push_notification_outbox ALTER COLUMN scan_run_id DROP NOT NULL;
ALTER TABLE push_notification_outbox ALTER COLUMN search_profile_id DROP NOT NULL;
ALTER TABLE push_notification_outbox ADD COLUMN IF NOT EXISTS account_notification_id uuid UNIQUE REFERENCES account_notifications(id) ON DELETE CASCADE;
ALTER TABLE push_notification_outbox DROP CONSTRAINT IF EXISTS push_notification_outbox_lead_count_check;
ALTER TABLE push_notification_outbox DROP CONSTRAINT IF EXISTS push_notification_outbox_shape_check;
ALTER TABLE push_notification_outbox ADD CONSTRAINT push_notification_outbox_shape_check CHECK (
  (account_notification_id IS NULL AND scan_run_id IS NOT NULL AND search_profile_id IS NOT NULL AND lead_count > 0)
  OR (account_notification_id IS NOT NULL AND scan_run_id IS NULL AND search_profile_id IS NULL AND lead_count = 0 AND lead_id IS NULL)
);

-- Same protection as the push tables: only the authenticated Next.js server (privileged connection) reads these rows.
ALTER TABLE account_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE account_notifications FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON TABLE account_notifications FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE account_notifications FROM authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE 'REVOKE ALL ON TABLE account_notifications FROM service_role'; END IF;
END $$;
