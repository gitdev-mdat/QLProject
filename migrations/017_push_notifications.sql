-- Private Web Push state. QLead authenticates API access with web_sessions and uses
-- a privileged server-side Postgres connection; no Data API role needs direct table access.
CREATE TABLE IF NOT EXISTS push_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  test_last_sent_at timestamptz,
  last_new_lead_push_at timestamptz,
  dispatch_lease_token uuid,
  dispatch_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  endpoint_hash char(64) NOT NULL UNIQUE,
  subscription_ciphertext text NOT NULL,
  platform text NOT NULL DEFAULT 'other' CHECK (platform IN ('ios', 'android', 'desktop', 'other')),
  standalone boolean NOT NULL DEFAULT false,
  origin text NOT NULL,
  expiration_time timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id uuid NOT NULL UNIQUE REFERENCES scan_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_profile_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  lead_count integer NOT NULL CHECK (lead_count > 0),
  lead_id uuid REFERENCES facebook_posts(id) ON DELETE SET NULL,
  preference_revision bigint NOT NULL CHECK (preference_revision > 0),
  monitoring_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_notification_outbox_user_idx ON push_notification_outbox(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS push_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES push_notification_outbox(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES push_subscriptions(id) ON DELETE SET NULL,
  session_id uuid REFERENCES web_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'suppressed', 'expired', 'dead')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  push_status_code smallint,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (outbox_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS push_notification_deliveries_due_idx
  ON push_notification_deliveries(status, available_at, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS push_notification_deliveries_outbox_idx
  ON push_notification_deliveries(outbox_id, status);

-- These tables are accessed only through authenticated Next.js server routes and the worker result transaction.
-- RLS with no user JWT policies prevents accidental exposure through Supabase's Data API.
ALTER TABLE push_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notification_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE push_notification_preferences, push_subscriptions, push_notification_outbox, push_notification_deliveries FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE push_notification_preferences, push_subscriptions, push_notification_outbox, push_notification_deliveries FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE push_notification_preferences, push_subscriptions, push_notification_outbox, push_notification_deliveries FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON TABLE push_notification_preferences, push_subscriptions, push_notification_outbox, push_notification_deliveries FROM service_role';
  END IF;
END $$;
