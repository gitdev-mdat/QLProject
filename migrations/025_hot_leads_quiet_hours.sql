-- Additive Hot Lead provenance and distinct outbox kind; preserve existing deliveries and statuses.
ALTER TABLE profile_lead_deliveries
  ADD COLUMN IF NOT EXISTS hot_at_discovery boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hot_reason_vi text,
  ADD COLUMN IF NOT EXISTS hot_evidence text,
  ADD COLUMN IF NOT EXISTS hot_assessed_at timestamptz,
  ADD COLUMN IF NOT EXISTS hot_expires_at timestamptz;
ALTER TABLE profile_lead_deliveries DROP CONSTRAINT IF EXISTS profile_lead_deliveries_hot_shape_check;
ALTER TABLE profile_lead_deliveries ADD CONSTRAINT profile_lead_deliveries_hot_shape_check CHECK (
  (hot_at_discovery AND hot_reason_vi IS NOT NULL AND hot_evidence IS NOT NULL AND hot_assessed_at IS NOT NULL AND hot_expires_at IS NOT NULL)
  OR (NOT hot_at_discovery AND hot_reason_vi IS NULL AND hot_evidence IS NULL AND hot_expires_at IS NULL)
);
CREATE INDEX IF NOT EXISTS profile_lead_deliveries_current_hot_idx
  ON profile_lead_deliveries(search_profile_id, hot_expires_at DESC) WHERE state = 'delivered' AND hot_at_discovery;

ALTER TABLE push_notification_outbox ADD COLUMN IF NOT EXISTS notification_kind text NOT NULL DEFAULT 'new_leads';
ALTER TABLE push_notification_outbox ADD COLUMN IF NOT EXISTS notification_key text;
UPDATE push_notification_outbox SET notification_kind = 'account_status' WHERE account_notification_id IS NOT NULL;
ALTER TABLE push_notification_outbox DROP CONSTRAINT IF EXISTS push_notification_outbox_kind_check;
ALTER TABLE push_notification_outbox ADD CONSTRAINT push_notification_outbox_kind_check
  CHECK (notification_kind IN ('new_leads', 'hot_lead', 'account_status'));
CREATE UNIQUE INDEX IF NOT EXISTS push_notification_outbox_hot_lead_once_idx
  ON push_notification_outbox(user_id, notification_key) WHERE notification_kind = 'hot_lead' AND notification_key IS NOT NULL;
ALTER TABLE push_notification_outbox DROP CONSTRAINT IF EXISTS push_notification_outbox_scan_run_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS push_notification_outbox_scan_run_once_idx
  ON push_notification_outbox(scan_run_id) WHERE notification_kind = 'new_leads' AND scan_run_id IS NOT NULL;

-- Add a distinct workflow value without rewriting or reinterpreting any historical not_fit row.
ALTER TABLE lead_states DROP CONSTRAINT IF EXISTS lead_states_status_check;
ALTER TABLE lead_states ADD CONSTRAINT lead_states_status_check
  CHECK (status IN ('new', 'seen', 'contacted', 'interested', 'not_fit', 'not_interested'));
