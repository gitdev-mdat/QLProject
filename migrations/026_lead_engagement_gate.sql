-- Start engagement accounting at deployment for existing profiles. Historical workflow states and source opens are
-- deliberately not imported into this cohort. New profiles get the same baseline when their row is created.
ALTER TABLE lead_distribution_settings
  ADD COLUMN IF NOT EXISTS policy_activated_at timestamptz NOT NULL DEFAULT now();

-- Cycle identity is the real logical scan or the unique review event that crossed the threshold, never a page read.
CREATE INDEX IF NOT EXISTS scan_runs_profile_policy_idx
  ON scan_runs(agent_connection_id, received_at) WHERE status IN ('success', 'partial');

-- Minimal evidence only: one qualifying interaction per delivered Facebook permalink and profile.
CREATE TABLE IF NOT EXISTS lead_engagement_reviews (
  search_profile_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
  normalized_url text NOT NULL CHECK (length(normalized_url) BETWEEN 1 AND 2048),
  interaction text NOT NULL CHECK (interaction IN ('source_open', 'manual_status')),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_profile_id, normalized_url),
  UNIQUE (search_profile_id, post_id)
);
CREATE INDEX IF NOT EXISTS lead_engagement_reviews_profile_idx
  ON lead_engagement_reviews(search_profile_id, reviewed_at DESC);

ALTER TABLE lead_engagement_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE lead_engagement_reviews FROM PUBLIC;
ALTER TABLE lead_distribution_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_distribution_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_lead_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE lead_distribution_settings, lead_distribution_cycles, profile_lead_deliveries FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE lead_engagement_reviews FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE lead_distribution_settings, lead_distribution_cycles, profile_lead_deliveries FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

-- Direct creation paths (including onboarding and future backend scripts) activate policy at profile creation.
CREATE OR REPLACE FUNCTION qlead_activate_profile_engagement_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'search_profile' THEN
    INSERT INTO lead_distribution_settings(search_profile_id, policy_activated_at)
    VALUES (NEW.id, now()) ON CONFLICT (search_profile_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_connections_engagement_policy ON agent_connections;
CREATE TRIGGER agent_connections_engagement_policy
AFTER INSERT ON agent_connections
FOR EACH ROW EXECUTE FUNCTION qlead_activate_profile_engagement_policy();

-- Use the same per-account permalink ownership rule as lead distribution. This index also bounds the anti-duplicate
-- lookup used when multiple profile result transactions arrive close together.
CREATE INDEX IF NOT EXISTS profile_lead_deliveries_post_state_idx
  ON profile_lead_deliveries(post_id, state) WHERE state = 'delivered';
